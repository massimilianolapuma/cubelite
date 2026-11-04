//! Pieces shared by the HTTP integrations (Elasticsearch #483, Prometheus
//! #484): where an endpoint lives, what stored credentials are bound to,
//! the rules for external URLs, the in-cluster port-forward tunnel,
//! sending an authenticated request and finding the integrations' services
//! when a context connects (#527).

use std::time::Duration;

use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference;
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::{ApiResource, DynamicObject, ListParams};
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

/// Keychain service suffix of the default endpoint's credentials (#528):
/// `cubelite.elastic.default`, `cubelite.prometheus.default`. A service of
/// its own, so no kube context name (the account of per-context
/// credentials) can collide with it.
pub const DEFAULT_SERVICE_SUFFIX: &str = ".default";

/// Account of the default endpoint's credentials in its own service.
pub const DEFAULT_ACCOUNT: &str = "default";

/// A default endpoint shared by every context (#528) must be external: an
/// in-cluster service is per cluster by nature.
pub fn check_shared(target: &Target, shared: bool) -> Result<(), String> {
    match target {
        Target::InCluster { .. } if shared => {
            Err("A default endpoint shared by every context must be an external URL".to_string())
        }
        _ => Ok(()),
    }
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

/// The services the integrations would use, found when a context connects
/// (#527): what the banner offers.
///
/// Anyone allowed to create a Service in their own namespace can name it
/// `foo-es-http` or `prometheus-operated`, label it like an operator would,
/// and point an owner reference anywhere. So names and labels only rank
/// candidates; trust needs a verified owner ([`detect_all`]), and one-click
/// Enable needs that owner's service to be the only candidate in the
/// cluster. Otherwise the banner offers Review, with every candidate.
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
    /// `elasticsearch` is owned by a verified ECK `Elasticsearch` and is the
    /// only Elasticsearch: Enable may save it without a review.
    pub elasticsearch_one_click: bool,
    /// `prometheus` is owned by a verified `Prometheus` and is the only
    /// Prometheus.
    pub prometheus_one_click: bool,
    /// Every Elasticsearch and Kibana found, best first (for Review).
    pub elastic_services: Vec<DetectedService>,
    /// Every Prometheus and Grafana found, best first (for Review).
    pub prometheus_services: Vec<DetectedPrometheus>,
}

/// Namespaces where observability stacks usually live, preferred (after a
/// verified owner) when ranking.
pub const WELL_KNOWN_NAMESPACES: [&str; 4] =
    ["logging", "elastic-system", "monitoring", "observability"];

/// The operator resource that owns an integration's Service.
#[derive(Debug)]
pub struct Operator {
    /// Owner kind (`Elasticsearch`).
    pub kind: &'static str,
    /// API group (`elasticsearch.k8s.elastic.co`).
    pub group: &'static str,
    /// API version.
    pub version: &'static str,
    /// Resource plural (`elasticsearches`).
    pub plural: &'static str,
    /// Selector labels naming the instance: a Service of the instance
    /// selects its pods with one of them set to the resource's name.
    pub instance_labels: &'static [&'static str],
}

impl Operator {
    /// Whether `service` selects the pods of the instance named `owner`.
    fn selects_instance(&self, service: &Service, owner: &str) -> bool {
        let selector = service.spec.as_ref().and_then(|s| s.selector.as_ref());
        self.instance_labels
            .iter()
            .any(|label| selector.and_then(|s| s.get(*label)).map(String::as_str) == Some(owner))
    }
}

/// ECK's `Elasticsearch`.
pub const ECK: Operator = Operator {
    kind: "Elasticsearch",
    group: "elasticsearch.k8s.elastic.co",
    version: "v1",
    plural: "elasticsearches",
    instance_labels: &["elasticsearch.k8s.elastic.co/cluster-name"],
};

/// The Prometheus operator's `Prometheus`.
pub const PROMETHEUS_OPERATOR: Operator = Operator {
    kind: "Prometheus",
    group: "monitoring.coreos.com",
    version: "v1",
    plural: "prometheuses",
    instance_labels: &["operator.prometheus.io/name", "prometheus"],
};

