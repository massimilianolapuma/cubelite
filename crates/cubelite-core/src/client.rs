//! Async Kubernetes client wrapper built on top of `kube-rs`.
//!
//! [`KubeClient`] wraps a configured `kube::Client` and exposes high-level
//! methods for listing the most common Kubernetes resources.

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{ConfigMap, Event, Namespace, Pod, Secret, Service};
use k8s_openapi::api::networking::v1::Ingress;
use kube::{
    api::{DeleteParams, Patch, PatchParams},
    config::{KubeConfigOptions, Kubeconfig},
    Api, Client, Config,
};
use std::path::Path;

use crate::{
    error::KubeconfigError,
    resources::{
        ConfigMapInfo, DeploymentInfo, EventInfo, IngressInfo, NamespaceInfo, PodInfo, SecretInfo,
        ServiceInfo,
    },
    watcher::{
        configmap_to_info, deployment_to_info, ingress_to_info, namespace_to_info, pod_to_info,
        secret_to_info, service_to_info,
    },
};

/// An async Kubernetes client pre-configured from a kubeconfig file.
///
/// Use [`KubeClient::new`] to construct an instance, then call the async
/// `list_*` methods to query cluster resources.  Use [`KubeClient::client`]
/// to obtain the underlying [`Client`] for use with [`crate::ResourceWatcher`].
pub struct KubeClient {
    inner: Client,
}

impl KubeClient {
    /// Return a clone of the underlying [`kube::Client`].
    ///
    /// The returned client shares the same connection pool and configuration.
    /// Use it to construct a [`crate::ResourceWatcher`].
    pub fn client(&self) -> Client {
        self.inner.clone()
    }

    /// Build a [`KubeClient`] from the kubeconfig at `path`.
    ///
    /// `context` selects a named context; when `None` the file's
    /// `current-context` is used.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError`] when the file cannot be read, parsed, or
    /// when the client cannot be initialised from the resulting config.
    pub async fn new(path: &Path, context: Option<&str>) -> Result<Self, KubeconfigError> {
        let raw = tokio::fs::read_to_string(path)
            .await
            .map_err(|source| KubeconfigError::Io { source })?;

        let kubeconfig: Kubeconfig =
            serde_yaml::from_str(&raw).map_err(|source| KubeconfigError::ParseError { source })?;

        let options = KubeConfigOptions {
            context: context.map(str::to_string),
            ..Default::default()
        };

        let config = Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .map_err(|e| KubeconfigError::MergeError {
                reason: e.to_string(),
            })?;

        let inner = Client::try_from(config).map_err(|e| KubeconfigError::ClientError {
            reason: e.to_string(),
        })?;

        Ok(Self { inner })
    }

    /// List pods in `namespace`, or across all namespaces when `namespace` is
    /// `None`.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_pods(
        &self,
        namespace: Option<&str>,
    ) -> Result<Vec<PodInfo>, KubeconfigError> {
        let api: Api<Pod> = match namespace {
            Some(ns) => Api::namespaced(self.inner.clone(), ns),
            None => Api::all(self.inner.clone()),
        };

        let pod_list =
            api.list(&Default::default())
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })?;

        Ok(pod_list.items.into_iter().filter_map(pod_to_info).collect())
    }

    /// List all namespaces visible to the authenticated user.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_namespaces(&self) -> Result<Vec<NamespaceInfo>, KubeconfigError> {
        let api: Api<Namespace> = Api::all(self.inner.clone());

        let ns_list =
            api.list(&Default::default())
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })?;

        Ok(ns_list
            .items
            .into_iter()
            .filter_map(namespace_to_info)
            .collect())
    }

    /// List all deployments in the given `namespace`.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_deployments(
        &self,
        namespace: &str,
    ) -> Result<Vec<DeploymentInfo>, KubeconfigError> {
        let api: Api<Deployment> = Api::namespaced(self.inner.clone(), namespace);

        let deploy_list =
            api.list(&Default::default())
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })?;

        Ok(deploy_list
            .items
            .into_iter()
            .filter_map(deployment_to_info)
            .collect())
    }

    /// List services in `namespace`, or across all namespaces when `None`.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_services(
        &self,
        namespace: Option<&str>,
    ) -> Result<Vec<ServiceInfo>, KubeconfigError> {
        let api: Api<Service> = match namespace {
            Some(ns) => Api::namespaced(self.inner.clone(), ns),
            None => Api::all(self.inner.clone()),
        };
        let list =
            api.list(&Default::default())
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })?;
        Ok(list.items.into_iter().filter_map(service_to_info).collect())
    }

    /// List ingresses in `namespace`, or across all namespaces when `None`.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_ingresses(
        &self,
        namespace: Option<&str>,
    ) -> Result<Vec<IngressInfo>, KubeconfigError> {
        let api: Api<Ingress> = match namespace {
            Some(ns) => Api::namespaced(self.inner.clone(), ns),
            None => Api::all(self.inner.clone()),
        };
        let list =
            api.list(&Default::default())
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })?;
        Ok(list.items.into_iter().filter_map(ingress_to_info).collect())
    }

    /// List config maps in `namespace`, or across all namespaces when `None`.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_configmaps(
        &self,
        namespace: Option<&str>,
    ) -> Result<Vec<ConfigMapInfo>, KubeconfigError> {
        let api: Api<ConfigMap> = match namespace {
            Some(ns) => Api::namespaced(self.inner.clone(), ns),
            None => Api::all(self.inner.clone()),
        };
        let list =
            api.list(&Default::default())
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })?;
        Ok(list
            .items
            .into_iter()
            .filter_map(configmap_to_info)
            .collect())
    }

    /// List secrets in `namespace`, or across all namespaces when `None`.
    ///
    /// Values are base64-decoded locally and never leave the machine.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_secrets(
        &self,
        namespace: Option<&str>,
    ) -> Result<Vec<SecretInfo>, KubeconfigError> {
        let api: Api<Secret> = match namespace {
            Some(ns) => Api::namespaced(self.inner.clone(), ns),
            None => Api::all(self.inner.clone()),
        };
        let list =
            api.list(&Default::default())
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })?;
        Ok(list.items.into_iter().filter_map(secret_to_info).collect())
    }

    /// List events in `namespace`, or across all namespaces when `None`,
    /// sorted most-recent first.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_events(
        &self,
        namespace: Option<&str>,
    ) -> Result<Vec<EventInfo>, KubeconfigError> {
        let api: Api<Event> = match namespace {
            Some(ns) => Api::namespaced(self.inner.clone(), ns),
            None => Api::all(self.inner.clone()),
        };
        let list =
            api.list(&Default::default())
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })?;
        let mut events: Vec<EventInfo> = list.items.into_iter().map(event_to_info).collect();
        events.sort_by(|a, b| b.last_timestamp.cmp(&a.last_timestamp));
        Ok(events)
    }

    /// Delete a pod. The owning controller (if any) will recreate it.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn delete_pod(&self, namespace: &str, name: &str) -> Result<(), KubeconfigError> {
        let api: Api<Pod> = Api::namespaced(self.inner.clone(), namespace);
        api.delete(name, &DeleteParams::default())
            .await
            .map_err(|e| KubeconfigError::ClientError {
                reason: e.to_string(),
            })?;
        Ok(())
    }

    /// Trigger a rolling restart of a deployment by stamping the pod
    /// template with the `kubectl.kubernetes.io/restartedAt` annotation
    /// (same mechanism as `kubectl rollout restart`).
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn restart_deployment(
        &self,
        namespace: &str,
        name: &str,
    ) -> Result<(), KubeconfigError> {
        let api: Api<Deployment> = Api::namespaced(self.inner.clone(), namespace);
        let now = k8s_openapi::chrono::Utc::now().to_rfc3339();
        let patch = serde_json::json!({
            "spec": {
                "template": {
                    "metadata": {
                        "annotations": {
                            "kubectl.kubernetes.io/restartedAt": now
                        }
                    }
                }
            }
        });
        api.patch(name, &PatchParams::default(), &Patch::Merge(&patch))
            .await
            .map_err(|e| KubeconfigError::ClientError {
                reason: e.to_string(),
            })?;
        Ok(())
    }

    /// Scale a deployment to `replicas`.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn scale_deployment(
        &self,
        namespace: &str,
        name: &str,
        replicas: i32,
    ) -> Result<(), KubeconfigError> {
        let api: Api<Deployment> = Api::namespaced(self.inner.clone(), namespace);
        let patch = serde_json::json!({ "spec": { "replicas": replicas } });
        api.patch(name, &PatchParams::default(), &Patch::Merge(&patch))
            .await
            .map_err(|e| KubeconfigError::ClientError {
                reason: e.to_string(),
            })?;
        Ok(())
    }
}

