//! Reaching Elasticsearch: a port-forward to a pod behind the service for
//! in-cluster endpoints (the API server's service proxy strips
//! `Authorization`, kubernetes/kubernetes#38775), HTTPS for external ones.

use std::net::SocketAddr;
use std::time::Duration;

use k8s_openapi::api::core::v1::{Pod, Secret, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::ListParams;
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::JoinHandle;

use super::{
    error_reason, map_response, search_body, validate_index_pattern, ElasticError, EsAuth,
    EsEndpoint, EsTarget, HistoryPage, HistoryQuery, DEFAULT_PAGE, MAX_PAGE,
};
use crate::portforward::forward_pod_port;

/// Per-request timeout.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// An open connection: HTTP client, base URL and, for in-cluster endpoints,
/// the port-forward that carries it (stopped on drop).
pub struct EsConnection {
    http: reqwest::Client,
    base: String,
    auth: Option<String>,
    forward: Option<JoinHandle<()>>,
}

impl Drop for EsConnection {
    fn drop(&mut self) {
        if let Some(handle) = self.forward.take() {
            handle.abort();
        }
    }
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

/// `{service}.{namespace}.svc`: the name ECK puts in the HTTP certificate.
pub fn service_host(namespace: &str, service: &str) -> String {
    format!("{service}.{namespace}.svc")
}

/// The container port a service port targets on `pod`: a numeric
/// `targetPort`, a named one looked up in the pod's containers, or the
/// service port itself.
pub fn target_port(service: &Service, port: u16, pod: &Pod) -> Option<u16> {
    let spec_port = service
        .spec
        .as_ref()?
        .ports
        .as_ref()?
        .iter()
        .find(|p| p.port == i32::from(port))?;
    match &spec_port.target_port {
        None => Some(port),
        Some(IntOrString::Int(n)) => u16::try_from(*n).ok(),
        Some(IntOrString::String(name)) => pod
            .spec
            .as_ref()?
            .containers
            .iter()
            .flat_map(|c| c.ports.iter().flatten())
            .find(|p| p.name.as_deref() == Some(name.as_str()))
            .and_then(|p| u16::try_from(p.container_port).ok()),
    }
}

/// First running pod whose Ready condition is true.
pub fn ready_pod(pods: &[Pod]) -> Option<&Pod> {
    pods.iter().find(|p| {
        let status = p.status.as_ref();
        status.and_then(|s| s.phase.as_deref()) == Some("Running")
            && status
                .and_then(|s| s.conditions.as_ref())
                .is_some_and(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
    })
}

/// `k=v,k2=v2` label selector from a service selector.
fn selector_string(service: &Service) -> Option<String> {
    let selector = service.spec.as_ref()?.selector.as_ref()?;
    if selector.is_empty() {
        return None;
    }
    Some(
        selector
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(","),
    )
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
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|e| ElasticError::Config(format!("Invalid URL: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ElasticError::Config(
            "Invalid URL: use http:// or https://".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ElasticError::Config(
            "Put credentials in the authentication fields, not in the URL".to_string(),
        ));
    }
    if *auth == EsAuth::EckUser {
        return Err(ElasticError::Config(
            "ECK credentials apply to in-cluster endpoints only".to_string(),
        ));
    }
    let loopback = match parsed.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if parsed.scheme() == "http" && *auth != EsAuth::None && !loopback {
        return Err(ElasticError::Config(
            "Credentials are only sent over https://".to_string(),
        ));
    }
    Ok(parsed)
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
    // reqwest is built without a crypto provider and would panic without a
    // process default; installing ring is a no-op once one is set.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut builder = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .danger_accept_invalid_certs(endpoint.skip_tls_verify);
    let mut resolved: Option<EsAuth> = None;
    let (base, forward) = match &endpoint.target {
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
            let services: Api<Service> = Api::namespaced(client.clone(), namespace);
            let svc = services.get(service).await.map_err(connect_error)?;
            let selector = selector_string(&svc).ok_or_else(|| {
                ElasticError::Config(format!("Service {namespace}/{service} has no pod selector"))
            })?;
            let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
            let list = pods
                .list(&ListParams::default().labels(&selector))
                .await
                .map_err(connect_error)?;
            let pod = ready_pod(&list.items).ok_or_else(|| {
                ElasticError::Connect(format!("no ready pod behind {namespace}/{service}"))
            })?;
            let pod_name = pod.metadata.name.clone().unwrap_or_default();
            let remote = target_port(&svc, *port, pod).ok_or_else(|| {
                ElasticError::Config(format!("Service {namespace}/{service} has no port {port}"))
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
            let (local, handle) =
                forward_pod_port(client.clone(), namespace.clone(), pod_name, 0, remote)
                    .await
                    .map_err(connect_error)?;
            let host = service_host(namespace, service);
            // The tunnel is local: never route it through HTTP(S)_PROXY.
            builder = builder
                .no_proxy()
                .resolve(&host, SocketAddr::from(([127, 0, 0, 1], local)));
            let scheme = if *https { "https" } else { "http" };
            (format!("{scheme}://{host}:{local}"), Some(handle))
        }
    };
    let http = builder.build().map_err(connect_error)?;
    let header = resolved.as_ref().unwrap_or(auth).header();
    Ok(EsConnection {
        http,
        base,
        auth: header,
        forward,
    })
}

impl EsConnection {
    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Value, ElasticError> {
        let request = match &self.auth {
            Some(h) => {
                let mut value = reqwest::header::HeaderValue::from_str(h).map_err(|_| {
                    ElasticError::Config("Credentials contain invalid characters".to_string())
                })?;
                // Keeps it out of HTTP/2 compression tables and debug output.
                value.set_sensitive(true);
                request.header(reqwest::header::AUTHORIZATION, value)
            }
            None => request,
        };
        let response = request.send().await.map_err(|e| {
            if e.is_timeout() {
                ElasticError::Connect("timed out after 15 s".to_string())
            } else {
                // Chain the source: reqwest's top-level text hides TLS/DNS details.
                let mut text = e.to_string();
                let mut source = std::error::Error::source(&e);
                while let Some(s) = source {
                    text = format!("{text}: {s}");
                    source = s.source();
                }
                ElasticError::Connect(text)
            }
        })?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(connect_error)?;
        if !(200..300).contains(&status) {
            return Err(ElasticError::Http {
                status,
                reason: error_reason(&body, status),
            });
        }
        serde_json::from_str(&body).map_err(|e| ElasticError::Response(e.to_string()))
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