/// The owner reference to `operator`'s resource a Service claims.
fn owner_claim<'a>(service: &'a Service, operator: &Operator) -> Option<&'a OwnerReference> {
    service
        .metadata
        .owner_references
        .iter()
        .flatten()
        .find(|o| {
            o.kind == operator.kind && o.api_version.split('/').next() == Some(operator.group)
        })
}

/// A resource name (DNS subdomain): keeps it out of other API paths.
fn is_resource_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && !name.contains("..")
        && name
            .split('.')
            .all(|part| is_dns_label(part) || part.bytes().all(|b| b.is_ascii_digit()))
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

/// One integration's detection rules.
struct Integration<T> {
    /// Kind of the service the integration reads (`elasticsearch`).
    main: &'static str,
    operator: &'static Operator,
    classify: fn(&Service) -> Option<T>,
    /// The name its operator or chart usually gives it.
    conventional: fn(&T) -> bool,
}

const ELASTIC: Integration<DetectedService> = Integration {
    main: "elasticsearch",
    operator: &ECK,
    classify: es::classify,
    conventional: |d| d.name.ends_with("-es-http") || d.name.ends_with("-kb-http"),
};

const PROMETHEUS: Integration<DetectedPrometheus> = Integration {
    main: "prometheus",
    operator: &PROMETHEUS_OPERATOR,
    classify: prom::classify,
    conventional: |d| d.name == "prometheus-operated",
};

/// Services whose owner was verified, as `(owner kind, namespace, name)`:
/// a Service verified for one integration never counts for another.
pub type Verified = std::collections::HashSet<(String, String, String)>;

/// How many claimed owners are checked per integration.
const MAX_VERIFIED: usize = 3;

impl<T: Found> Integration<T> {
    /// Candidates with their Service, best first: main kind, verified owner,
    /// well-known namespace, conventional name, namespace, name.
    fn ranked<'a>(
        &self,
        services: &'a [Service],
        verified: &Verified,
    ) -> Vec<(T, &'a Service, bool)> {
        let mut found: Vec<(T, &Service, bool)> = services
            .iter()
            .filter_map(|s| {
                let d = (self.classify)(s)?;
                let key = (
                    self.operator.kind.to_string(),
                    d.namespace().to_string(),
                    d.name().to_string(),
                );
                let trusted = d.kind() == self.main && verified.contains(&key);
                Some((d, s, trusted))
            })
            .collect();
        found.sort_by_key(|(d, _, trusted)| {
            (
                d.kind() != self.main,
                !trusted,
                !WELL_KNOWN_NAMESPACES.contains(&d.namespace()),
                !(self.conventional)(d),
                d.namespace().to_string(),
                d.name().to_string(),
            )
        });
        found
    }

    /// The owners worth checking: main-kind candidates claiming one, best
    /// first, at most [`MAX_VERIFIED`] (a flood of fake claims cannot make
    /// detection send many requests).
    fn claims<'a>(&self, services: &'a [Service]) -> Vec<(&'a Service, &'a OwnerReference)> {
        self.ranked(services, &Verified::new())
            .into_iter()
            .filter(|(d, _, _)| d.kind() == self.main)
            .filter_map(|(_, s, _)| owner_claim(s, self.operator).map(|o| (s, o)))
            .take(MAX_VERIFIED)
            .collect()
    }

    /// The pick: the best main service, its web UI from the same namespace,
    /// whether Enable may skip the review, and every candidate.
    fn pick(&self, services: &[Service], verified: &Verified) -> Picked<T> {
        let found = self.ranked(services, verified);
        let best = found.iter().find(|(d, _, _)| d.kind() == self.main);
        let web_ui = best.and_then(|(m, _, _)| {
            found
                .iter()
                .find(|(d, _, _)| d.kind() != self.main && d.namespace() == m.namespace())
                .map(|(d, _, _)| d.clone())
        });
        let one_click = best.is_some_and(|(m, service, trusted)| {
            // The verified owner must be the controller, and the Service must
            // select that instance's pods (not, say, every Prometheus).
            let Some(owner) = owner_claim(service, self.operator)
                .filter(|o| *trusted && o.controller == Some(true))
                .map(|o| o.name.as_str())
                .filter(|owner| self.operator.selects_instance(service, owner))
            else {
                return false;
            };
            // Another Service of the same instance in its namespace is not a
            // second candidate; claiming the same owner is not enough.
            found
                .iter()
                .filter(|(d, s, _)| d.kind() == self.main && !std::ptr::eq(*s, *service))
                .all(|(_, s, _)| {
                    s.metadata.namespace.as_deref() == Some(m.namespace())
                        && self.operator.selects_instance(s, owner)
                })
        });
        Picked {
            main: best.map(|(d, _, _)| d.clone()),
            web_ui,
            one_click,
            all: found.into_iter().map(|(d, _, _)| d).collect(),
        }
    }
}

