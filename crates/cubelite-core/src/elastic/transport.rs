//! Reaching Elasticsearch: a port-forward to a pod behind the service for
//! in-cluster endpoints (the API server's service proxy strips
//! `Authorization`, kubernetes/kubernetes#38775), HTTPS for external ones.

use std::net::SocketAddr;

use k8s_openapi::api::core::v1::{Secret, Service};
use kube::api::ListParams;
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    error_reason, map_response, search_body, validate_index_pattern, ElasticError, EsAuth,
    EsEndpoint, EsTarget, HistoryPage, HistoryQuery, DEFAULT_PAGE, MAX_PAGE,
};
use crate::integration::{self, open_service_tunnel, ServiceTunnel, TunnelError};
pub use crate::integration::{ready_pod, service_host, target_port, REQUEST_TIMEOUT};

/// An open connection: HTTP client, base URL and, for in-cluster endpoints,
/// the port-forward that carries it (stopped on drop).
pub struct EsConnection {
    http: reqwest::Client,
    base: String,
    auth: Option<String>,
    /// Carries in-cluster requests; closed with the connection.
    _tunnel: Option<ServiceTunnel>,
}

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
            if *https && !endpoint.skip_tls_verify {
                if let Some(pem) = eck_ca(&client, namespace, service).await? {
                    let cert = reqwest::Certificate::from_pem(&pem).map_err(connect_error)?;
                    builder = builder.add_root_certificate(cert);
                }
            }
            if *auth == EsAuth::EckUser {
                resolved = Some(eck_credentials(client.clone(), namespace, service).await?);
            }
            let tunnel = open_service_tunnel(&client, namespace, service, *port)
                .await
                .map_err(|e| match e {
                    TunnelError::Config(t) => ElasticError::Config(t),
                    TunnelError::Connect(t) => ElasticError::Connect(t),
                })?;
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
    pub async fn search(
        &self,
        endpoint: &EsEndpoint,
        query: &HistoryQuery,
    ) -> Result<HistoryPage, ElasticError> {
        validate_index_pattern(&endpoint.index_pattern)?;
        let body = search_body(query, endpoint.preset);
        let url = self.url(&format!(
            "{}/_search?ignore_unavailable=true&allow_no_indices=true",
            endpoint.index_pattern
        ));
        let response = self.send(self.http.post(url).json(&body)).await?;
        let size = query.size.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
        map_response(&response, endpoint.preset, size)
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
