//! Reaching Elasticsearch: a port-forward to a pod behind the service for
//! in-cluster endpoints (the API server's service proxy strips
//! `Authorization`, kubernetes/kubernetes#38775), HTTPS for external ones.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};

use k8s_openapi::api::core::v1::{Secret, Service};
use kube::api::ListParams;
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    error_reason, map_response, search_body, validate_index_pattern, ElasticError, EsAuth,
    EsEndpoint, EsTarget, HistoryCursor, HistoryPage, HistoryQuery, DEFAULT_PAGE, MAX_PAGE,
    PIT_KEEP_ALIVE,
};
use crate::integration::{self, open_service_tunnel, ServiceTunnel, TunnelError};
pub use crate::integration::{ready_pod, service_host, target_port, REQUEST_TIMEOUT};

/// An open connection: HTTP client, base URL and, for in-cluster endpoints,
/// the port-forward that carries it (stopped on drop).
pub struct EsConnection {
    http: reqwest::Client,
    base: String,
    auth: Option<String>,
    /// Opening a point in time failed with 400/403/404/405 (no privilege,
    /// or a server without PIT): page with plain `search_after` from now on.
    no_pit: AtomicBool,
    /// Carries in-cluster requests; closed with the connection.
    _tunnel: Option<ServiceTunnel>,
}

/// `search_after` that resumes on a new point in time from the boundary
/// timestamp of `sort`: the largest `_shard_doc` keeps every hit of that
/// millisecond (newest first, descending tiebreaker).
fn resume_sort(sort: &[Value]) -> Vec<Value> {
    vec![
        sort.first().cloned().unwrap_or(Value::Null),
        json!(i64::MAX),
    ]
}

/// Statuses of a PIT open that mean "no PIT here" rather than a failure:
/// no `manage`/`read` privilege for PIT, or an older Elasticsearch /
/// OpenSearch without `/{index}/_pit`.
const NO_PIT_STATUSES: [u16; 4] = [400, 403, 404, 405];

impl std::fmt::Debug for EsConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EsConnection")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

/// Server facts for Preferences → Test connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EsInfo {
    /// `version.number`.
    pub version: String,
    /// `cluster_name`.
    pub cluster_name: String,
    /// `green` / `yellow` / `red`, when the user may read cluster health.
    pub health: Option<String>,
    /// Indices matching the pattern, when the user may list them.
    pub indices: Option<u64>,
}

/// An Elasticsearch or Kibana service found in the cluster.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedService {
    /// `elasticsearch` or `kibana`.
    pub kind: String,
    /// Namespace.
    pub namespace: String,
    /// Service name.
    pub name: String,
    /// HTTP port.
    pub port: u16,
    /// Whether the port speaks HTTPS.
    pub https: bool,
}

fn connect_error(e: impl std::fmt::Display) -> ElasticError {
    ElasticError::Connect(e.to_string())
}

/// ECK publishes the HTTP CA in `{service}-certs-public` (`ca.crt`).
/// `Ok(None)` when the secret does not exist (not ECK: platform roots
/// apply); an error when it cannot be read, so a TLS failure names its cause.
async fn eck_ca(
    client: &Client,
    namespace: &str,
    service: &str,
) -> Result<Option<Vec<u8>>, ElasticError> {
    let name = format!("{service}-certs-public");
    let secrets: Api<Secret> = Api::namespaced(client.clone(), namespace);
    let secret = secrets.get_opt(&name).await.map_err(|e| {
        ElasticError::Connect(format!("cannot read the CA secret {namespace}/{name}: {e}"))
    })?;
    Ok(secret
        .and_then(|s| s.data)
        .and_then(|d| d.get("ca.crt").map(|b| b.0.clone())))
}

/// ECK's built-in `elastic` user from `{cluster}-es-elastic-user`, for a
/// `{cluster}-es-http` service.
pub async fn eck_credentials(
    client: Client,
    namespace: &str,
    service: &str,
) -> Result<EsAuth, ElasticError> {
    let cluster = service.strip_suffix("-es-http").ok_or_else(|| {
        ElasticError::Config(format!(
            "\"{service}\" is not an ECK service (name-es-http)"
        ))
    })?;
    let secrets: Api<Secret> = Api::namespaced(client, namespace);
    let secret = secrets
        .get(&format!("{cluster}-es-elastic-user"))
        .await
        .map_err(|e| ElasticError::Config(format!("Cannot read the ECK credentials: {e}")))?;
    let password = secret
        .data
        .and_then(|d| {
            d.get("elastic")
                .map(|b| String::from_utf8_lossy(&b.0).into_owned())
        })
        .ok_or_else(|| ElasticError::Config("The ECK secret has no `elastic` key".to_string()))?;
    Ok(EsAuth::Basic {
        username: "elastic".to_string(),
        password,
    })
}