/// One integration's pick.
struct Picked<T> {
    main: Option<T>,
    web_ui: Option<T>,
    one_click: bool,
    all: Vec<T>,
}

/// Picks the integrations' services from a service list with the
/// Elasticsearch and Prometheus classifiers. `verified` holds the Services
/// whose operator owner was checked ([`detect_all`]); they rank first, then
/// well-known namespaces ([`WELL_KNOWN_NAMESPACES`]), the conventional name
/// (`-es-http`, `prometheus-operated`), namespace and name. Labels and names
/// never make a service trusted. Kibana and Grafana come only from the
/// namespace of the service they go with.
pub fn pick_services(services: &[Service], verified: &Verified) -> Detected {
    let es = ELASTIC.pick(services, verified);
    let prom = PROMETHEUS.pick(services, verified);
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

/// Whether `operator`'s resource `owner` exists in `namespace` with the
/// claimed uid. Any error (403, 404, no such CRD) means no.
async fn owner_exists(
    client: &Client,
    operator: &Operator,
    namespace: &str,
    owner: &OwnerReference,
) -> bool {
    if !is_dns_label(namespace) || !is_resource_name(&owner.name) {
        return false;
    }
    let resource = ApiResource {
        group: operator.group.to_string(),
        version: operator.version.to_string(),
        api_version: format!("{}/{}", operator.group, operator.version),
        kind: operator.kind.to_string(),
        plural: operator.plural.to_string(),
    };
    let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), namespace, &resource);
    matches!(
        api.get_opt(&owner.name).await,
        Ok(Some(found)) if found.metadata.uid.as_deref() == Some(owner.uid.as_str())
    )
}

/// The Services among `claims` whose owner exists with the claimed uid.
async fn verify(
    client: &Client,
    operator: &Operator,
    claims: Vec<(&Service, &OwnerReference)>,
) -> Verified {
    let mut verified = Verified::new();
    for (service, owner) in claims {
        let namespace = service.metadata.namespace.clone().unwrap_or_default();
        if owner_exists(client, operator, &namespace, owner).await {
            verified.insert((
                operator.kind.to_string(),
                namespace,
                service.metadata.name.clone().unwrap_or_default(),
            ));
        }
    }
    verified
}

