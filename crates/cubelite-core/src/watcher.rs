//! Watch streaming for Kubernetes resources.
//!
//! This module provides [`ResourceWatcher`], which wraps a [`kube::Client`] and
//! emits a stream of [`WatchEvent`] items as resources change in the cluster.
//!
//! ## Example
//!
//! ```no_run
//! use cubelite_core::{ResourceWatcher, ResourceType};
//! use futures::StreamExt;
//!
//! # async fn example(client: kube::Client) {
//! let watcher = ResourceWatcher::new(client);
//! let mut stream = watcher.watch_resources(Some("default"), ResourceType::Pod);
//! while let Some(event) = stream.next().await {
//!     println!("{event:?}");
//! }
//! # }
//! ```

use std::pin::Pin;

use futures::{Stream, StreamExt};
use k8s_openapi::api::{
    apps::v1::Deployment,
    core::v1::{ConfigMap, Namespace, Pod, Secret, Service},
    networking::v1::Ingress,
};
use kube::{runtime::watcher, Api, Client};
use serde::{Deserialize, Serialize};

use crate::resources::{
    ConfigMapInfo, ContainerInfo, DeploymentConditionInfo, DeploymentInfo, IngressInfo,
    NamespaceInfo, PodInfo, SecretInfo, ServiceInfo,
};

/// Selects which Kubernetes resource type to watch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceType {
    /// Watch pods.
    Pod,
    /// Watch namespaces.
    Namespace,
    /// Watch deployments.
    Deployment,
    /// Watch services.
    Service,
    /// Watch ingresses.
    Ingress,
    /// Watch config maps.
    ConfigMap,
    /// Watch secrets.
    Secret,
}

/// A Kubernetes resource payload, discriminated by type.
///
/// Wraps the lightweight `*Info` structs from [`crate::resources`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum ResourceInfo {
    /// A pod resource.
    Pod(PodInfo),
    /// A namespace resource.
    Namespace(NamespaceInfo),
    /// A deployment resource.
    Deployment(DeploymentInfo),
    /// A service resource.
    Service(ServiceInfo),
    /// An ingress resource.
    Ingress(IngressInfo),
    /// A config map resource.
    ConfigMap(ConfigMapInfo),
    /// A secret resource.
    Secret(SecretInfo),
}

/// A single watch event emitted from a [`ResourceWatcher`] stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", content = "payload")]
pub enum WatchEvent {
    /// A resource was created or updated (including the initial listing phase).
    Applied(ResourceInfo),
    /// A resource was deleted.
    Deleted(ResourceInfo),
    /// A watch error occurred. The inner string contains the error description.
    Error(String),
}

/// Wraps a [`kube::Client`] and exposes watch streams for Kubernetes resources.
///
/// Construct via [`ResourceWatcher::new`], then call [`watch_resources`] to
/// obtain a streaming iterator of [`WatchEvent`] items.
///
/// [`watch_resources`]: ResourceWatcher::watch_resources
pub struct ResourceWatcher {
    client: Client,
}

