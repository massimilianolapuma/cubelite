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
    apps::v1::{Deployment, StatefulSet},
    batch::v1::{CronJob, Job},
    core::v1::{ConfigMap, Namespace, Node, PersistentVolumeClaim, Pod, Secret, Service},
    networking::v1::Ingress,
};
use kube::{runtime::watcher, Api, Client};
use serde::{Deserialize, Serialize};

use crate::resources::{
    ConfigMapInfo, ContainerInfo, CronJobInfo, DeploymentConditionInfo, DeploymentInfo,
    IngressInfo, JobInfo, NamespaceInfo, NodeInfo, PodInfo, PvcInfo, SecretInfo, ServiceInfo,
    StatefulSetInfo,
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

/// Extract picker-ready [`ContainerDetail`] rows from a raw [`Pod`].
///
/// Order: app containers (spec order), native sidecars (init containers
/// with `restartPolicy: Always`), plain init containers.
pub fn pod_to_container_details(pod: &Pod) -> Vec<crate::resources::ContainerDetail> {
    use k8s_openapi::api::core::v1::ContainerStatus;

    let spec = pod.spec.clone().unwrap_or_default();
    let status = pod.status.clone().unwrap_or_default();
    let statuses: Vec<ContainerStatus> = status
        .container_statuses
        .unwrap_or_default()
        .into_iter()
        .chain(status.init_container_statuses.unwrap_or_default())
        .collect();

    let detail = |name: &str, init: bool, sidecar: bool| {
        let cs = statuses.iter().find(|s| s.name == name);
        let raw_state = cs.and_then(|s| s.state.clone()).unwrap_or_default();
        let (state, state_reason) = if raw_state.running.is_some() {
            ("running".to_string(), None)
        } else if let Some(terminated) = raw_state.terminated {
            ("terminated".to_string(), terminated.reason)
        } else {
            (
                "waiting".to_string(),
                raw_state.waiting.and_then(|w| w.reason),
            )
        };
        let last_terminated = cs
            .and_then(|s| s.last_state.clone())
            .and_then(|s| s.terminated);
        crate::resources::ContainerDetail {
            name: name.to_string(),
            init: init && !sidecar,
            sidecar,
            restarts: cs.map(|s| s.restart_count).unwrap_or(0),
            ready: cs.map(|s| s.ready).unwrap_or(false),
            state,
            state_reason,
            last_terminated_reason: last_terminated.as_ref().and_then(|t| t.reason.clone()),
            last_terminated_at: last_terminated
                .as_ref()
                .and_then(|t| t.finished_at.as_ref().map(|ts| ts.0.to_rfc3339())),
        }
    };

    let app: Vec<_> = spec
        .containers
        .iter()
        .map(|c| detail(&c.name, false, false))
        .collect();
    let init_containers = spec.init_containers.unwrap_or_default();
    let (sidecars, plain_init): (Vec<_>, Vec<_>) = init_containers
        .iter()
        .partition(|c| c.restart_policy.as_deref() == Some("Always"));
    let sidecars: Vec<_> = sidecars
        .iter()
        .map(|c| detail(&c.name, true, true))
        .collect();
    let plain_init: Vec<_> = plain_init
        .iter()
        .map(|c| detail(&c.name, true, false))
        .collect();

    app.into_iter().chain(sidecars).chain(plain_init).collect()
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

/// Convert a raw [`Job`] object into a [`JobInfo`], returning `None` if
/// there is no name.
pub(crate) fn job_to_info(j: Job) -> Option<JobInfo> {
    let name = j.metadata.name.clone()?;
    let namespace = j.metadata.namespace.clone().unwrap_or_default();
    let creation = creation_timestamp(&j.metadata);
    let completions = j.spec.as_ref().and_then(|s| s.completions).unwrap_or(1);
    let (succeeded, active, failed) = j
        .status
        .map(|st| {
            (
                st.succeeded.unwrap_or(0),
                st.active.unwrap_or(0),
                st.failed.unwrap_or(0),
            )
        })
        .unwrap_or((0, 0, 0));
    Some(JobInfo {
        name,
        namespace,
        completions,
        succeeded,
        active,
        failed,
        creation_timestamp: creation,
    })
}

/// Convert a raw [`CronJob`] object into a [`CronJobInfo`], returning `None`
/// if there is no name.
pub(crate) fn cronjob_to_info(cj: CronJob) -> Option<CronJobInfo> {
    let name = cj.metadata.name.clone()?;
    let namespace = cj.metadata.namespace.clone().unwrap_or_default();
    let creation = creation_timestamp(&cj.metadata);
    let (schedule, suspend) = cj
        .spec
        .map(|s| (s.schedule, s.suspend.unwrap_or(false)))
        .unwrap_or_default();
    let (active, last_schedule) = cj
        .status
        .map(|st| {
            (
                st.active.map(|a| a.len() as i32).unwrap_or(0),
                st.last_schedule_time.map(|t| t.0.to_rfc3339()),
            )
        })
        .unwrap_or((0, None));
    Some(CronJobInfo {
        name,
        namespace,
        schedule,
        suspend,
        active,
        last_schedule,
        creation_timestamp: creation,
    })
}

/// Convert a raw [`StatefulSet`] object into a [`StatefulSetInfo`],
/// returning `None` if there is no name.
pub(crate) fn statefulset_to_info(ss: StatefulSet) -> Option<StatefulSetInfo> {
    let name = ss.metadata.name.clone()?;
    let namespace = ss.metadata.namespace.clone().unwrap_or_default();
    let creation = creation_timestamp(&ss.metadata);
    let replicas = ss.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
    let ready_replicas = ss
        .status
        .as_ref()
        .and_then(|s| s.ready_replicas)
        .unwrap_or(0);
    Some(StatefulSetInfo {
        name,
        namespace,
        replicas,
        ready_replicas,
        creation_timestamp: creation,
    })
}

/// Convert a raw [`Node`] object into a [`NodeInfo`], returning `None` if
/// there is no name.
pub(crate) fn node_to_info(n: Node) -> Option<NodeInfo> {
    let name = n.metadata.name.clone()?;
    let creation = creation_timestamp(&n.metadata);
    let roles = n
        .metadata
        .labels
        .as_ref()
        .map(|labels| {
            labels
                .keys()
                .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/"))
                .filter(|r| !r.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let ready = n
        .status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .and_then(|conds| conds.iter().find(|c| c.type_ == "Ready"))
        .map(|c| c.status == "True")
        .unwrap_or(false);
    let version = n
        .status
        .and_then(|s| s.node_info)
        .map(|ni| ni.kubelet_version);
    Some(NodeInfo {
        name,
        status: if ready { "Ready" } else { "NotReady" }.to_string(),
        roles,
        version,
        creation_timestamp: creation,
    })
}

/// Convert a raw [`PersistentVolumeClaim`] into a [`PvcInfo`], returning
/// `None` if there is no name.
pub(crate) fn pvc_to_info(pvc: PersistentVolumeClaim) -> Option<PvcInfo> {
    let name = pvc.metadata.name.clone()?;
    let namespace = pvc.metadata.namespace.clone().unwrap_or_default();
    let creation = creation_timestamp(&pvc.metadata);
    let storage_class = pvc.spec.as_ref().and_then(|s| s.storage_class_name.clone());
    let volume = pvc.spec.as_ref().and_then(|s| s.volume_name.clone());
    let (status, capacity, access_modes) = pvc
        .status
        .map(|st| {
            let capacity = st
                .capacity
                .as_ref()
                .and_then(|c| c.get("storage"))
                .map(|q| q.0.clone());
            (st.phase, capacity, st.access_modes.unwrap_or_default())
        })
        .unwrap_or((None, None, Vec::new()));
    Some(PvcInfo {
        name,
        namespace,
        status,
        volume,
        capacity,
        access_modes,
        storage_class,
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
    fn job_to_info_conversion() {
        use k8s_openapi::api::batch::v1::{Job, JobSpec, JobStatus};
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

        let j = Job {
            metadata: ObjectMeta {
                name: Some("migrate".to_string()),
                namespace: Some("default".to_string()),
                ..Default::default()
            },
            spec: Some(JobSpec {
                completions: Some(2),
                ..Default::default()
            }),
            status: Some(JobStatus {
                succeeded: Some(1),
                active: Some(1),
                ..Default::default()
            }),
        };
        let info = job_to_info(j).unwrap();
        assert_eq!(info.completions, 2);
        assert_eq!(info.succeeded, 1);
        assert_eq!(info.active, 1);
        assert_eq!(info.failed, 0);
    }

    #[test]
    fn cronjob_to_info_conversion() {
        use k8s_openapi::api::batch::v1::{CronJob, CronJobSpec, CronJobStatus};
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

        let cj = CronJob {
            metadata: ObjectMeta {
                name: Some("backup".to_string()),
                namespace: Some("ops".to_string()),
                ..Default::default()
            },
            spec: Some(CronJobSpec {
                schedule: "0 3 * * *".to_string(),
                suspend: Some(true),
                ..Default::default()
            }),
            status: Some(CronJobStatus::default()),
        };
        let info = cronjob_to_info(cj).unwrap();
        assert_eq!(info.schedule, "0 3 * * *");
        assert!(info.suspend);
        assert_eq!(info.active, 0);
    }

    #[test]
    fn statefulset_to_info_conversion() {
        use k8s_openapi::api::apps::v1::{StatefulSet, StatefulSetSpec, StatefulSetStatus};
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

        let ss = StatefulSet {
            metadata: ObjectMeta {
                name: Some("db".to_string()),
                namespace: Some("default".to_string()),
                ..Default::default()
            },
            spec: Some(StatefulSetSpec {
                replicas: Some(3),
                ..Default::default()
            }),
            status: Some(StatefulSetStatus {
                ready_replicas: Some(2),
                ..Default::default()
            }),
        };
        let info = statefulset_to_info(ss).unwrap();
        assert_eq!(info.replicas, 3);
        assert_eq!(info.ready_replicas, 2);
    }

    #[test]
    fn node_to_info_conversion() {
        use k8s_openapi::api::core::v1::{Node, NodeCondition, NodeStatus, NodeSystemInfo};
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
        use std::collections::BTreeMap;

        let n = Node {
            metadata: ObjectMeta {
                name: Some("node-1".to_string()),
                labels: Some(BTreeMap::from([(
                    "node-role.kubernetes.io/control-plane".to_string(),
                    "".to_string(),
                )])),
                ..Default::default()
            },
            status: Some(NodeStatus {
                conditions: Some(vec![NodeCondition {
                    type_: "Ready".to_string(),
                    status: "True".to_string(),
                    ..Default::default()
                }]),
                node_info: Some(NodeSystemInfo {
                    kubelet_version: "v1.30.2".to_string(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        let info = node_to_info(n).unwrap();
        assert_eq!(info.status, "Ready");
        assert_eq!(info.roles, vec!["control-plane"]);
        assert_eq!(info.version.as_deref(), Some("v1.30.2"));
    }

    #[test]
    fn pvc_to_info_conversion() {
        use k8s_openapi::api::core::v1::{
            PersistentVolumeClaim, PersistentVolumeClaimSpec, PersistentVolumeClaimStatus,
        };
        use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
        use std::collections::BTreeMap;

        let pvc = PersistentVolumeClaim {
            metadata: ObjectMeta {
                name: Some("data".to_string()),
                namespace: Some("default".to_string()),
                ..Default::default()
            },
            spec: Some(PersistentVolumeClaimSpec {
                storage_class_name: Some("fast".to_string()),
                volume_name: Some("pv-1".to_string()),
                ..Default::default()
            }),
            status: Some(PersistentVolumeClaimStatus {
                phase: Some("Bound".to_string()),
                access_modes: Some(vec!["ReadWriteOnce".to_string()]),
                capacity: Some(BTreeMap::from([(
                    "storage".to_string(),
                    Quantity("10Gi".to_string()),
                )])),
                ..Default::default()
            }),
        };
        let info = pvc_to_info(pvc).unwrap();
        assert_eq!(info.status.as_deref(), Some("Bound"));
        assert_eq!(info.capacity.as_deref(), Some("10Gi"));
        assert_eq!(info.access_modes, vec!["ReadWriteOnce"]);
        assert_eq!(info.storage_class.as_deref(), Some("fast"));
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

    /// Pod with an app container (crash-looping), a native sidecar init
    /// container and a plain init container — the handoff example pod.
    fn multi_container_pod() -> k8s_openapi::api::core::v1::Pod {
        use k8s_openapi::api::core::v1::{
            Container, ContainerState, ContainerStateRunning, ContainerStateTerminated,
            ContainerStateWaiting, ContainerStatus, Pod, PodSpec, PodStatus,
        };
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;

        let finished = Time(
            k8s_openapi::chrono::DateTime::parse_from_rfc3339("2026-07-15T10:00:00Z")
                .expect("valid ts")
                .with_timezone(&k8s_openapi::chrono::Utc),
        );

        Pod {
            spec: Some(PodSpec {
                containers: vec![Container {
                    name: "worker".into(),
                    ..Default::default()
                }],
                init_containers: Some(vec![
                    Container {
                        name: "envoy".into(),
                        restart_policy: Some("Always".into()),
                        ..Default::default()
                    },
                    Container {
                        name: "init-migrate".into(),
                        ..Default::default()
                    },
                ]),
                ..Default::default()
            }),
            status: Some(PodStatus {
                container_statuses: Some(vec![ContainerStatus {
                    name: "worker".into(),
                    ready: false,
                    restart_count: 7,
                    state: Some(ContainerState {
                        waiting: Some(ContainerStateWaiting {
                            reason: Some("CrashLoopBackOff".into()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    last_state: Some(ContainerState {
                        terminated: Some(ContainerStateTerminated {
                            reason: Some("OOMKilled".into()),
                            finished_at: Some(finished),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                }]),
                init_container_statuses: Some(vec![
                    ContainerStatus {
                        name: "envoy".into(),
                        ready: true,
                        restart_count: 0,
                        state: Some(ContainerState {
                            running: Some(ContainerStateRunning::default()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                    ContainerStatus {
                        name: "init-migrate".into(),
                        ready: false,
                        restart_count: 0,
                        state: Some(ContainerState {
                            terminated: Some(ContainerStateTerminated {
                                reason: Some("Completed".into()),
                                ..Default::default()
                            }),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                ]),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn container_details_orders_app_sidecar_then_init() {
        let details = pod_to_container_details(&multi_container_pod());
        let names: Vec<_> = details.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["worker", "envoy", "init-migrate"]);
    }

    #[test]
    fn container_details_flags_sidecar_and_init() {
        let details = pod_to_container_details(&multi_container_pod());
        let envoy = &details[1];
        assert!(envoy.sidecar);
        assert!(!envoy.init);
        assert_eq!(envoy.state, "running");
        let init = &details[2];
        assert!(init.init);
        assert!(!init.sidecar);
        assert_eq!(init.state, "terminated");
        assert_eq!(init.state_reason.as_deref(), Some("Completed"));
    }

    #[test]
    fn container_details_maps_state_restarts_and_last_termination() {
        let details = pod_to_container_details(&multi_container_pod());
        let worker = &details[0];
        assert_eq!(worker.restarts, 7);
        assert_eq!(worker.state, "waiting");
        assert_eq!(worker.state_reason.as_deref(), Some("CrashLoopBackOff"));
        assert_eq!(worker.last_terminated_reason.as_deref(), Some("OOMKilled"));
        assert_eq!(
            worker.last_terminated_at.as_deref(),
            Some("2026-07-15T10:00:00+00:00")
        );
    }

    #[test]
    fn container_details_missing_status_defaults_to_waiting() {
        use k8s_openapi::api::core::v1::{Container, Pod, PodSpec};
        let pod = Pod {
            spec: Some(PodSpec {
                containers: vec![Container {
                    name: "app".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        };
        let details = pod_to_container_details(&pod);
        assert_eq!(details.len(), 1);
        assert_eq!(details[0].state, "waiting");
        assert_eq!(details[0].restarts, 0);
        assert!(!details[0].ready);
    }
}
