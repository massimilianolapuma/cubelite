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
use crate::integration::{
    self, open_service_tunnel, service_host, ServiceTunnel, TunnelError, REQUEST_TIMEOUT,
};

/// What goes in `Authorization`.
enum Credential {
    None,
    Header(String),
    /// Resolved on every request: the cached Azure token is refreshed
    /// before it expires, so a long-lived connection keeps working.
    Azure,
}

enum Route {
    /// `/api/v1/namespaces/{ns}/services/{scheme}:{svc}:{port}/proxy` on the API server.
    Proxy { client: Client, base: String },
    /// Direct HTTP: external, or through a port-forward tunnel.
    Http {
        http: reqwest::Client,
        base: String,
        auth: Credential,
        _tunnel: Option<ServiceTunnel>,
    },
}

/// A response and whether the API server (not Prometheus) produced it.
struct Answer {
    status: u16,
    body: String,
    from_api_server: bool,
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
            let credential = match auth {
                PromAuth::AzureCli => {
                    if !azure::is_azure_monitor_url(&parsed) {
                        return Err(PromError::Config(
                            "Azure CLI sign-in works only with https://…prometheus.monitor.azure.com endpoints"
                                .to_string(),
                        ));
                    }
                    // Fail early (az missing, logged out) rather than per chart.
                    azure::token().await?;
                    Credential::Azure
                }
                other => other.header().map_or(Credential::None, Credential::Header),
            };
            let http = integration::http_builder(endpoint.skip_tls_verify)
                .build()
                .map_err(|e| PromError::Connect(e.to_string()))?;
            Ok(PromConnection {
                route: Route::Http {
                    http,
                    base: parsed.as_str().trim_end_matches('/').to_string(),
                    auth: credential,
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
            integration::check_target(&endpoint.target).map_err(PromError::Config)?;
            let client =
                kube.ok_or_else(|| PromError::Config("No cluster connection".to_string()))?;
            let proxy = PromConnection {
                route: Route::Proxy {
                    client: client.clone(),
                    base: proxy_base(namespace, service, *port, *https),
                },
            };
            let probe = proxy.fetch("/api/v1/status/buildinfo").await?;
            match (probe.from_api_server, probe.status) {
                // Prometheus answered (an old one may lack build info).
                (false, _) => return Ok(proxy),
                (true, 404) => {
                    return Err(PromError::Config(format!(
                        "Service {namespace}/{service} not found: {}",
                        error_reason(&probe.body, 404)
                    )))
                }
                // Forbidden (no `services/proxy` RBAC) or unavailable (no
                // endpoints, error reaching the pod): try a port-forward.
                (true, 403 | 500 | 502 | 503) => {}
                (true, status) => {
                    return Err(PromError::Http {
                        status,
                        reason: error_reason(&probe.body, status),
                    })
                }
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
                    auth: Credential::None,
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
    /// GET `path` (from `/api/v1/…`) with a 15 s limit on every route.
    async fn fetch(&self, path: &str) -> Result<Answer, PromError> {
        match &self.route {
            Route::Proxy { client, base } => {
                let request = http::Request::get(format!("{base}{path}"))
                    .body(kube::client::Body::from(Vec::new()))
                    .map_err(|e| PromError::Config(e.to_string()))?;
                let exchange = async {
                    let response = client.send(request).await?;
                    let status = response.status().as_u16();
                    let bytes = response.into_body().collect_bytes().await?;
                    Ok::<_, kube::Error>((status, bytes))
                };
                let (status, bytes) = tokio::time::timeout(REQUEST_TIMEOUT, exchange)
                    .await
                    .map_err(|_| PromError::Connect("timed out after 15 s".to_string()))?
                    .map_err(|e| PromError::Connect(e.to_string()))?;
                let body = String::from_utf8_lossy(&bytes).into_owned();
                // The API server's own errors are `Status` objects; Prometheus
                // answers `{"status":"error",…}` or its data.
                let from_api_server = !(200..300).contains(&status)
                    && serde_json::from_str::<Value>(&body)
                        .ok()
                        .is_some_and(|v| v.get("kind").and_then(Value::as_str) == Some("Status"));
                Ok(Answer {
                    status,
                    body,
                    from_api_server,
                })
            }
            Route::Http {
                http, base, auth, ..
            } => {
                let header = match auth {
                    Credential::None => None,
                    Credential::Header(h) => Some(h.clone()),
                    Credential::Azure => Some(format!("Bearer {}", azure::token().await?)),
                };
                let response =
                    integration::send(http.get(format!("{base}{path}")), header.as_deref())
                        .await
                        .map_err(|e| {
                            if e.starts_with("Credentials contain") {
                                PromError::Config(e)
                            } else {
                                PromError::Connect(e)
                            }
                        })?;
                if response.status == 401 && matches!(auth, Credential::Azure) {
                    // Expired, revoked or another tenant: fetch a new one next time.
                    azure::forget().await;
                }
                Ok(Answer {
                    status: response.status,
                    body: response.body,
                    from_api_server: false,
                })
            }
        }
    }

    /// GET `path`, parsed as JSON.
    async fn get(&self, path: &str) -> Result<Value, PromError> {
        let answer = self.fetch(path).await?;
        if !(200..300).contains(&answer.status) {
            return Err(PromError::Http {
                status: answer.status,
                reason: error_reason(&answer.body, answer.status),
            });
        }
        serde_json::from_str(&answer.body).map_err(|e| PromError::Response(e.to_string()))
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
                .and_then(|d| parse_series(&d, &[]).ok())
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
            .and_then(|d| parse_series(&d, &["cluster"]).ok())
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
        let label: &[&str] = if request.per_container {
            &["container"]
        } else {
            &[]
        };
        let results = join_all(queries.iter().map(|(chart, q)| async move {
            let label: &[&str] = if matches!(
                chart,
                Chart::NetworkRx | Chart::NetworkTx | Chart::RestartsTotal
            ) {
                &[]
            } else {
                label
            };
            // The total is one evaluation at the end of the range.
            let from = if *chart == Chart::RestartsTotal {
                end
            } else {
                start
            };
            self.query_range(q, from, end, step)
                .await
                .and_then(|data| parse_series(&data, label))
        }))
        .await;
        // Unreachable or rejected credentials are everyone's problem:
        // report them once (the caller then drops the connection).
        if results.iter().all(|r| {
            matches!(
                r,
                Err(PromError::Connect(_)
                    | PromError::Http {
                        status: 401 | 403,
                        ..
                    })
            )
        }) {
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

    /// Last hour of CPU and memory per pod of `namespace` (every namespace
    /// with `None`), keyed `namespace/pod`.
    pub async fn sparklines(
        &self,
        endpoint: &PromEndpoint,
        namespace: Option<&str>,
    ) -> Result<Sparklines, PromError> {
        let end = now_secs() / SPARKLINE_STEP * SPARKLINE_STEP;
        let start = end.saturating_sub(SPARKLINE_RANGE);
        let (cpu, memory) = sparkline_queries(namespace, endpoint.cluster.as_deref());
        let (cpu, memory) = futures::join!(
            self.query_range(&cpu, start, end, SPARKLINE_STEP),
            self.query_range(&memory, start, end, SPARKLINE_STEP)
        );
        let by_pod = |data: Value| -> Result<_, PromError> {
            Ok(parse_series(&data, &["namespace", "pod"])?
                .into_iter()
                .filter(|s| !s.label.starts_with('/') && !s.label.ends_with('/'))
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