/// Lists the services of every namespace once, checks the operator owners
/// the best candidates claim (a GET of the `Elasticsearch` or `Prometheus`
/// resource, whose uid must match), and picks ([`pick_services`]). Only the
/// Kubernetes API is contacted: no traffic to Elasticsearch or Prometheus
/// and no secrets. A user who may not list services across namespaces (403)
/// gets nothing found, not an error.
pub async fn detect_all(client: Client) -> Result<Detected, String> {
    let services: Api<Service> = Api::all(client.clone());
    let list = match services.list(&ListParams::default()).await {
        Ok(list) => list.items,
        Err(kube::Error::Api(status)) if status.code == 403 => return Ok(Detected::default()),
        Err(e) => return Err(e.to_string()),
    };
    let mut verified = verify(&client, &ECK, ELASTIC.claims(&list)).await;
    verified.extend(verify(&client, &PROMETHEUS_OPERATOR, PROMETHEUS.claims(&list)).await);
    Ok(pick_services(&list, &verified))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_endpoints_must_be_external() {
        let in_cluster = Target::InCluster {
            namespace: "logging".into(),
            service: "es".into(),
            port: 9200,
            https: true,
        };
        assert!(check_shared(&in_cluster, true).is_err());
        assert!(check_shared(&in_cluster, false).is_ok());
        let ext = Target::External {
            url: "https://es.example".into(),
        };
        assert!(check_shared(&ext, true).is_ok());
    }

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

    use serde_json::{json, Value};

    /// A Service; `extra` is merged into it (`ownerReferences`, `selector`).
    fn svc(namespace: &str, name: &str, labels: Value, port: (&str, u16), extra: Value) -> Service {
        let mut v = json!({
            "metadata": { "name": name, "namespace": namespace, "labels": labels },
            "spec": { "ports": [{ "name": port.0, "port": port.1 }] }
        });
        if let Some(owner) = extra.get("owner") {
            v["metadata"]["ownerReferences"] = json!([owner]);
        }
        if let Some(selector) = extra.get("selector") {
            v["spec"]["selector"] = selector.clone();
        }
        serde_json::from_value(v).expect("service")
    }

    fn owner(
        kind: &str,
        api_version: &str,
        name: &str,
        uid: &str,
        controller: Option<bool>,
    ) -> Value {
        let mut owner =
            json!({ "apiVersion": api_version, "kind": kind, "name": name, "uid": uid });
        if let Some(c) = controller {
            owner["controller"] = json!(c);
        }
        json!({ "owner": owner })
    }

    /// ECK's owner reference (a controller reference).
    fn eck_owner() -> Value {
        owner(
            "Elasticsearch",
            "elasticsearch.k8s.elastic.co/v1",
            "quickstart",
            "es-uid",
            Some(true),
        )
    }

    /// `extra` with `selector` added.
    fn with_selector(mut extra: Value, selector: Value) -> Value {
        extra["selector"] = selector;
        extra
    }

    /// The operator's reference on `prometheus-operated`: not a controller
    /// reference (as on kube-prometheus-stack).
    fn prom_owner(controller: Option<bool>) -> Value {
        owner(
            "Prometheus",
            "monitoring.coreos.com/v1",
            "kps-prometheus",
            "prom-uid",
            controller,
        )
    }

    /// ECK and kube-prometheus-stack as they really are (owners, selectors:
    /// `prometheus-operated` is the operator's governing Service, selecting
    /// every Prometheus of the namespace, with a non-controller owner
    /// reference), plus unrelated services.
    fn cluster() -> Vec<Service> {
        let eck = |kind: &str| json!({ "common.k8s.elastic.co/type": kind, "elasticsearch.k8s.elastic.co/cluster-name": "quickstart" });
        vec![
            svc(
                "default",
                "kubernetes",
                json!({}),
                ("https", 443),
                json!({}),
            ),
            svc(
                "logging",
                "quickstart-es-transport",
                eck("elasticsearch"),
                ("tls-transport", 9300),
                eck_owner(),
            ),
            svc(
                "logging",
                "quickstart-es-default",
                eck("elasticsearch"),
                ("https", 9200),
                eck_owner(),
            ),
            svc(
                "logging",
                "quickstart-es-http",
                eck("elasticsearch"),
                ("https", 9200),
                with_selector(
                    eck_owner(),
                    json!({ "common.k8s.elastic.co/type": "elasticsearch", "elasticsearch.k8s.elastic.co/cluster-name": "quickstart" }),
                ),
            ),
            svc(
                "logging",
                "quickstart-kb-http",
                eck("kibana"),
                ("https", 5601),
                json!({}),
            ),
            svc(
                "monitoring",
                "prometheus-operated",
                json!({ "operated-prometheus": "true" }),
                ("http-web", 9090),
                with_selector(
                    prom_owner(None),
                    json!({ "app.kubernetes.io/name": "prometheus" }),
                ),
            ),
            svc(
                "monitoring",
                "kps-prometheus",
                json!({}),
                ("http-web", 9090),
                json!({ "selector": { "app.kubernetes.io/name": "prometheus", "operator.prometheus.io/name": "kps-prometheus" } }),
            ),
            svc(
                "monitoring",
                "kps-alertmanager",
                json!({}),
                ("http-web", 9093),
                json!({}),
            ),
            svc(
                "monitoring",
                "kps-grafana",
                json!({ "app.kubernetes.io/name": "grafana" }),
                ("http-web", 80),
                json!({}),
            ),
        ]
    }

    /// Verified `(owner kind, namespace, service)`.
    fn verified(services: &[(&str, &str, &str)]) -> Verified {
        services
            .iter()
            .map(|(k, n, s)| (k.to_string(), n.to_string(), s.to_string()))
            .collect()
    }

    fn real_owners() -> Verified {
        verified(&[
            ("Elasticsearch", "logging", "quickstart-es-http"),
            ("Prometheus", "monitoring", "prometheus-operated"),
        ])
    }

    /// `prometheus-operated` replaced by a Service a `Prometheus` controls
    /// and that selects that instance (`prometheus=<name>`).
    fn managed_prometheus(controller: Option<bool>, instance: &str) -> Vec<Service> {
        let mut services = cluster();
        services.retain(|s| s.metadata.name.as_deref() != Some("prometheus-operated"));
        services.push(svc(
            "monitoring",
            "prometheus-operated",
            json!({ "operated-prometheus": "true" }),
            ("http-web", 9090),
            with_selector(prom_owner(controller), json!({ "prometheus": instance })),
        ));
        services
    }

    fn names<T: Found>(d: &Option<T>) -> Option<(&str, &str)> {
        d.as_ref().map(|d| (d.namespace(), d.name()))
    }

    #[test]
    fn controlled_services_selecting_their_instance_are_one_click() {
        // The Prometheus controls its Service, which selects its pods; the
        // chart's own Service selecting the same instance is not a second one.
        let found = pick_services(
            &managed_prometheus(Some(true), "kps-prometheus"),
            &real_owners(),
        );
        assert!(found.prometheus_one_click);
        // Not a controller reference, or the Service selects other pods: Review.
        let found = pick_services(
            &managed_prometheus(Some(false), "kps-prometheus"),
            &real_owners(),
        );
        assert!(!found.prometheus_one_click);
        let found = pick_services(&managed_prometheus(None, "kps-prometheus"), &real_owners());
        assert!(!found.prometheus_one_click);
        let found = pick_services(&managed_prometheus(Some(true), "other"), &real_owners());
        assert!(!found.prometheus_one_click);
        // ECK's Service without the instance selector: Review.
        let mut services = cluster();
        for s in &mut services {
            if s.metadata.name.as_deref() == Some("quickstart-es-http") {
                s.spec.as_mut().expect("spec").selector = None;
            }
        }
        assert!(!pick_services(&services, &real_owners()).elasticsearch_one_click);
    }

    #[test]
    fn verification_counts_only_for_its_own_integration() {
        // A Service both classifiers accept, controlled by a Prometheus.
        let both = svc(
            "monitoring",
            "elasticsearch-prometheus",
            json!({}),
            ("web", 9090),
            with_selector(
                prom_owner(Some(true)),
                json!({ "prometheus": "kps-prometheus" }),
            ),
        );
        let services = [both];
        let as_es = verified(&[("Elasticsearch", "monitoring", "elasticsearch-prometheus")]);
        assert!(!pick_services(&services, &as_es).prometheus_one_click);
        let as_prom = verified(&[("Prometheus", "monitoring", "elasticsearch-prometheus")]);
        let found = pick_services(&services, &as_prom);
        assert!(found.prometheus_one_click);
        // ...and a Prometheus verification never makes it a trusted Elasticsearch.
        assert!(!found.elasticsearch_one_click);
    }

    #[test]
    fn verified_owners_rank_first() {
        let found = pick_services(&cluster(), &real_owners());
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
        // ECK's Service is controlled by its Elasticsearch and selects it;
        // kube-prometheus-stack's governing Service is neither (Review).
        assert!(found.elasticsearch_one_click);
        assert!(!found.prometheus_one_click);
        let listed: Vec<&str> = found
            .prometheus_services
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert_eq!(
            listed,
            ["prometheus-operated", "kps-prometheus", "kps-grafana"]
        );
        // Without verification the same cluster needs a review.
        let found = pick_services(&cluster(), &Verified::new());
        assert_eq!(
            names(&found.elasticsearch),
            Some(("logging", "quickstart-es-http"))
        );
        assert!(!found.elasticsearch_one_click && !found.prometheus_one_click);
        assert_eq!(pick_services(&[], &Verified::new()), Detected::default());
    }

    #[test]
    fn labels_and_names_rank_but_never_trust() {
        // A lone look-alike labelled like ECK, or like the operator: Review.
        let eck_labels = json!({ "common.k8s.elastic.co/type": "elasticsearch", "elasticsearch.k8s.elastic.co/cluster-name": "evil" });
        let lone = svc(
            "team-a",
            "evil-es-http",
            eck_labels.clone(),
            ("https", 9200),
            json!({}),
        );
        let found = pick_services(&[lone], &Verified::new());
        assert_eq!(
            names(&found.elasticsearch),
            Some(("team-a", "evil-es-http"))
        );
        assert!(!found.elasticsearch_one_click);
        let lone = svc(
            "team-a",
            "prometheus-operated",
            json!({ "operated-prometheus": "true" }),
            ("http-web", 9090),
            json!({}),
        );
        assert!(!pick_services(&[lone], &Verified::new()).prometheus_one_click);

        // An unverified look-alike in a well-known namespace ranks above
        // others, but a verified owner elsewhere ranks first.
        let services = vec![
            svc(
                "search",
                "logs-es-http",
                json!({ "app": "es" }),
                ("https", 9200),
                eck_owner(),
            ),
            svc(
                "logging",
                "fake-es-http",
                eck_labels,
                ("https", 9200),
                json!({}),
            ),
            svc("aaa", "elasticsearch", json!({}), ("http", 9200), json!({})),
        ];
        let found = pick_services(&services, &Verified::new());
        assert_eq!(
            names(&found.elasticsearch),
            Some(("logging", "fake-es-http"))
        );
        let found = pick_services(
            &services,
            &verified(&[("Elasticsearch", "search", "logs-es-http")]),
        );
        assert_eq!(
            names(&found.elasticsearch),
            Some(("search", "logs-es-http"))
        );
        // Verified, but other Elasticsearch candidates exist: Review.
        assert!(!found.elasticsearch_one_click);
    }

    #[test]
    fn a_verified_owner_with_a_second_candidate_needs_a_review() {
        let mut services = managed_prometheus(Some(true), "kps-prometheus");
        services.push(svc(
            "team-a",
            "elasticsearch",
            json!({}),
            ("http", 9200),
            json!({}),
        ));
        // Same selector label, but another namespace: not the same instance.
        services.push(svc(
            "team-a",
            "prom",
            json!({ "app": "prometheus" }),
            ("web", 9090),
            json!({ "selector": { "operator.prometheus.io/name": "kps-prometheus" } }),
        ));
        let found = pick_services(&services, &real_owners());
        assert_eq!(
            names(&found.elasticsearch),
            Some(("logging", "quickstart-es-http"))
        );
        assert_eq!(
            names(&found.prometheus),
            Some(("monitoring", "prometheus-operated"))
        );
        assert!(!found.elasticsearch_one_click && !found.prometheus_one_click);
        // The web UIs never come from another namespace.
        let services = vec![
            svc(
                "team-a",
                "elasticsearch",
                json!({}),
                ("http", 9200),
                json!({}),
            ),
            svc(
                "logging",
                "kibana",
                json!({ "app.kubernetes.io/name": "kibana" }),
                ("http", 5601),
                json!({}),
            ),
        ];
        assert_eq!(pick_services(&services, &Verified::new()).kibana, None);
    }

    /// A kube client whose API server answers `respond(path)`, recording
    /// the paths it was asked for.
    fn api_server(
        respond: impl Fn(&str) -> (u16, Value) + Send + 'static,
    ) -> (Client, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use http::{Request, Response};
        use kube::client::Body;
        let paths = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = paths.clone();
        let (service, handle) = tower_test::mock::pair::<Request<Body>, Response<Body>>();
        tokio::spawn(async move {
            let mut handle = std::pin::pin!(handle);
            while let Some((request, send)) = handle.next_request().await {
                let path = request.uri().path().to_string();
                let (status, body) = respond(&path);
                seen.lock().expect("paths").push(path);
                let response = Response::builder()
                    .status(status)
                    .body(Body::from(body.to_string().into_bytes()))
                    .expect("response");
                send.send_response(response);
            }
        });
        (Client::new(service, "default"), paths)
    }

    const ES_CR: &str =
        "/apis/elasticsearch.k8s.elastic.co/v1/namespaces/logging/elasticsearches/quickstart";
    const PROM_CR: &str =
        "/apis/monitoring.coreos.com/v1/namespaces/monitoring/prometheuses/kps-prometheus";

    fn not_found() -> (u16, Value) {
        (
            404,
            json!({ "kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "NotFound", "code": 404, "message": "not found" }),
        )
    }

    /// The cluster (with a Prometheus controlling its Service), and its
    /// Elasticsearch / Prometheus resources answered by `es` / `prom`.
    fn cluster_api(
        es: (u16, Value),
        prom: (u16, Value),
    ) -> (Client, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let list = json!({ "apiVersion": "v1", "kind": "ServiceList", "metadata": {}, "items": managed_prometheus(Some(true), "kps-prometheus") });
        api_server(move |path| match path {
            "/api/v1/services" => (200, list.clone()),
            ES_CR => es.clone(),
            PROM_CR => prom.clone(),
            _ => not_found(),
        })
    }

    fn resource(kind: &str, api_version: &str, name: &str, uid: &str) -> (u16, Value) {
        (
            200,
            json!({ "apiVersion": api_version, "kind": kind, "metadata": { "name": name, "uid": uid } }),
        )
    }

    #[tokio::test]
    async fn detect_all_verifies_the_claimed_owners_and_nothing_else() {
        let (client, paths) = cluster_api(
            resource(
                "Elasticsearch",
                "elasticsearch.k8s.elastic.co/v1",
                "quickstart",
                "es-uid",
            ),
            resource(
                "Prometheus",
                "monitoring.coreos.com/v1",
                "kps-prometheus",
                "prom-uid",
            ),
        );
        let found = detect_all(client).await.expect("detect");
        assert!(found.elasticsearch_one_click && found.prometheus_one_click);
        assert!(found.kibana.is_some() && found.grafana.is_some());
        // The services, then the owners claimed by the best candidates (ECK's
        // three Services claim the same Elasticsearch; only main-kind ones
        // are checked): Kubernetes API only, no secrets.
        let paths = paths.lock().expect("paths").clone();
        assert_eq!(paths[0], "/api/v1/services");
        assert!(
            paths[1..].iter().all(|p| p == ES_CR || p == PROM_CR),
            "{paths:?}"
        );
        assert!(paths.iter().all(|p| !p.contains("secrets")));
    }

    #[tokio::test]
    async fn fake_owner_references_are_not_trusted() {
        // The claimed resource does not exist (or its CRD is not installed).
        let (client, _) = cluster_api(not_found(), not_found());
        let found = detect_all(client).await.expect("detect");
        assert!(!found.elasticsearch_one_click && !found.prometheus_one_click);
        // It exists, but with another uid (a reference to a deleted or other object).
        let (client, _) = cluster_api(
            resource(
                "Elasticsearch",
                "elasticsearch.k8s.elastic.co/v1",
                "quickstart",
                "other-uid",
            ),
            resource(
                "Prometheus",
                "monitoring.coreos.com/v1",
                "kps-prometheus",
                "other-uid",
            ),
        );
        let found = detect_all(client).await.expect("detect");
        assert!(!found.elasticsearch_one_click && !found.prometheus_one_click);
        // The user may not read the resources: silently not trusted.
        let forbidden = (
            403,
            json!({ "kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "Forbidden", "code": 403, "message": "forbidden" }),
        );
        let (client, _) = cluster_api(forbidden.clone(), forbidden);
        let found = detect_all(client).await.expect("detect");
        assert!(!found.elasticsearch_one_click && !found.prometheus_one_click);
        assert_eq!(
            names(&found.prometheus),
            Some(("monitoring", "prometheus-operated"))
        );
    }

    #[tokio::test]
    async fn detect_all_gives_up_silently_when_forbidden() {
        let forbidden = json!({
            "kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "Forbidden", "code": 403,
            "message": "services is forbidden: User \"dev\" cannot list resource \"services\" at the cluster scope",
        });
        let (client, _) = api_server(move |_| (403, forbidden.clone()));
        assert_eq!(detect_all(client).await, Ok(Detected::default()));
        let (client, _) = api_server(|_| {
            (
                500,
                json!({ "kind": "Status", "code": 500, "message": "boom" }),
            )
        });
        assert!(detect_all(client).await.is_err());
    }

    #[test]
    fn owner_names_must_be_resource_names() {
        assert!(is_resource_name("quickstart"));
        assert!(is_resource_name("kps.prometheus-1"));
        for bad in ["", "a/b", "..", "a..b", "Up", "-a"] {
            assert!(!is_resource_name(bad), "{bad}");
        }
    }
}
