//! Pieces shared by the HTTP integrations (Elasticsearch #483, Prometheus
//! #484): where an endpoint lives, what stored credentials are bound to,
//! the rules for external URLs, the in-cluster port-forward tunnel,
//! sending an authenticated request and finding the integrations' services
//! when a context connects (#527).

use std::time::Duration;

use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::ListParams;
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use crate::elastic::transport::{self as es, DetectedService};
use crate::portforward::forward_pod_port;
use crate::prometheus::transport::{self as prom, DetectedPrometheus};

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

/// A web UI service in the cluster picked from Detect (Kibana #505,
/// Grafana #525), opened through a port-forward when there is no URL.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRef {
    /// Namespace.
    pub namespace: String,
    /// Service name.
    pub service: String,
    /// Service port.
    pub port: u16,
    /// Whether it speaks HTTPS.
    pub https: bool,
}

impl ServiceRef {
    /// The service as an in-cluster target (its names are checked with
    /// [`check_target`]).
    pub fn target(&self) -> Target {
        Target::InCluster {
            namespace: self.namespace.clone(),
            service: self.service.clone(),
            port: self.port,
            https: self.https,
        }
    }
}

/// What stored credentials are bound to: the endpoint's origin (external
/// scheme + host + port, or the in-cluster service) and whether TLS
/// verification was off. Secrets are only sent to the same binding, so a
/// request naming another endpoint cannot exfiltrate them.
pub fn binding(target: &Target, skip_tls_verify: bool) -> Result<String, String> {
    check_target(target)?;
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

/// A DNS-1123 label (namespace and service names): it also keeps names out
/// of other API server paths (`/`, `..`).
fn is_dns_label(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

/// Checks an in-cluster target's names; external targets are checked when
/// connecting ([`check_external_url`]).
pub fn check_target(target: &Target) -> Result<(), String> {
    if let Target::InCluster {
        namespace, service, ..
    } = target
    {
        for (what, name) in [("namespace", namespace), ("service", service)] {
            if !is_dns_label(name) {
                return Err(format!("Invalid {what} name \"{name}\""));
            }
        }
    }
    Ok(())
}

/// Checks an external URL: http(s), no credentials in it, and credentials
/// only over https (or plain http to loopback, which never leaves the host).
/// The query and fragment are dropped: paths are appended to the result.
pub fn check_external_url(url: &str, sends_credentials: bool) -> Result<reqwest::Url, String> {
    let mut parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("Invalid URL: {e}"))?;
    parsed.set_query(None);
    parsed.set_fragment(None);
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

/// Whether `pod` still exists, runs and is ready (a forward to it is still
/// usable; a rollout or eviction replaces the pod).
pub async fn pod_ready(client: &Client, namespace: &str, pod: &str) -> bool {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    match pods.get_opt(pod).await {
        Ok(Some(p)) => ready_pod(std::slice::from_ref(&p)).is_some(),
        _ => false,
    }
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
    /// The pod the forward goes to (a rollout replaces it).
    pub pod: String,
    handle: JoinHandle<()>,
}

impl ServiceTunnel {
    /// Whether the forward still accepts connections.
    pub fn is_running(&self) -> bool {
        !self.handle.is_finished()
    }
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
    let (local_port, handle) = forward_pod_port(
        client.clone(),
        namespace.to_string(),
        pod_name.clone(),
        0,
        remote,
    )
    .await
    .map_err(|e| TunnelError::Connect(e.to_string()))?;
    Ok(ServiceTunnel {
        local_port,
        pod: pod_name,
        handle,
    })
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
    if (300..400).contains(&status) {
        // Redirects are refused (see `http_builder`): say where it pointed.
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("elsewhere")
            .to_string();
        return Ok(RawResponse {
            status,
            body: format!("redirect to {location} not followed — use that URL as the endpoint"),
        });
    }
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

/// The services the integrations would use, found in one listing of the
/// cluster's services when a context connects (#527): what the banner
/// offers.
///
/// Anyone allowed to create a Service in their own namespace can name it
/// `foo-es-http` or `prometheus-operated`, so a name is not trusted:
/// one-click Enable is offered only when exactly one operator-managed
/// service exists for the integration ([`es_trusted`], [`prom_trusted`]).
/// Otherwise the banner offers Review, with every candidate.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    /// Best Elasticsearch guess (see [`pick_services`]).
    pub elasticsearch: Option<DetectedService>,
    /// Kibana in the Elasticsearch's namespace.
    pub kibana: Option<DetectedService>,
    /// Best Prometheus guess.
    pub prometheus: Option<DetectedPrometheus>,
    /// Grafana in the Prometheus's namespace.
    pub grafana: Option<DetectedPrometheus>,
    /// `elasticsearch` is the only ECK-managed Elasticsearch: Enable may
    /// save it without a review.
    pub elasticsearch_one_click: bool,
    /// `prometheus` is the only operator-managed Prometheus.
    pub prometheus_one_click: bool,
    /// Every Elasticsearch and Kibana found, best first (for Review).
    pub elastic_services: Vec<DetectedService>,
    /// Every Prometheus and Grafana found, best first (for Review).
    pub prometheus_services: Vec<DetectedPrometheus>,
}

/// Namespaces where observability stacks usually live, preferred after
/// operator ownership.
pub const WELL_KNOWN_NAMESPACES: [&str; 4] =
    ["logging", "elastic-system", "monitoring", "observability"];

/// Whether `service` is owned by a custom resource of `kind` in API group
/// `group`.
fn owned_by(service: &Service, kind: &str, group: &str) -> bool {
    service
        .metadata
        .owner_references
        .iter()
        .flatten()
        .any(|o| o.kind == kind && o.api_version.split('/').next() == Some(group))
}

fn label<'a>(service: &'a Service, key: &str) -> Option<&'a str> {
    service
        .metadata
        .labels
        .as_ref()?
        .get(key)
        .map(String::as_str)
}

