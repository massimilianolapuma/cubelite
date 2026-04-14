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
    core::v1::{Namespace, Pod},
};
use kube::{runtime::watcher, Api, Client};
use serde::{Deserialize, Serialize};

use crate::resources::{DeploymentInfo, NamespaceInfo, PodInfo};

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
fn pod_to_info(pod: Pod) -> Option<PodInfo> {
    let name = pod.metadata.name?;
    let namespace = pod.metadata.namespace.unwrap_or_default();
    let phase = pod.status.as_ref().and_then(|s| s.phase.clone());
    let container_statuses = pod
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_deref())
        .unwrap_or(&[]);
    let ready = container_statuses.iter().all(|cs| cs.ready);
    let restarts = container_statuses.iter().map(|cs| cs.restart_count).sum();
    Some(PodInfo {
        name,
        namespace,
        phase,
        ready,
        restarts,
    })
}

/// Convert a raw [`Namespace`] object into a [`NamespaceInfo`], returning
/// `None` if there is no name.
fn namespace_to_info(ns: Namespace) -> Option<NamespaceInfo> {
    let name = ns.metadata.name?;
    let phase = ns.status.as_ref().and_then(|s| s.phase.clone());
    Some(NamespaceInfo { name, phase })
}

/// Convert a raw [`Deployment`] object into a [`DeploymentInfo`], returning
/// `None` if there is no name.
fn deployment_to_info(d: Deployment) -> Option<DeploymentInfo> {
    let name = d.metadata.name?;
    let namespace = d.metadata.namespace.unwrap_or_default();
    let replicas = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
    let ready_replicas = d
        .status
        .as_ref()
        .and_then(|s| s.ready_replicas)
        .unwrap_or(0);
    Some(DeploymentInfo {
        name,
        namespace,
        replicas,
        ready_replicas,
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
        use k8s_openapi::api::core::v1::{ContainerStatus, Pod, PodStatus};
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

        let pod = Pod {
            metadata: ObjectMeta {
                name: Some("my-pod".to_string()),
                namespace: Some("kube-system".to_string()),
                ..Default::default()
            },
            status: Some(PodStatus {
                phase: Some("Running".to_string()),
                container_statuses: Some(vec![ContainerStatus {
                    name: "main".to_string(),
                    ready: true,
                    restart_count: 3,
                    ..Default::default()
                }]),
                ..Default::default()
            }),
            ..Default::default()
        };

        let info = pod_to_info(pod).unwrap();
        assert_eq!(info.name, "my-pod");
        assert_eq!(info.namespace, "kube-system");
        assert_eq!(info.phase.as_deref(), Some("Running"));
        assert!(info.ready);
        assert_eq!(info.restarts, 3);
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
}