/// Checks an external URL: http(s), no credentials in it, and credentials
/// only over https (or plain http to loopback, which never leaves the host).
pub fn check_external_url(url: &str, auth: &EsAuth) -> Result<reqwest::Url, ElasticError> {
    if *auth == EsAuth::EckUser {
        return Err(ElasticError::Config(
            "ECK credentials apply to in-cluster endpoints only".to_string(),
        ));
    }
    integration::check_external_url(url, *auth != EsAuth::None).map_err(ElasticError::Config)
}

/// Opens a connection to `endpoint`. In-cluster endpoints need `kube`.
///
/// Credentials go only over HTTPS or the in-cluster tunnel; `EckUser` is
/// read from the cluster here, never stored.
pub async fn connect(
    kube: Option<Client>,
    endpoint: &EsEndpoint,
    auth: &EsAuth,
) -> Result<EsConnection, ElasticError> {
    let mut builder = integration::http_builder(endpoint.skip_tls_verify);
    let mut resolved: Option<EsAuth> = None;
    let (base, tunnel) = match &endpoint.target {
        EsTarget::External { url } => {
            let parsed = check_external_url(url, auth)?;
            (parsed.as_str().trim_end_matches('/').to_string(), None)
        }
        EsTarget::InCluster {
            namespace,
            service,
            port,
            https,
        } => {
            let client =
                kube.ok_or_else(|| ElasticError::Config("No cluster connection".to_string()))?;
            let tunnel = open_service_tunnel(&client, namespace, service, *port)
                .await
                .map_err(|e| match e {
                    TunnelError::Config(t) => ElasticError::Config(t),
                    TunnelError::Connect(t) => ElasticError::Connect(t),
                })?;
            if *https && !endpoint.skip_tls_verify {
                if let Some(pem) = eck_ca(&client, namespace, service).await? {
                    let cert = reqwest::Certificate::from_pem(&pem).map_err(connect_error)?;
                    builder = builder.add_root_certificate(cert);
                }
            }
            if *auth == EsAuth::EckUser {
                resolved = Some(eck_credentials(client.clone(), namespace, service).await?);
            }
            let host = service_host(namespace, service);
            // The tunnel is local: never route it through HTTP(S)_PROXY.
            builder = builder
                .no_proxy()
                .resolve(&host, SocketAddr::from(([127, 0, 0, 1], tunnel.local_port)));
            let scheme = if *https { "https" } else { "http" };
            (
                format!("{scheme}://{host}:{}", tunnel.local_port),
                Some(tunnel),
            )
        }
    };
    let http = builder.build().map_err(connect_error)?;
    let header = resolved.as_ref().unwrap_or(auth).header();
    Ok(EsConnection {
        http,
        base,
        auth: header,
        no_pit: AtomicBool::new(false),
        _tunnel: tunnel,
    })
}