impl ResourceWatcher {
    /// Create a new [`ResourceWatcher`] backed by `client`.
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    /// Return a stream of [`WatchEvent`] items for the given resource type.
    ///
    /// `namespace` scopes the watch to a single namespace.  Pass `None` to
    /// watch across all namespaces (cluster-scoped watch).  Note that
    /// [`ResourceType::Namespace`] is always cluster-scoped regardless.
    ///
    /// The stream yields [`WatchEvent::Applied`] for creates/updates (including
    /// the initial list phase), [`WatchEvent::Deleted`] for deletions, and
    /// [`WatchEvent::Error`] when the underlying `kube` watcher encounters an
    /// error.  Internal lifecycle events (`Init`, `InitDone`) are suppressed.
    pub fn watch_resources(
        &self,
        namespace: Option<&str>,
        resource_type: ResourceType,
    ) -> Pin<Box<dyn Stream<Item = WatchEvent> + Send>> {
        let client = self.client.clone();
        let config = watcher::Config::default();
        // Own the namespace string so the returned stream is 'static.
        let ns = namespace.map(str::to_owned);

        match resource_type {
            ResourceType::Pod => {
                let api: Api<Pod> = match ns.as_deref() {
                    Some(n) => Api::namespaced(client, n),
                    None => Api::all(client),
                };
                Box::pin(
                    watcher::watcher(api, config).filter_map(|ev| async move {
                        map_event(ev, pod_to_info, ResourceInfo::Pod)
                    }),
                )
            }
            ResourceType::Namespace => {
                // Namespaces are cluster-scoped; the namespace argument is ignored.
                let api: Api<Namespace> = Api::all(client);
                Box::pin(watcher::watcher(api, config).filter_map(|ev| async move {
                    map_event(ev, namespace_to_info, ResourceInfo::Namespace)
                }))
            }
            ResourceType::Deployment => {
                let api: Api<Deployment> = match ns.as_deref() {
                    Some(n) => Api::namespaced(client, n),
                    None => Api::all(client),
                };
                Box::pin(watcher::watcher(api, config).filter_map(|ev| async move {
                    map_event(ev, deployment_to_info, ResourceInfo::Deployment)
                }))
            }
            ResourceType::Service => {
                let api: Api<Service> = match ns.as_deref() {
                    Some(n) => Api::namespaced(client, n),
                    None => Api::all(client),
                };
                Box::pin(watcher::watcher(api, config).filter_map(|ev| async move {
                    map_event(ev, service_to_info, ResourceInfo::Service)
                }))
            }
            ResourceType::Ingress => {
                let api: Api<Ingress> = match ns.as_deref() {
                    Some(n) => Api::namespaced(client, n),
                    None => Api::all(client),
                };
                Box::pin(watcher::watcher(api, config).filter_map(|ev| async move {
                    map_event(ev, ingress_to_info, ResourceInfo::Ingress)
                }))
            }
            ResourceType::ConfigMap => {
                let api: Api<ConfigMap> = match ns.as_deref() {
                    Some(n) => Api::namespaced(client, n),
                    None => Api::all(client),
                };
                Box::pin(watcher::watcher(api, config).filter_map(|ev| async move {
                    map_event(ev, configmap_to_info, ResourceInfo::ConfigMap)
                }))
            }
            ResourceType::Secret => {
                let api: Api<Secret> = match ns.as_deref() {
                    Some(n) => Api::namespaced(client, n),
                    None => Api::all(client),
                };
                Box::pin(watcher::watcher(api, config).filter_map(|ev| async move {
                    map_event(ev, secret_to_info, ResourceInfo::Secret)
                }))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Map a raw watcher event to a [`WatchEvent`], returning `None` for internal
/// lifecycle bookkeeping events (`Init`, `InitDone`).
fn map_event<K, T, F, W>(
    event: Result<watcher::Event<K>, watcher::Error>,
    convert: F,
    wrap: W,
) -> Option<WatchEvent>
where
    F: Fn(K) -> Option<T>,
    W: Fn(T) -> ResourceInfo,
{
    match event {
        Ok(watcher::Event::Apply(resource)) | Ok(watcher::Event::InitApply(resource)) => {
            convert(resource).map(|info| WatchEvent::Applied(wrap(info)))
        }
        Ok(watcher::Event::Delete(resource)) => {
            convert(resource).map(|info| WatchEvent::Deleted(wrap(info)))
        }
        Ok(watcher::Event::Init) | Ok(watcher::Event::InitDone) => None,
        Err(e) => Some(WatchEvent::Error(e.to_string())),
    }
}

/// Convert a raw [`Pod`] object into a [`PodInfo`], returning `None` if the
/// pod has no name (which is invalid in a well-formed cluster response).
pub(crate) fn pod_to_info(pod: Pod) -> Option<PodInfo> {
    let name = pod.metadata.name.clone()?;
    let namespace = pod.metadata.namespace.clone().unwrap_or_default();
    let labels = pod.metadata.labels.clone().unwrap_or_default();
    let creation = creation_timestamp(&pod.metadata);

    let spec = pod.spec.unwrap_or_default();
    let status = pod.status.unwrap_or_default();
    let statuses = status.container_statuses.unwrap_or_default();

    let containers: Vec<ContainerInfo> = spec
        .containers
        .iter()
        .map(|c| ContainerInfo {
            name: c.name.clone(),
            image: c.image.clone(),
            ready: statuses.iter().any(|cs| cs.name == c.name && cs.ready),
        })
        .collect();

    let total_containers = containers.len() as i32;
    let ready_containers = containers.iter().filter(|c| c.ready).count() as i32;
    let restarts = statuses.iter().map(|cs| cs.restart_count).sum();

    Some(PodInfo {
        name,
        namespace,
        phase: status.phase,
        ready: total_containers > 0 && ready_containers == total_containers,
        restarts,
        ready_containers,
        total_containers,
        node: spec.node_name,
        pod_ip: status.pod_ip,
        qos_class: status.qos_class,
        containers,
        labels,
        creation_timestamp: creation,
    })
}

/// Convert a raw [`Namespace`] object into a [`NamespaceInfo`], returning
/// `None` if there is no name.
pub(crate) fn namespace_to_info(ns: Namespace) -> Option<NamespaceInfo> {
    let name = ns.metadata.name?;
    let phase = ns.status.as_ref().and_then(|s| s.phase.clone());
    Some(NamespaceInfo { name, phase })
}

/// RFC 3339 creation timestamp from object metadata, if present.
fn creation_timestamp(
    meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta,
) -> Option<String> {
    meta.creation_timestamp.as_ref().map(|t| t.0.to_rfc3339())
}

/// Convert a raw [`Service`] object into a [`ServiceInfo`], returning `None`
/// if there is no name.
pub(crate) fn service_to_info(s: Service) -> Option<ServiceInfo> {
    let name = s.metadata.name.clone()?;
    let namespace = s.metadata.namespace.clone().unwrap_or_default();
    let creation = creation_timestamp(&s.metadata);
    let spec = s.spec.unwrap_or_default();

    let mut external_ips: Vec<String> = spec.external_ips.unwrap_or_default();
    if let Some(lb) = s.status.and_then(|st| st.load_balancer) {
        for ing in lb.ingress.unwrap_or_default() {
            if let Some(ip) = ing.ip {
                external_ips.push(ip);
            } else if let Some(host) = ing.hostname {
                external_ips.push(host);
            }
        }
    }

    let ports = spec
        .ports
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let protocol = p.protocol.unwrap_or_else(|| "TCP".to_string());
            match p.node_port {
                Some(np) => format!("{}:{np}/{protocol}", p.port),
                None => format!("{}/{protocol}", p.port),
            }
        })
        .collect();

    Some(ServiceInfo {
        name,
        namespace,
        service_type: spec.type_,
        cluster_ip: spec.cluster_ip,
        external_ips,
        ports,
        creation_timestamp: creation,
    })
}

/// Convert a raw [`Ingress`] object into an [`IngressInfo`], returning `None`
/// if there is no name.
pub(crate) fn ingress_to_info(i: Ingress) -> Option<IngressInfo> {
    let name = i.metadata.name.clone()?;
    let namespace = i.metadata.namespace.clone().unwrap_or_default();
    let creation = creation_timestamp(&i.metadata);

    let (class, hosts, tls) = match i.spec {
        Some(spec) => {
            let hosts = spec
                .rules
                .unwrap_or_default()
                .into_iter()
                .filter_map(|r| r.host)
                .collect();
            let tls = spec.tls.is_some_and(|t| !t.is_empty());
            (spec.ingress_class_name, hosts, tls)
        }
        None => (None, Vec::new(), false),
    };

    let addresses = i
        .status
        .and_then(|st| st.load_balancer)
        .and_then(|lb| lb.ingress)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|ing| ing.ip.or(ing.hostname))
        .collect();

    Some(IngressInfo {
        name,
        namespace,
        class,
        hosts,
        addresses,
        tls,
        creation_timestamp: creation,
    })
}

/// Convert a raw [`ConfigMap`] object into a [`ConfigMapInfo`], returning
/// `None` if there is no name.
pub(crate) fn configmap_to_info(cm: ConfigMap) -> Option<ConfigMapInfo> {
    let name = cm.metadata.name.clone()?;
    let namespace = cm.metadata.namespace.clone().unwrap_or_default();
    let creation = creation_timestamp(&cm.metadata);
    let data_count = cm.data.map_or(0, |d| d.len()) + cm.binary_data.map_or(0, |d| d.len());

    Some(ConfigMapInfo {
        name,
        namespace,
        data_count,
        creation_timestamp: creation,
    })
}

/// Convert a raw [`Secret`] object into a [`SecretInfo`], returning `None`
/// if there is no name.
///
/// Values are decoded to UTF-8 locally; non-UTF-8 payloads are replaced with
/// a `"(binary)"` placeholder so raw bytes never cross the IPC boundary.
pub(crate) fn secret_to_info(s: Secret) -> Option<SecretInfo> {
    let name = s.metadata.name.clone()?;
    let namespace = s.metadata.namespace.clone().unwrap_or_default();
    let creation = creation_timestamp(&s.metadata);

    let mut data = std::collections::BTreeMap::new();
    for (key, value) in s.data.unwrap_or_default() {
        let decoded = String::from_utf8(value.0).unwrap_or_else(|_| "(binary)".to_string());
        data.insert(key, decoded);
    }
    for (key, value) in s.string_data.unwrap_or_default() {
        data.insert(key, value);
    }

    Some(SecretInfo {
        name,
        namespace,
        secret_type: s.type_,
        data,
        creation_timestamp: creation,
    })
}

/// Convert a raw [`Deployment`] object into a [`DeploymentInfo`], returning
/// `None` if there is no name.
pub(crate) fn deployment_to_info(d: Deployment) -> Option<DeploymentInfo> {
    let name = d.metadata.name.clone()?;
    let namespace = d.metadata.namespace.clone().unwrap_or_default();
    let creation = creation_timestamp(&d.metadata);

    let (replicas, images, selector, strategy) = match d.spec {
        Some(spec) => {
            let images = spec
                .template
                .spec
                .as_ref()
                .map(|ps| {
                    ps.containers
                        .iter()
                        .filter_map(|c| c.image.clone())
                        .collect()
                })
                .unwrap_or_default();
            let selector = spec.selector.match_labels.unwrap_or_default();
            let strategy = spec.strategy.and_then(|s| s.type_);
            (spec.replicas.unwrap_or(0), images, selector, strategy)
        }
        None => (0, Vec::new(), Default::default(), None),
    };

    let (ready_replicas, conditions) = match d.status {
        Some(status) => {
            let conditions = status
                .conditions
                .unwrap_or_default()
                .into_iter()
                .map(|c| DeploymentConditionInfo {
                    condition_type: c.type_,
                    status: c.status,
                    reason: c.reason,
                })
                .collect();
            (status.ready_replicas.unwrap_or(0), conditions)
        }
        None => (0, Vec::new()),
    };

    Some(DeploymentInfo {
        name,
        namespace,
        replicas,
        ready_replicas,
        images,
        selector,
        strategy,
        conditions,
        creation_timestamp: creation,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // ResourceType serialization
    // ------------------------------------------------------------------

    #[test]
    fn resource_type_roundtrip() {
        let cases = [
            (ResourceType::Pod, "\"pod\""),
            (ResourceType::Namespace, "\"namespace\""),
            (ResourceType::Deployment, "\"deployment\""),
            (ResourceType::Service, "\"service\""),
            (ResourceType::Ingress, "\"ingress\""),
            (ResourceType::ConfigMap, "\"configmap\""),
            (ResourceType::Secret, "\"secret\""),
        ];
        for (rt, expected_json) in cases {
            let json = serde_json::to_string(&rt).unwrap();
            assert_eq!(json, expected_json, "serialized form for {rt:?}");
            let back: ResourceType = serde_json::from_str(&json).unwrap();
            assert_eq!(back, rt, "deserialized form for {rt:?}");
        }
    }

    // ------------------------------------------------------------------
    // WatchEvent serialization
    // ------------------------------------------------------------------

    #[test]
    fn watch_event_applied_pod_serialization() {
        let event = WatchEvent::Applied(ResourceInfo::Pod(PodInfo {
            name: "test-pod".to_string(),
            namespace: "default".to_string(),
            phase: Some("Running".to_string()),
            ready: true,
            restarts: 0,
            ..Default::default()
        }));

        let json = serde_json::to_string(&event).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(v["event"], "Applied");
        assert_eq!(v["payload"]["type"], "Pod");
        assert_eq!(v["payload"]["data"]["name"], "test-pod");
        assert_eq!(v["payload"]["data"]["namespace"], "default");
        assert_eq!(v["payload"]["data"]["ready"], true);
    }

    #[test]
    fn watch_event_error_serialization() {
        let event = WatchEvent::Error("connection refused".to_string());
        let json = serde_json::to_string(&event).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["event"], "Error");
        assert_eq!(v["payload"], "connection refused");
    }

    // ------------------------------------------------------------------
    // Conversion functions
    // ------------------------------------------------------------------

    #[test]
    fn pod_to_info_full() {
        use k8s_openapi::api::core::v1::{Container, ContainerStatus, Pod, PodSpec, PodStatus};
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
        use std::collections::BTreeMap;

        let pod = Pod {
            metadata: ObjectMeta {
                name: Some("my-pod".to_string()),
                namespace: Some("kube-system".to_string()),
                labels: Some(BTreeMap::from([("app".to_string(), "my".to_string())])),
                ..Default::default()
            },
            spec: Some(PodSpec {
                node_name: Some("node-1".to_string()),
                containers: vec![Container {
                    name: "main".to_string(),
                    image: Some("nginx:1.27".to_string()),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            status: Some(PodStatus {
                phase: Some("Running".to_string()),
                pod_ip: Some("10.1.2.3".to_string()),
                qos_class: Some("Burstable".to_string()),
                container_statuses: Some(vec![ContainerStatus {
                    name: "main".to_string(),
                    ready: true,
                    restart_count: 3,
                    ..Default::default()
                }]),
                ..Default::default()
            }),
        };

        let info = pod_to_info(pod).unwrap();
        assert_eq!(info.name, "my-pod");
        assert_eq!(info.namespace, "kube-system");
        assert_eq!(info.phase.as_deref(), Some("Running"));
        assert!(info.ready);
        assert_eq!(info.restarts, 3);
        assert_eq!(info.ready_containers, 1);
        assert_eq!(info.total_containers, 1);
        assert_eq!(info.node.as_deref(), Some("node-1"));
        assert_eq!(info.pod_ip.as_deref(), Some("10.1.2.3"));
        assert_eq!(info.qos_class.as_deref(), Some("Burstable"));
        assert_eq!(info.containers.len(), 1);
        assert_eq!(info.containers[0].image.as_deref(), Some("nginx:1.27"));
        assert_eq!(info.labels.get("app").map(String::as_str), Some("my"));
    }

    #[test]
    fn pod_to_info_no_name_returns_none() {
        let pod = k8s_openapi::api::core::v1::Pod::default();
        assert!(pod_to_info(pod).is_none());
    }

    #[test]
    fn namespace_to_info_conversion() {
        use k8s_openapi::api::core::v1::{Namespace, NamespaceStatus};
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

        let ns = Namespace {
            metadata: ObjectMeta {
                name: Some("production".to_string()),
                ..Default::default()
            },
            status: Some(NamespaceStatus {
                phase: Some("Active".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };

        let info = namespace_to_info(ns).unwrap();
        assert_eq!(info.name, "production");
        assert_eq!(info.phase.as_deref(), Some("Active"));
    }

    #[test]
    fn service_to_info_conversion() {
        use k8s_openapi::api::core::v1::{
            LoadBalancerIngress, LoadBalancerStatus, Service, ServicePort, ServiceSpec,
            ServiceStatus,
        };
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

        let svc = Service {
            metadata: ObjectMeta {
                name: Some("web".to_string()),
                namespace: Some("default".to_string()),
                ..Default::default()
            },
            spec: Some(ServiceSpec {
                type_: Some("LoadBalancer".to_string()),
                cluster_ip: Some("10.0.0.1".to_string()),
                ports: Some(vec![
                    ServicePort {
                        port: 80,
                        ..Default::default()
                    },
                    ServicePort {
                        port: 443,
                        node_port: Some(30443),
                        protocol: Some("TCP".to_string()),
                        ..Default::default()
                    },
                ]),
                ..Default::default()
            }),
            status: Some(ServiceStatus {
                load_balancer: Some(LoadBalancerStatus {
                    ingress: Some(vec![LoadBalancerIngress {
                        ip: Some("203.0.113.9".to_string()),
                        ..Default::default()
                    }]),
                }),
                ..Default::default()
            }),
        };

        let info = service_to_info(svc).unwrap();
        assert_eq!(info.name, "web");
        assert_eq!(info.service_type.as_deref(), Some("LoadBalancer"));
        assert_eq!(info.cluster_ip.as_deref(), Some("10.0.0.1"));
        assert_eq!(info.external_ips, vec!["203.0.113.9"]);
        assert_eq!(info.ports, vec!["80/TCP", "443:30443/TCP"]);
    }

    #[test]
    fn ingress_to_info_conversion() {
        use k8s_openapi::api::networking::v1::{Ingress, IngressRule, IngressSpec, IngressTLS};
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

        let ing = Ingress {
            metadata: ObjectMeta {
                name: Some("web".to_string()),
                namespace: Some("default".to_string()),
                ..Default::default()
            },
            spec: Some(IngressSpec {
                ingress_class_name: Some("nginx".to_string()),
                rules: Some(vec![IngressRule {
                    host: Some("app.example.com".to_string()),
                    ..Default::default()
                }]),
                tls: Some(vec![IngressTLS::default()]),
                ..Default::default()
            }),
            status: None,
        };

        let info = ingress_to_info(ing).unwrap();
        assert_eq!(info.class.as_deref(), Some("nginx"));
        assert_eq!(info.hosts, vec!["app.example.com"]);
        assert!(info.tls);
        assert!(info.addresses.is_empty());
    }

    #[test]
    fn configmap_to_info_counts_data_and_binary_data() {
        use k8s_openapi::api::core::v1::ConfigMap;
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
        use k8s_openapi::ByteString;
        use std::collections::BTreeMap;

        let cm = ConfigMap {
            metadata: ObjectMeta {
                name: Some("settings".to_string()),
                ..Default::default()
            },
            data: Some(BTreeMap::from([(
                "config.yaml".to_string(),
                "a: 1".to_string(),
            )])),
            binary_data: Some(BTreeMap::from([(
                "blob".to_string(),
                ByteString(vec![0xff]),
            )])),
            ..Default::default()
        };

        let info = configmap_to_info(cm).unwrap();
        assert_eq!(info.data_count, 2);
    }

    #[test]
    fn secret_to_info_decodes_utf8_and_masks_binary() {
        use k8s_openapi::api::core::v1::Secret;
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
        use k8s_openapi::ByteString;
        use std::collections::BTreeMap;

        let secret = Secret {
            metadata: ObjectMeta {
                name: Some("creds".to_string()),
                namespace: Some("default".to_string()),
                ..Default::default()
            },
            type_: Some("Opaque".to_string()),
            data: Some(BTreeMap::from([
                ("password".to_string(), ByteString(b"hunter2".to_vec())),
                ("cert".to_string(), ByteString(vec![0xff, 0xfe])),
            ])),
            ..Default::default()
        };

        let info = secret_to_info(secret).unwrap();
        assert_eq!(info.secret_type.as_deref(), Some("Opaque"));
        assert_eq!(
            info.data.get("password").map(String::as_str),
            Some("hunter2")
        );
        assert_eq!(info.data.get("cert").map(String::as_str), Some("(binary)"));
    }

    #[test]
    fn deployment_to_info_conversion() {
        use k8s_openapi::api::apps::v1::{Deployment, DeploymentSpec, DeploymentStatus};
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

        let d = Deployment {
            metadata: ObjectMeta {
                name: Some("my-app".to_string()),
                namespace: Some("staging".to_string()),
                ..Default::default()
            },
            spec: Some(DeploymentSpec {
                replicas: Some(3),
                ..Default::default()
            }),
            status: Some(DeploymentStatus {
                ready_replicas: Some(2),
                ..Default::default()
            }),
        };

        let info = deployment_to_info(d).unwrap();
        assert_eq!(info.name, "my-app");
        assert_eq!(info.namespace, "staging");
        assert_eq!(info.replicas, 3);
        assert_eq!(info.ready_replicas, 2);
    }

    #[test]
    fn deployment_to_info_enriched_fields() {
        use k8s_openapi::api::apps::v1::{
            Deployment, DeploymentCondition, DeploymentSpec, DeploymentStatus, DeploymentStrategy,
        };
        use k8s_openapi::api::core::v1::{Container, PodTemplateSpec};
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};
        use std::collections::BTreeMap;

        let d = Deployment {
            metadata: ObjectMeta {
                name: Some("api".to_string()),
                namespace: Some("default".to_string()),
                ..Default::default()
            },
            spec: Some(DeploymentSpec {
                replicas: Some(2),
                selector: LabelSelector {
                    match_labels: Some(BTreeMap::from([("app".to_string(), "api".to_string())])),
                    ..Default::default()
                },
                strategy: Some(DeploymentStrategy {
                    type_: Some("RollingUpdate".to_string()),
                    ..Default::default()
                }),
                template: PodTemplateSpec {
                    spec: Some(k8s_openapi::api::core::v1::PodSpec {
                        containers: vec![Container {
                            name: "api".to_string(),
                            image: Some("ghcr.io/x/api:2.1".to_string()),
                            ..Default::default()
                        }],
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                ..Default::default()
            }),
            status: Some(DeploymentStatus {
                ready_replicas: Some(2),
                conditions: Some(vec![DeploymentCondition {
                    type_: "Available".to_string(),
                    status: "True".to_string(),
                    reason: Some("MinimumReplicasAvailable".to_string()),
                    ..Default::default()
                }]),
                ..Default::default()
            }),
        };

        let info = deployment_to_info(d).unwrap();
        assert_eq!(info.images, vec!["ghcr.io/x/api:2.1"]);
        assert_eq!(info.selector.get("app").map(String::as_str), Some("api"));
        assert_eq!(info.strategy.as_deref(), Some("RollingUpdate"));
        assert_eq!(info.conditions.len(), 1);
        assert_eq!(info.conditions[0].condition_type, "Available");
        assert_eq!(info.conditions[0].status, "True");
    }
}
