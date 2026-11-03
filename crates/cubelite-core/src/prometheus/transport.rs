//! Reaching Prometheus: the API server's service proxy for in-cluster
//! endpoints (a port-forward when the proxy is forbidden or unavailable),
//! HTTPS for external ones (spec §3, §6).

use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};

use futures::future::join_all;
use k8s_openapi::api::core::v1::Service;
use kube::api::ListParams;
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    azure, error_reason, metrics_queries, parse_series, sparkline_queries, unwrap_data, Chart,
    ChartData, MetricsRequest, MetricsResult, PromAuth, PromEndpoint, PromError, PromTarget,
    Sparklines, SPARKLINE_RANGE, SPARKLINE_STEP,
};
use crate::integration::{self, open_service_tunnel, service_host, ServiceTunnel, TunnelError};

enum Route {
    /// `/api/v1/namespaces/{ns}/services/{scheme}:{svc}:{port}/proxy` on the API server.
    Proxy { client: Client, base: String },
    /// Direct HTTP: external, or through a port-forward tunnel.
    Http {
        http: reqwest::Client,
        base: String,
        auth: Option<String>,
        _tunnel: Option<ServiceTunnel>,
    },
}

/// An open connection to a Prometheus endpoint.
pub struct PromConnection {
    route: Route,
}

impl std::fmt::Debug for PromConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let base = match &self.route {
            Route::Proxy { base, .. } | Route::Http { base, .. } => base,
        };
        f.debug_struct("PromConnection")
            .field("base", base)
            .finish_non_exhaustive()
    }
}

/// Server facts for Preferences → Test connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromInfo {
    /// `version` from build info (`unknown` for services without it).
    pub version: String,
    /// cAdvisor series exist (CPU and memory charts).
    pub cadvisor: bool,
    /// kube-state-metrics series exist (requests, limits, restarts).
    pub kube_state_metrics: bool,
    /// Values of the `cluster` label (to pick one in a shared workspace).
    pub clusters: Vec<String>,
}

/// A Prometheus service found in the cluster.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedPrometheus {
    /// Namespace.
    pub namespace: String,
    /// Service name.
    pub name: String,
    /// HTTP port.
    pub port: u16,
    /// Whether the port speaks HTTPS.
    pub https: bool,
}

/// The API server path proxying to a service port.
pub fn proxy_base(namespace: &str, service: &str, port: u16, https: bool) -> String {
    format!(
        "/api/v1/namespaces/{namespace}/services/{}:{service}:{port}/proxy",
        if https { "https" } else { "http" }
    )
}

fn tunnel_error(e: TunnelError) -> PromError {
    match e {
        TunnelError::Config(t) => PromError::Config(t),
        TunnelError::Connect(t) => PromError::Connect(t),
    }
}

