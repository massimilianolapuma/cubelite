//! Pieces shared by the HTTP integrations (Elasticsearch #483, Prometheus
//! #484): where an endpoint lives, what stored credentials are bound to,
//! the rules for external URLs, the in-cluster port-forward tunnel and
//! sending an authenticated request.

use std::time::Duration;

use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::ListParams;
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use crate::portforward::forward_pod_port;

/// Per-request timeout of the integrations.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Where an integration's HTTP API lives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Target {
    /// A service in the cluster.
    InCluster {
        /// Service namespace.
        namespace: String,
        /// Service name.
        service: String,
        /// Service port.
        port: u16,
        /// Whether the service speaks HTTPS.
        https: bool,
    },
    /// An external deployment, base URL without a trailing path.
    External {
        /// Base URL.
        url: String,
    },
}

/// What stored credentials are bound to: the endpoint's origin (external
/// scheme + host + port, or the in-cluster service) and whether TLS
/// verification was off. Secrets are only sent to the same binding, so a
/// request naming another endpoint cannot exfiltrate them.
pub fn binding(target: &Target, skip_tls_verify: bool) -> Result<String, String> {
    let origin = match target {
        Target::External { url } => url::Url::parse(url.trim())
            .map_err(|e| format!("Invalid URL \"{url}\": {e}"))?
            .origin()
            .ascii_serialization(),
        Target::InCluster {
            namespace,
            service,
            port,
            https,
        } => format!(
            "in-cluster:{namespace}/{service}:{port}:{}",
            if *https { "https" } else { "http" }
        ),
    };
    Ok(if skip_tls_verify {
        format!("{origin}|insecure")
    } else {
        origin
    })
}

/// Checks an external URL: http(s), no credentials in it, and credentials
/// only over https (or plain http to loopback, which never leaves the host).
pub fn check_external_url(url: &str, sends_credentials: bool) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("Invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Invalid URL: use http:// or https://".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Put credentials in the authentication fields, not in the URL".to_string());
    }
    let loopback = match parsed.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if parsed.scheme() == "http" && sends_credentials && !loopback {
        return Err("Credentials are only sent over https://".to_string());
    }
    Ok(parsed)
}

/// `{service}.{namespace}.svc`: the in-cluster DNS name (and the name ECK
/// puts in its HTTP certificate).
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

/// Why a tunnel could not be opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelError {
    /// The service cannot be tunnelled as configured.
    Config(String),
    /// The cluster or the pod could not be reached.
    Connect(String),
}

/// A port-forward to a ready pod behind a service; stopped on drop.
#[derive(Debug)]
pub struct ServiceTunnel {
    /// Local port on 127.0.0.1.
    pub local_port: u16,
    handle: JoinHandle<()>,
}

impl Drop for ServiceTunnel {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Opens a port-forward to a ready pod behind `namespace/service:port`
/// (the API server's service proxy strips `Authorization`,
/// kubernetes/kubernetes#38775, so secured services need this).
pub async fn open_service_tunnel(
    client: &Client,
    namespace: &str,
    service: &str,
    port: u16,
) -> Result<ServiceTunnel, TunnelError> {
    let connect = |e: kube::Error| TunnelError::Connect(e.to_string());
    let services: Api<Service> = Api::namespaced(client.clone(), namespace);
    let svc = services.get(service).await.map_err(connect)?;
    let selector = selector_string(&svc).ok_or_else(|| {
        TunnelError::Config(format!("Service {namespace}/{service} has no pod selector"))
    })?;
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let list = pods
        .list(&ListParams::default().labels(&selector))
        .await
        .map_err(connect)?;
    let pod = ready_pod(&list.items).ok_or_else(|| {
        TunnelError::Connect(format!("no ready pod behind {namespace}/{service}"))
    })?;
    let pod_name = pod.metadata.name.clone().unwrap_or_default();
    let remote = target_port(&svc, port, pod).ok_or_else(|| {
        TunnelError::Config(format!("Service {namespace}/{service} has no port {port}"))
    })?;
    let (local_port, handle) =
        forward_pod_port(client.clone(), namespace.to_string(), pod_name, 0, remote)
            .await
            .map_err(|e| TunnelError::Connect(e.to_string()))?;
    Ok(ServiceTunnel { local_port, handle })
}

/// A request's outcome before the integration reads it.
#[derive(Debug)]
pub struct RawResponse {
    /// HTTP status.
    pub status: u16,
    /// Body text.
    pub body: String,
}

/// Sends `request` with `authorization` (marked sensitive: kept out of
/// HTTP/2 compression tables and debug output). The error text is the
/// user-facing reason the endpoint could not be reached.
pub async fn send(
    request: reqwest::RequestBuilder,
    authorization: Option<&str>,
) -> Result<RawResponse, String> {
    let request = match authorization {
        Some(h) => {
            let mut value = reqwest::header::HeaderValue::from_str(h)
                .map_err(|_| "Credentials contain invalid characters".to_string())?;
            value.set_sensitive(true);
            request.header(reqwest::header::AUTHORIZATION, value)
        }
        None => request,
    };
    let response = request.send().await.map_err(|e| {
        if e.is_timeout() {
            "timed out after 15 s".to_string()
        } else {
            // Chain the source: reqwest's top-level text hides TLS/DNS details.
            let mut text = e.to_string();
            let mut source = std::error::Error::source(&e);
            while let Some(s) = source {
                text = format!("{text}: {s}");
                source = s.source();
            }
            text
        }
    })?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| e.to_string())?;
    Ok(RawResponse { status, body })
}

/// A client builder with the integrations' timeouts, TLS opt-out and no
/// redirects (a redirect must never carry credentials to another host).
pub fn http_builder(skip_tls_verify: bool) -> reqwest::ClientBuilder {
    // reqwest is built without a crypto provider and would panic without a
    // process default; installing ring is a no-op once one is set.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .danger_accept_invalid_certs(skip_tls_verify)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_is_the_origin_and_tls_setting() {
        let ext = |u: &str| Target::External { url: u.into() };
        let a = binding(&ext("https://es.example:9243/"), false).expect("a");
        assert_eq!(a, "https://es.example:9243");
        assert_eq!(
            binding(&ext("https://es.example:9243/some/path"), false).expect("same origin"),
            a
        );
        assert_ne!(
            binding(&ext("https://evil.example:9243"), false).expect("host"),
            a
        );
        assert_ne!(
            binding(&ext("http://es.example:9243"), false).expect("scheme"),
            a
        );
        assert_eq!(
            binding(&ext("https://es.example:9243"), true).expect("insecure"),
            format!("{a}|insecure")
        );
        let in_cluster = Target::InCluster {
            namespace: "logging".into(),
            service: "quickstart-es-http".into(),
            port: 9200,
            https: true,
        };
        assert_eq!(
            binding(&in_cluster, false).expect("in-cluster"),
            "in-cluster:logging/quickstart-es-http:9200:https"
        );
        assert!(binding(&ext("not a url"), false).is_err());
    }

    #[test]
    fn external_urls_refuse_credentials_in_them_and_over_http() {
        assert!(check_external_url("https://es.example", true).is_ok());
        assert!(check_external_url("http://es.example", false).is_ok());
        assert!(check_external_url("http://localhost:9200", true).is_ok());
        assert!(check_external_url("http://[::1]:9200", true).is_ok());
        assert!(check_external_url("http://es.example", true).is_err());
        assert!(check_external_url("https://u:p@es.example", false).is_err());
        assert!(check_external_url("ftp://es.example", false).is_err());
    }
}