/// An Elasticsearch service managed by ECK: owned by an `Elasticsearch`
/// resource, or carrying ECK's type and cluster-name labels.
pub fn es_trusted(service: &Service) -> bool {
    owned_by(service, "Elasticsearch", "elasticsearch.k8s.elastic.co")
        || (label(service, "common.k8s.elastic.co/type") == Some("elasticsearch")
            && label(service, "elasticsearch.k8s.elastic.co/cluster-name").is_some())
}

/// A Prometheus service managed by the Prometheus operator: owned by a
/// `Prometheus` resource, or its governing `prometheus-operated` service.
pub fn prom_trusted(service: &Service) -> bool {
    owned_by(service, "Prometheus", "monitoring.coreos.com")
        || (service.metadata.name.as_deref() == Some("prometheus-operated")
            && label(service, "operated-prometheus") == Some("true"))
}

/// What ranking needs from a detected service.
trait Found: Clone {
    fn kind(&self) -> &str;
    fn namespace(&self) -> &str;
    fn name(&self) -> &str;
}

impl Found for DetectedService {
    fn kind(&self) -> &str {
        &self.kind
    }
    fn namespace(&self) -> &str {
        &self.namespace
    }
    fn name(&self) -> &str {
        &self.name
    }
}

impl Found for DetectedPrometheus {
    fn kind(&self) -> &str {
        &self.kind
    }
    fn namespace(&self) -> &str {
        &self.namespace
    }
    fn name(&self) -> &str {
        &self.name
    }
}

/// One integration's pick: the main service, its web UI, whether Enable
/// can skip the review, and every candidate best first.
struct Picked<T> {
    main: Option<T>,
    web_ui: Option<T>,
    one_click: bool,
    all: Vec<T>,
}

/// Ranks `found` (service, trusted): the `main` kind first, then trusted,
/// well-known namespace, `conventional` name, namespace and name. The web
/// UI comes only from the main service's namespace; one-click needs exactly
/// one trusted main service.
fn pick<T: Found>(
    mut found: Vec<(T, bool)>,
    main: &str,
    conventional: impl Fn(&T) -> bool,
) -> Picked<T> {
    found.sort_by_key(|(d, trusted)| {
        (
            d.kind() != main,
            !trusted,
            !WELL_KNOWN_NAMESPACES.contains(&d.namespace()),
            !conventional(d),
            d.namespace().to_string(),
            d.name().to_string(),
        )
    });
    let best = found.iter().find(|(d, _)| d.kind() == main);
    let web_ui = best.and_then(|(m, _)| {
        found
            .iter()
            .find(|(d, _)| d.kind() != main && d.namespace() == m.namespace())
            .map(|(d, _)| d.clone())
    });
    let trusted = found.iter().filter(|(d, t)| *t && d.kind() == main).count();
    Picked {
        main: best.map(|(d, _)| d.clone()),
        web_ui,
        one_click: trusted == 1 && best.is_some_and(|(_, t)| *t),
        all: found.into_iter().map(|(d, _)| d).collect(),
    }
}