/// Opens a connection to `endpoint`. In-cluster endpoints need `kube`.
///
/// Credentials go only over HTTPS; Azure tokens only to Azure Monitor hosts.
pub async fn connect(
    kube: Option<Client>,
    endpoint: &PromEndpoint,
    auth: &PromAuth,
) -> Result<PromConnection, PromError> {
    match &endpoint.target {
        PromTarget::External { url } => {
            let parsed = integration::check_external_url(url, *auth != PromAuth::None)
                .map_err(PromError::Config)?;
            let header = match auth {
                PromAuth::AzureCli => {
                    if !azure::is_azure_monitor_url(&parsed) {
                        return Err(PromError::Config(
                            "Azure CLI sign-in works only with https://…prometheus.monitor.azure.com endpoints"
                                .to_string(),
                        ));
                    }
                    Some(format!("Bearer {}", azure::token().await?))
                }
                other => other.header(),
            };
            let http = integration::http_builder(endpoint.skip_tls_verify)
                .build()
                .map_err(|e| PromError::Connect(e.to_string()))?;
            Ok(PromConnection {
                route: Route::Http {
                    http,
                    base: parsed.as_str().trim_end_matches('/').to_string(),
                    auth: header,
                    _tunnel: None,
                },
            })
        }
        PromTarget::InCluster {
            namespace,
            service,
            port,
            https,
        } => {
            if *auth != PromAuth::None {
                return Err(PromError::Config(
                    "In-cluster Prometheus is reached with your cluster credentials; choose No authentication"
                        .to_string(),
                ));
            }
            let client =
                kube.ok_or_else(|| PromError::Config("No cluster connection".to_string()))?;
            let proxy = PromConnection {
                route: Route::Proxy {
                    client: client.clone(),
                    base: proxy_base(namespace, service, *port, *https),
                },
            };
            match proxy.get("/api/v1/status/buildinfo").await {
                // Forbidden (no `services/proxy` RBAC) or unavailable (no
                // endpoints, TLS to the pod): try a port-forward instead.
                Err(PromError::Http {
                    status: 403 | 502 | 503,
                    ..
                }) => {}
                // Reachable — even an older Prometheus without build info.
                Ok(_) | Err(PromError::Http { status: 404, .. }) => return Ok(proxy),
                Err(other) => return Err(other),
            }
            let tunnel = open_service_tunnel(&client, namespace, service, *port)
                .await
                .map_err(tunnel_error)?;
            let host = service_host(namespace, service);
            let http = integration::http_builder(endpoint.skip_tls_verify)
                .no_proxy()
                .resolve(&host, SocketAddr::from(([127, 0, 0, 1], tunnel.local_port)))
                .build()
                .map_err(|e| PromError::Connect(e.to_string()))?;
            let scheme = if *https { "https" } else { "http" };
            Ok(PromConnection {
                route: Route::Http {
                    http,
                    base: format!("{scheme}://{host}:{}", tunnel.local_port),
                    auth: None,
                    _tunnel: Some(tunnel),
                },
            })
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn encode(pairs: &[(&str, String)]) -> String {
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        ser.append_pair(k, v);
    }
    ser.finish()
}

impl PromConnection {
    /// GET `path` (from `/api/v1/…`), parsed as JSON.
    async fn get(&self, path: &str) -> Result<Value, PromError> {
        let (status, body) = match &self.route {
            Route::Proxy { client, base } => {
                let request = http::Request::get(format!("{base}{path}"))
                    .body(Vec::new())
                    .map_err(|e| PromError::Config(e.to_string()))?;
                match client.request_text(request).await {
                    Ok(text) => (200, text),
                    Err(kube::Error::Api(status)) => (status.code, status.message.clone()),
                    Err(e) => return Err(PromError::Connect(e.to_string())),
                }
            }
            Route::Http {
                http, base, auth, ..
            } => {
                let response =
                    integration::send(http.get(format!("{base}{path}")), auth.as_deref())
                        .await
                        .map_err(|e| {
                            if e.starts_with("Credentials contain") {
                                PromError::Config(e)
                            } else {
                                PromError::Connect(e)
                            }
                        })?;
                (response.status, response.body)
            }
        };
        if !(200..300).contains(&status) {
            return Err(PromError::Http {
                status,
                reason: error_reason(&body, status),
            });
        }
        serde_json::from_str(&body).map_err(|e| PromError::Response(e.to_string()))
    }

    /// `query_range` → `data`.
    pub async fn query_range(
        &self,
        query: &str,
        start: u64,
        end: u64,
        step: u64,
    ) -> Result<Value, PromError> {
        let params = encode(&[
            ("query", query.to_string()),
            ("start", start.to_string()),
            ("end", end.to_string()),
            ("step", step.to_string()),
        ]);
        unwrap_data(self.get(&format!("/api/v1/query_range?{params}")).await?)
    }

    /// Instant `query` → `data`.
    pub async fn query(&self, query: &str) -> Result<Value, PromError> {
        let params = encode(&[("query", query.to_string())]);
        unwrap_data(self.get(&format!("/api/v1/query?{params}")).await?)
    }

    /// Version, exporters present and `cluster` label values.
    pub async fn info(&self, endpoint: &PromEndpoint) -> Result<PromInfo, PromError> {
        // The first call decides reachability; the rest are best effort.
        let has = |data: Result<Value, PromError>| {
            data.ok()
                .and_then(|d| parse_series(&d, None).ok())
                .is_some_and(|s| !s.is_empty())
        };
        let cluster = endpoint
            .cluster
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(|c| format!("{{cluster={}}}", super::escape(c)))
            .unwrap_or_default();
        let probe = self.query("vector(1)").await?;
        drop(probe);
        let version = self
            .get("/api/v1/status/buildinfo")
            .await
            .ok()
            .and_then(|v| {
                v.pointer("/data/version")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "unknown".to_string());
        let cadvisor = has(self
            .query(&format!(
                "count(container_cpu_usage_seconds_total{cluster})"
            ))
            .await);
        let kube_state_metrics = has(self
            .query(&format!(
                "count(kube_pod_container_resource_requests{cluster})"
            ))
            .await);
        let clusters = self
            .query("count by (cluster) (up)")
            .await
            .ok()
            .and_then(|d| parse_series(&d, Some("cluster")).ok())
            .map(|s| {
                s.into_iter()
                    .map(|s| s.label)
                    .filter(|l| !l.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        Ok(PromInfo {
            version,
            cadvisor,
            kube_state_metrics,
            clusters,
        })
    }

    /// Every chart of the Metrics section, queried concurrently; a failing
    /// chart carries its error while the others render.
    pub async fn metrics(
        &self,
        endpoint: &PromEndpoint,
        request: &MetricsRequest,
    ) -> Result<MetricsResult, PromError> {
        let step = request.range.step();
        let end = now_secs() / step * step;
        let start = end.saturating_sub(request.range.seconds());
        let queries = metrics_queries(request, endpoint.cluster.as_deref());
        let label = request.per_container.then_some("container");
        let results = join_all(queries.iter().map(|(chart, q)| async move {
            let label = if matches!(chart, Chart::NetworkRx | Chart::NetworkTx) {
                None
            } else {
                label
            };
            self.query_range(q, start, end, step)
                .await
                .and_then(|data| parse_series(&data, label))
        }))
        .await;
        // Unreachable is everyone's problem: report it once.
        if results
            .iter()
            .all(|r| matches!(r, Err(PromError::Connect(_))))
        {
            if let Some(Err(e)) = results.into_iter().next() {
                return Err(e);
            }
            return Err(PromError::Response("no charts".to_string()));
        }
        let charts = queries
            .into_iter()
            .zip(results)
            .map(|((chart, query), result)| match result {
                Ok(series) => ChartData {
                    chart,
                    query,
                    series,
                    error: None,
                },
                Err(e) => ChartData {
                    chart,
                    query,
                    series: Vec::new(),
                    error: Some(e.to_string()),
                },
            })
            .collect();
        Ok(MetricsResult {
            start,
            end,
            step,
            charts,
        })
    }

    /// Last hour of CPU and memory per pod of `namespace`.
    pub async fn sparklines(
        &self,
        endpoint: &PromEndpoint,
        namespace: &str,
    ) -> Result<Sparklines, PromError> {
        let end = now_secs() / SPARKLINE_STEP * SPARKLINE_STEP;
        let start = end.saturating_sub(SPARKLINE_RANGE);
        let (cpu, memory) = sparkline_queries(namespace, endpoint.cluster.as_deref());
        let (cpu, memory) = futures::join!(
            self.query_range(&cpu, start, end, SPARKLINE_STEP),
            self.query_range(&memory, start, end, SPARKLINE_STEP)
        );
        let by_pod = |data: Value| -> Result<_, PromError> {
            Ok(parse_series(&data, Some("pod"))?
                .into_iter()
                .filter(|s| !s.label.is_empty())
                .map(|s| (s.label, s.points))
                .collect())
        };
        Ok(Sparklines {
            cpu: by_pod(cpu?)?,
            memory: by_pod(memory?)?,
        })
    }
}

/// Classifies a service as a Prometheus server (not Alertmanager, node
/// exporter, operator or Pushgateway).
pub fn classify(service: &Service) -> Option<DetectedPrometheus> {
    let meta = &service.metadata;
    let name = meta.name.clone()?;
    let labels = meta.labels.clone().unwrap_or_default();
    let label = |k: &str| labels.get(k).map(String::as_str);
    let excluded = [
        "alertmanager",
        "node-exporter",
        "operator",
        "pushgateway",
        "kube-state-metrics",
    ];
    if excluded.iter().any(|x| name.contains(x)) {
        return None;
    }
    let labelled = label("app.kubernetes.io/name") == Some("prometheus")
        || label("operated-prometheus") == Some("true")
        || label("app") == Some("prometheus");
    let named = name == "prometheus-operated"
        || name == "prometheus-server"
        || name.ends_with("-prometheus")
        || name == "prometheus";
    if !(labelled || named) {
        return None;
    }
    let ports = service.spec.as_ref()?.ports.clone().unwrap_or_default();
    let port = ports
        .iter()
        .find(|p| p.port == 9090)
        .or_else(|| {
            ports
                .iter()
                .find(|p| matches!(p.name.as_deref(), Some("web" | "http" | "http-web")))
        })
        .or_else(|| ports.first())?;
    Some(DetectedPrometheus {
        namespace: meta.namespace.clone().unwrap_or_default(),
        name,
        port: u16::try_from(port.port).ok()?,
        https: port.name.as_deref().is_some_and(|n| n.contains("https")),
    })
}

/// Prometheus services in every namespace the user can list,
/// `prometheus-operated` (kube-prometheus-stack) first.
pub async fn detect(client: Client) -> Result<Vec<DetectedPrometheus>, PromError> {
    let services: Api<Service> = Api::all(client);
    let list = services
        .list(&ListParams::default())
        .await
        .map_err(|e| PromError::Connect(e.to_string()))?;
    let mut found: Vec<_> = list.items.iter().filter_map(classify).collect();
    found.sort_by_key(|d| {
        (
            d.name != "prometheus-operated",
            d.namespace.clone(),
            d.name.clone(),
        )
    });
    Ok(found)
}
