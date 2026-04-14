//! Async Kubernetes client wrapper built on top of `kube-rs`.
//!
//! [`KubeClient`] wraps a configured `kube::Client` and exposes high-level
//! methods for listing the most common Kubernetes resources.

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::{
    config::{KubeConfigOptions, Kubeconfig},
    Api, Client, Config,
};
use std::path::Path;

use crate::{
    error::KubeconfigError,
    resources::{DeploymentInfo, NamespaceInfo, PodInfo},
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

        let pods = pod_list
            .items
            .into_iter()
            .filter_map(|pod| {
                let name = pod.metadata.name?;
                let ns = pod.metadata.namespace.unwrap_or_default();
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
                    namespace: ns,
                    phase,
                    ready,
                    restarts,
                })
            })
            .collect();

        Ok(pods)
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

        let namespaces = ns_list
            .items
            .into_iter()
            .filter_map(|ns| {
                let name = ns.metadata.name?;
                let phase = ns.status.as_ref().and_then(|s| s.phase.clone());
                Some(NamespaceInfo { name, phase })
            })
            .collect();

        Ok(namespaces)
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

        let deployments = deploy_list
            .items
            .into_iter()
            .filter_map(|d| {
                let name = d.metadata.name?;
                let ns = d.metadata.namespace.unwrap_or_default();
                let replicas = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
                let ready_replicas = d
                    .status
                    .as_ref()
                    .and_then(|s| s.ready_replicas)
                    .unwrap_or(0);
                Some(DeploymentInfo {
                    name,
                    namespace: ns,
                    replicas,
                    ready_replicas,
                })
            })
            .collect();

        Ok(deployments)
    }
}