/// Picks the integrations' services from a service list with the
/// Elasticsearch and Prometheus classifiers, ranked by operator ownership
/// ([`es_trusted`], [`prom_trusted`]), well-known namespace
/// ([`WELL_KNOWN_NAMESPACES`]), conventional name (`-es-http`,
/// `prometheus-operated`), namespace and name. Kibana and Grafana come only
/// from the namespace of the service they go with.
pub fn pick_services(services: &[Service]) -> Detected {
    let es = pick(
        services
            .iter()
            .filter_map(|s| es::classify(s).map(|d| (d, es_trusted(s))))
            .collect(),
        "elasticsearch",
        |d| d.name.ends_with("-es-http") || d.name.ends_with("-kb-http"),
    );
    let prom = pick(
        services
            .iter()
            .filter_map(|s| prom::classify(s).map(|d| (d, prom_trusted(s))))
            .collect(),
        "prometheus",
        |d| d.name == "prometheus-operated",
    );
    Detected {
        elasticsearch: es.main,
        kibana: es.web_ui,
        prometheus: prom.main,
        grafana: prom.web_ui,
        elasticsearch_one_click: es.one_click,
        prometheus_one_click: prom.one_click,
        elastic_services: es.all,
        prometheus_services: prom.all,
    }
}

/// Lists the services of every namespace once and picks the integrations'
/// ([`pick_services`]). Only the Kubernetes API is contacted: no traffic to
/// Elasticsearch or Prometheus and no secrets. A user who may not list
/// services across namespaces (403) gets nothing found, not an error.
pub async fn detect_all(client: Client) -> Result<Detected, String> {
    let services: Api<Service> = Api::all(client);
    match services.list(&ListParams::default()).await {
        Ok(list) => Ok(pick_services(&list.items)),
        Err(kube::Error::Api(status)) if status.code == 403 => Ok(Detected::default()),
        Err(e) => Err(e.to_string()),
    }
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
    fn in_cluster_names_must_be_dns_labels() {
        let target = |ns: &str, svc: &str| Target::InCluster {
            namespace: ns.into(),
            service: svc.into(),
            port: 9090,
            https: false,
        };
        assert!(check_target(&target("monitoring", "prometheus-operated")).is_ok());
        for (ns, svc) in [
            ("a/b", "s"),
            ("..", "s"),
            ("ns", ""),
            ("ns", "Svc"),
            ("ns", "-s"),
        ] {
            assert!(check_target(&target(ns, svc)).is_err(), "{ns}/{svc}");
            assert!(binding(&target(ns, svc), false).is_err());
        }
        assert_eq!(
            check_external_url("https://p.example/api/prom?x=1#f", false)
                .expect("url")
                .as_str(),
            "https://p.example/api/prom"
        );
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

    fn svc(
        namespace: &str,
        name: &str,
        labels: serde_json::Value,
        ports: serde_json::Value,
    ) -> Service {
        serde_json::from_value(serde_json::json!({
            "metadata": { "name": name, "namespace": namespace, "labels": labels },
            "spec": { "ports": ports }
        }))
        .expect("service")
    }

    /// A cluster with ECK, kube-prometheus-stack, a second Elasticsearch
    /// chart, a second Grafana and unrelated services.
    fn mixed_services() -> Vec<Service> {
        use serde_json::json;
        let eck = |kind: &str| json!({ "common.k8s.elastic.co/type": kind });
        vec![
            svc(
                "default",
                "kubernetes",
                json!({}),
                json!([{ "name": "https", "port": 443 }]),
            ),
            svc(
                "a-search",
                "elasticsearch-master",
                json!({ "app": "elasticsearch-master" }),
                json!([{ "name": "http", "port": 9200 }]),
            ),
            svc(
                "logging",
                "quickstart-es-transport",
                eck("elasticsearch"),
                json!([{ "name": "tls-transport", "port": 9300 }]),
            ),
            svc(
                "logging",
                "quickstart-es-default",
                eck("elasticsearch"),
                json!([{ "name": "https", "port": 9200 }]),
            ),
            owned(
                svc(
                    "logging",
                    "quickstart-es-http",
                    eck("elasticsearch"),
                    json!([{ "name": "https", "port": 9200 }]),
                ),
                "Elasticsearch",
                "elasticsearch.k8s.elastic.co/v1",
            ),
            svc(
                "a-search",
                "kibana",
                json!({ "app.kubernetes.io/name": "kibana" }),
                json!([{ "name": "http", "port": 5601 }]),
            ),
            svc(
                "logging",
                "quickstart-kb-http",
                eck("kibana"),
                json!([{ "name": "https", "port": 5601 }]),
            ),
            svc(
                "a-metrics",
                "prometheus-server",
                json!({ "app": "prometheus" }),
                json!([{ "name": "http", "port": 80 }]),
            ),
            svc(
                "monitoring",
                "kps-kube-prometheus-stack-prometheus",
                json!({}),
                json!([{ "name": "http-web", "port": 9090 }]),
            ),
            svc(
                "monitoring",
                "prometheus-operated",
                json!({ "operated-prometheus": "true" }),
                json!([{ "name": "http-web", "port": 9090 }]),
            ),
            svc(
                "monitoring",
                "kps-kube-prometheus-stack-alertmanager",
                json!({}),
                json!([{ "name": "http-web", "port": 9093 }]),
            ),
            svc(
                "a-metrics",
                "grafana",
                json!({ "app.kubernetes.io/name": "grafana" }),
                json!([{ "name": "service", "port": 80 }]),
            ),
            svc(
                "monitoring",
                "kps-grafana",
                json!({ "app.kubernetes.io/name": "grafana" }),
                json!([{ "name": "http-web", "port": 80 }]),
            ),
        ]
    }

    /// `service` with an owner reference to a `kind` of `api_version`.
    fn owned(mut service: Service, kind: &str, api_version: &str) -> Service {
        service.metadata.owner_references = Some(vec![serde_json::from_value(
            serde_json::json!({ "apiVersion": api_version, "kind": kind, "name": "quickstart", "uid": "u1" }),
        )
        .expect("owner")]);
        service
    }

    fn names<T: Found>(d: &Option<T>) -> Option<(&str, &str)> {
        d.as_ref().map(|d| (d.namespace(), d.name()))
    }

    #[test]
    fn pick_services_ranks_operator_owned_then_well_known_namespaces() {
        let found = pick_services(&mixed_services());
        let es = found.elasticsearch.as_ref().expect("elasticsearch");
        assert_eq!((es.port, es.https), (9200, true));
        assert_eq!(
            names(&found.elasticsearch),
            Some(("logging", "quickstart-es-http"))
        );
        assert_eq!(
            names(&found.kibana),
            Some(("logging", "quickstart-kb-http"))
        );
        assert_eq!(
            names(&found.prometheus),
            Some(("monitoring", "prometheus-operated"))
        );
        assert_eq!(names(&found.grafana), Some(("monitoring", "kps-grafana")));
        // One operator-managed service each: Enable needs no review.
        assert!(found.elasticsearch_one_click && found.prometheus_one_click);
        // Review lists every candidate, the main kind first, best first.
        let listed: Vec<&str> = found
            .elastic_services
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert_eq!(
            listed,
            [
                "quickstart-es-http",
                "elasticsearch-master",
                "quickstart-kb-http",
                "kibana"
            ]
        );
        let listed: Vec<&str> = found
            .prometheus_services
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert_eq!(
            listed,
            [
                "prometheus-operated",
                "kps-kube-prometheus-stack-prometheus",
                "prometheus-server",
                "kps-grafana",
                "grafana"
            ]
        );

        // Without operator-managed services: well-known namespaces first,
        // then namespace and name; nothing is one-click.
        let unmanaged: Vec<Service> = mixed_services()
            .into_iter()
            .filter(|s| {
                let name = s.metadata.name.as_deref().unwrap_or_default();
                !name.starts_with("quickstart") && name != "prometheus-operated"
            })
            .collect();
        let found = pick_services(&unmanaged);
        assert_eq!(
            names(&found.elasticsearch),
            Some(("a-search", "elasticsearch-master"))
        );
        assert_eq!(names(&found.kibana), Some(("a-search", "kibana")));
        assert_eq!(
            names(&found.prometheus),
            Some(("monitoring", "kps-kube-prometheus-stack-prometheus"))
        );
        assert_eq!(names(&found.grafana), Some(("monitoring", "kps-grafana")));
        assert!(!found.elasticsearch_one_click && !found.prometheus_one_click);
        assert_eq!(pick_services(&[]), Detected::default());
    }

    #[test]
    fn several_operator_managed_candidates_need_a_review() {
        use serde_json::json;
        let mut services = mixed_services();
        // Look-alikes in a namespace anyone may create Services in.
        services.push(svc(
            "team-a",
            "prometheus-operated",
            json!({ "operated-prometheus": "true" }),
            json!([{ "name": "http-web", "port": 9090 }]),
        ));
        services.push(svc(
            "team-a",
            "evil-es-http",
            json!({ "common.k8s.elastic.co/type": "elasticsearch", "elasticsearch.k8s.elastic.co/cluster-name": "evil" }),
            json!([{ "name": "https", "port": 9200 }]),
        ));
        let found = pick_services(&services);
        // The best guess stays the well-known one, but Enable needs a review.
        assert_eq!(
            names(&found.prometheus),
            Some(("monitoring", "prometheus-operated"))
        );
        assert_eq!(
            names(&found.elasticsearch),
            Some(("logging", "quickstart-es-http"))
        );
        assert!(!found.elasticsearch_one_click && !found.prometheus_one_click);
    }

    #[test]
    fn a_lone_unmanaged_look_alike_needs_a_review() {
        use serde_json::json;
        let lone = |s: Service| pick_services(&[s]);
        let found = lone(svc(
            "team-a",
            "foo-es-http",
            json!({}),
            json!([{ "name": "https", "port": 9200 }]),
        ));
        assert_eq!(names(&found.elasticsearch), Some(("team-a", "foo-es-http")));
        assert!(!found.elasticsearch_one_click);
        // An owner reference must name ECK's API group, not a look-alike.
        let found = lone(owned(
            svc(
                "team-a",
                "foo-es-http",
                json!({}),
                json!([{ "name": "https", "port": 9200 }]),
            ),
            "Elasticsearch",
            "elasticsearch.k8s.evil.example/v1",
        ));
        assert!(!found.elasticsearch_one_click);
        // `prometheus-operated` without the operator's label is not managed.
        let found = lone(svc(
            "team-a",
            "prometheus-operated",
            json!({}),
            json!([{ "name": "http-web", "port": 9090 }]),
        ));
        assert!(found.prometheus.is_some() && !found.prometheus_one_click);
        // Owned by a Prometheus resource: managed.
        let found = lone(owned(
            svc(
                "team-a",
                "prom",
                json!({ "app": "prometheus" }),
                json!([{ "name": "web", "port": 9090 }]),
            ),
            "Prometheus",
            "monitoring.coreos.com/v1",
        ));
        assert!(found.prometheus_one_click);
    }

    /// A kube client whose API server answers every request with `status`
    /// and `body`, recording the paths it was asked for.
    fn api_server(
        status: u16,
        body: serde_json::Value,
    ) -> (Client, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use http::{Request, Response};
        use kube::client::Body;
        let paths = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = paths.clone();
        let (service, handle) = tower_test::mock::pair::<Request<Body>, Response<Body>>();
        tokio::spawn(async move {
            let mut handle = std::pin::pin!(handle);
            while let Some((request, send)) = handle.next_request().await {
                seen.lock()
                    .expect("paths")
                    .push(request.uri().path().to_string());
                let response = Response::builder()
                    .status(status)
                    .body(Body::from(body.to_string().into_bytes()))
                    .expect("response");
                send.send_response(response);
            }
        });
        (Client::new(service, "default"), paths)
    }

    #[tokio::test]
    async fn detect_all_lists_services_once_and_reads_nothing_else() {
        let list = serde_json::json!({
            "apiVersion": "v1", "kind": "ServiceList", "metadata": {},
            "items": mixed_services(),
        });
        let (client, paths) = api_server(200, list);
        let found = detect_all(client).await.expect("detect");
        assert!(found.elasticsearch.is_some() && found.kibana.is_some());
        assert!(found.prometheus.is_some() && found.grafana.is_some());
        assert_eq!(*paths.lock().expect("paths"), ["/api/v1/services"]);
    }

    #[tokio::test]
    async fn detect_all_gives_up_silently_when_forbidden() {
        let forbidden = serde_json::json!({
            "kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "Forbidden", "code": 403,
            "message": "services is forbidden: User \"dev\" cannot list resource \"services\" at the cluster scope",
        });
        let (client, _) = api_server(403, forbidden);
        assert_eq!(detect_all(client).await, Ok(Detected::default()));
        let (client, _) = api_server(
            500,
            serde_json::json!({ "kind": "Status", "code": 500, "message": "boom" }),
        );
        assert!(detect_all(client).await.is_err());
    }
}