impl EsConnection {
    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Value, ElasticError> {
        let response = integration::send(request, self.auth.as_deref())
            .await
            .map_err(|e| {
                if e.starts_with("Credentials contain") {
                    ElasticError::Config(e)
                } else {
                    ElasticError::Connect(e)
                }
            })?;
        if !(200..300).contains(&response.status) {
            return Err(ElasticError::Http {
                status: response.status,
                reason: error_reason(&response.body, response.status),
            });
        }
        serde_json::from_str(&response.body).map_err(|e| ElasticError::Response(e.to_string()))
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base, path.trim_start_matches('/'))
    }

    /// One page of a pod's history.
    ///
    /// The first page opens a point in time over the index pattern and the
    /// cursor carries it to the next pages (#531), so hits with equal
    /// timestamps are neither skipped nor repeated between pages while the
    /// PIT lives. The PIT is closed after the last page or a failed first
    /// page; the frontends close it earlier with [`Self::close_cursor`] when
    /// the search is replaced. Servers without PIT (or users without the
    /// privilege) fall back to plain `search_after`, remembered for this
    /// connection; any other failure to open one falls back for this
    /// request only.
    pub async fn search(
        &self,
        endpoint: &EsEndpoint,
        query: &HistoryQuery,
    ) -> Result<HistoryPage, ElasticError> {
        validate_index_pattern(&endpoint.index_pattern)?;
        let size = query.size.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
        let Some(cursor) = &query.search_after else {
            return self.first_page(endpoint, query, size).await;
        };
        let Some(pit) = &cursor.pit_id else {
            return self.search_plain(endpoint, query, size).await;
        };
        match self.search_pit(endpoint, query, pit, size).await {
            Err(ElasticError::Http {
                status: 404,
                reason,
            }) => {
                // The PIT expired (idle longer than its keep-alive), and its
                // `_shard_doc` values mean nothing on a new one: resume from
                // the boundary timestamp with the largest tiebreaker. Lines
                // of that millisecond may repeat (the frontends drop them by
                // `_index` + `_id`), none is skipped.
                let Ok(Some(fresh)) = self.open_pit(endpoint).await else {
                    return Err(ElasticError::Http {
                        status: 404,
                        reason,
                    });
                };
                let mut resumed = query.clone();
                resumed.search_after = Some(HistoryCursor {
                    pit_id: Some(fresh.clone()),
                    sort: resume_sort(&cursor.sort),
                });
                let result = self.search_pit(endpoint, &resumed, &fresh, size).await;
                self.settle(result, Some(&fresh)).await
            }
            other => self.settle(other, None).await,
        }
    }

    /// Closes the point in time a cursor carries, best effort (the search
    /// was replaced or closed before its last page). Errors are ignored:
    /// the PIT expires on its own after its keep-alive.
    pub async fn close_cursor(&self, cursor: &HistoryCursor) {
        if let Some(id) = &cursor.pit_id {
            self.close_pit(id).await;
        }
    }

    /// The first page: on a new point in time when the server gives one,
    /// else with plain `search_after`.
    async fn first_page(
        &self,
        endpoint: &EsEndpoint,
        query: &HistoryQuery,
        size: u32,
    ) -> Result<HistoryPage, ElasticError> {
        let Some(pit) = self.open_pit(endpoint).await? else {
            return self.search_plain(endpoint, query, size).await;
        };
        match self.search_pit(endpoint, query, &pit, size).await {
            Err(ElasticError::Http { status: 400, .. }) => {
                // Elasticsearch 7.10–7.11 has PIT but no `_shard_doc`: page
                // without PIT on this connection.
                self.close_pit(&pit).await;
                self.no_pit.store(true, Ordering::Relaxed);
                self.search_plain(endpoint, query, size).await
            }
            other => self.settle(other, Some(&pit)).await,
        }
    }

    /// A PIT page's outcome: the PIT is closed after the last page, or when
    /// this request `opened` it and failed.
    async fn settle(
        &self,
        result: Result<(HistoryPage, String), ElasticError>,
        opened: Option<&str>,
    ) -> Result<HistoryPage, ElasticError> {
        match result {
            Ok((page, latest)) => {
                if page.next.is_none() {
                    self.close_pit(&latest).await;
                }
                Ok(page)
            }
            Err(e) => {
                if let Some(id) = opened {
                    self.close_pit(id).await;
                }
                Err(e)
            }
        }
    }

    /// One page with plain `search_after` on the index pattern.
    async fn search_plain(
        &self,
        endpoint: &EsEndpoint,
        query: &HistoryQuery,
        size: u32,
    ) -> Result<HistoryPage, ElasticError> {
        let body = search_body(query, endpoint.preset, None);
        let url = self.url(&format!(
            "{}/_search?ignore_unavailable=true&allow_no_indices=true",
            endpoint.index_pattern
        ));
        let response = self.send(self.http.post(url).json(&body)).await?;
        map_response(&response, endpoint.preset, size)
    }

    /// Opens a point in time over the index pattern. `Ok(None)` pages
    /// without one: remembered for the connection when the server has no
    /// PIT for us (see [`NO_PIT_STATUSES`]), for this request only on any
    /// other answer (a full PIT table's 429, a 5xx). Unreachable servers
    /// stay errors.
    async fn open_pit(&self, endpoint: &EsEndpoint) -> Result<Option<String>, ElasticError> {
        if self.no_pit.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let url = self.url(&format!(
            "{}/_pit?keep_alive={PIT_KEEP_ALIVE}&ignore_unavailable=true",
            endpoint.index_pattern
        ));
        let id = match self.send(self.http.post(url)).await {
            Ok(body) => body.get("id").and_then(Value::as_str).map(str::to_owned),
            Err(ElasticError::Http { status, .. }) if NO_PIT_STATUSES.contains(&status) => None,
            Err(ElasticError::Connect(e)) => return Err(ElasticError::Connect(e)),
            Err(_) => return Ok(None),
        };
        if id.is_none() {
            self.no_pit.store(true, Ordering::Relaxed);
        }
        Ok(id)
    }

    /// One page on point in time `pit`, and the PIT id to use next (the
    /// response's `pit_id`, which Elasticsearch may update).
    async fn search_pit(
        &self,
        endpoint: &EsEndpoint,
        query: &HistoryQuery,
        pit: &str,
        size: u32,
    ) -> Result<(HistoryPage, String), ElasticError> {
        let body = search_body(query, endpoint.preset, Some(pit));
        // A PIT search names no index (the PIT holds them).
        let response = self
            .send(self.http.post(self.url("_search")).json(&body))
            .await?;
        let latest = response
            .get("pit_id")
            .and_then(Value::as_str)
            .unwrap_or(pit)
            .to_string();
        let mut page = map_response(&response, endpoint.preset, size)?;
        if let Some(next) = &mut page.next {
            next.pit_id = Some(latest.clone());
        }
        Ok((page, latest))
    }

    /// `DELETE /_pit`, best effort.
    async fn close_pit(&self, id: &str) {
        let request = self
            .http
            .delete(self.url("_pit"))
            .json(&json!({ "id": id }));
        let _ = self.send(request).await;
    }

    /// Version and cluster name (required), health and matching index count (best effort).
    pub async fn info(&self, endpoint: &EsEndpoint) -> Result<EsInfo, ElasticError> {
        let root = self.send(self.http.get(self.url("/"))).await?;
        let health = self
            .send(self.http.get(self.url("_cluster/health")))
            .await
            .ok()
            .and_then(|h| h.get("status").and_then(Value::as_str).map(str::to_owned));
        let indices = if validate_index_pattern(&endpoint.index_pattern).is_ok() {
            self.send(self.http.get(self.url(&format!(
                "_resolve/index/{}?expand_wildcards=open",
                endpoint.index_pattern
            ))))
            .await
            .ok()
            .map(|r| {
                let count = |k: &str| r.get(k).and_then(Value::as_array).map_or(0, Vec::len) as u64;
                count("indices") + count("data_streams")
            })
        } else {
            None
        };
        Ok(EsInfo {
            version: root
                .pointer("/version/number")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
            cluster_name: root
                .get("cluster_name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            health,
            indices,
        })
    }
}