/// Convert a raw [`Event`] object into an [`EventInfo`].
fn event_to_info(e: Event) -> EventInfo {
    let object = match (&e.involved_object.kind, &e.involved_object.name) {
        (Some(kind), Some(name)) => format!("{kind}/{name}"),
        (None, Some(name)) => name.clone(),
        _ => "—".to_string(),
    };
    // Prefer the most recent signal available: series, lastTimestamp, eventTime.
    let last_timestamp = e
        .series
        .as_ref()
        .and_then(|s| s.last_observed_time.as_ref().map(|t| t.0.to_rfc3339()))
        .or_else(|| e.last_timestamp.as_ref().map(|t| t.0.to_rfc3339()))
        .or_else(|| e.event_time.as_ref().map(|t| t.0.to_rfc3339()));

    EventInfo {
        event_type: e.type_,
        reason: e.reason,
        object,
        message: e.message,
        namespace: e.metadata.namespace.unwrap_or_default(),
        count: e.count.unwrap_or(1),
        last_timestamp,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{EventSource, ObjectReference};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, Time};

    #[test]
    fn event_to_info_full() {
        let e = Event {
            metadata: ObjectMeta {
                name: Some("api-0.evt".to_string()),
                namespace: Some("default".to_string()),
                ..Default::default()
            },
            involved_object: ObjectReference {
                kind: Some("Pod".to_string()),
                name: Some("api-0".to_string()),
                ..Default::default()
            },
            type_: Some("Warning".to_string()),
            reason: Some("BackOff".to_string()),
            message: Some("Back-off restarting failed container".to_string()),
            count: Some(7),
            last_timestamp: Some(Time(
                k8s_openapi::chrono::DateTime::parse_from_rfc3339("2026-07-11T10:00:00Z")
                    .expect("valid test timestamp")
                    .with_timezone(&k8s_openapi::chrono::Utc),
            )),
            source: Some(EventSource::default()),
            ..Default::default()
        };

        let info = event_to_info(e);
        assert_eq!(info.event_type.as_deref(), Some("Warning"));
        assert_eq!(info.reason.as_deref(), Some("BackOff"));
        assert_eq!(info.object, "Pod/api-0");
        assert_eq!(info.count, 7);
        assert!(info
            .last_timestamp
            .as_deref()
            .is_some_and(|t| t.starts_with("2026-07-11T10:00:00")));
    }

    #[test]
    fn event_to_info_defaults() {
        let e = Event {
            involved_object: ObjectReference::default(),
            ..Default::default()
        };
        let info = event_to_info(e);
        assert_eq!(info.object, "—");
        assert_eq!(info.count, 1);
        assert!(info.last_timestamp.is_none());
    }
}