/// Classifies a service as Elasticsearch / Kibana by ECK labels, the
/// `app.kubernetes.io/name` label or its name.
pub fn classify(service: &Service) -> Option<DetectedService> {
    let meta = &service.metadata;
    let name = meta.name.clone()?;
    let labels = meta.labels.clone().unwrap_or_default();
    let label = |k: &str| labels.get(k).map(String::as_str);
    let eck = label("common.k8s.elastic.co/type");
    let kind = match (eck, label("app.kubernetes.io/name")) {
        (Some("elasticsearch"), _) | (_, Some("elasticsearch")) => "elasticsearch",
        (Some("kibana"), _) | (_, Some("kibana")) => "kibana",
        _ if name.ends_with("-es-http") || name.starts_with("elasticsearch") => "elasticsearch",
        _ if name.ends_with("-kb-http") || name.starts_with("kibana") => "kibana",
        _ => return None,
    };
    if name.ends_with("-transport")
        || name.ends_with("-headless")
        || name.ends_with("-internal-http")
    {
        return None;
    }
    // ECK also labels per-nodeSet services; only `-es-http` / `-kb-http`
    // match the certificate names and the ECK credential naming.
    if eck.is_some() && !(name.ends_with("-es-http") || name.ends_with("-kb-http")) {
        return None;
    }
    let wanted = if kind == "elasticsearch" { 9200 } else { 5601 };
    let ports = service.spec.as_ref()?.ports.clone().unwrap_or_default();
    let port = ports
        .iter()
        .find(|p| p.port == wanted)
        .or_else(|| ports.first())?;
    // ECK and most charts name the port after its scheme.
    let https = port.name.as_deref().is_some_and(|n| n.contains("https"));
    Some(DetectedService {
        kind: kind.to_string(),
        namespace: meta.namespace.clone().unwrap_or_default(),
        name,
        port: u16::try_from(port.port).ok()?,
        https,
    })
}

/// Elasticsearch and Kibana services in every namespace the user can list.
pub async fn detect(client: Client) -> Result<Vec<DetectedService>, ElasticError> {
    let services: Api<Service> = Api::all(client);
    let list = services
        .list(&ListParams::default())
        .await
        .map_err(connect_error)?;
    Ok(list.items.iter().filter_map(classify).collect())
}
