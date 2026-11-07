//! Async Kubernetes client wrapper built on top of `kube-rs`.
//!
//! [`KubeClient`] wraps a configured `kube::Client` and exposes high-level
//! methods for listing the most common Kubernetes resources.

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, Event, Namespace, Node, PersistentVolumeClaim, Pod, Secret, Service,
};
use k8s_openapi::api::networking::v1::Ingress;
use kube::{
    api::{DeleteParams, ListParams, Patch, PatchParams, PostParams},
    config::{KubeConfigOptions, Kubeconfig},
    Api, Client, Config,
};
use std::path::PathBuf;
use std::time::Duration;

use crate::{
    error::KubeconfigError,
    helm::{latest_releases, parse_release_secret, HelmReleaseInfo},
    kubeconfig::split_kubeconfig_spec,
    metrics::{
        parse_cpu_millis, parse_memory_bytes, pod_metrics_from_item, NodeCapacityInfo,
        PodMetricsInfo,
    },
    resources::{
        ConfigMapInfo, CronJobInfo, DeploymentInfo, EventInfo, IngressInfo, JobInfo, NamespaceInfo,
        NodeInfo, PodInfo, PvcInfo, SecretInfo, ServiceInfo, StatefulSetInfo, WorkloadRef,
    },
    watcher::ResourceType,
    watcher::{
        configmap_to_info, cronjob_to_info, deployment_to_info, ingress_to_info, job_to_info,
        namespace_to_info, node_to_info, pod_to_info, pvc_to_info, secret_to_info, service_to_info,
        statefulset_to_info,
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

    /// Wrap an existing [`Client`] (a mock apiserver in tests).
    #[cfg(test)]
    pub(crate) fn from_client(client: Client) -> Self {
        Self { inner: client }
    }

    /// Build a [`KubeClient`] from `kubeconfig`: a single file path or a
    /// `KUBECONFIG`-style list (`:` on Unix, `;` on Windows).
    ///
    /// Several files are merged like kubectl does: the first file to define a
    /// context, cluster or user wins, and missing files are skipped — except
    /// that the selected context uses the cluster and user its own file
    /// defines under the referenced names (#543). `context` selects a named
    /// context; when `None` the merged `current-context` is used.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError`] when no file can be read or parsed, or
    /// when the client cannot be initialised from the resulting config.
    pub async fn new(kubeconfig: &str, context: Option<&str>) -> Result<Self, KubeconfigError> {
        Self::build(kubeconfig, context, None).await
    }

    /// Like [`KubeClient::new`] but with short connect/read timeouts —
    /// intended for reachability probes that must fail fast.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError`] when the kubeconfig cannot be loaded or
    /// the client cannot be initialised.
    pub async fn new_probe(
        kubeconfig: &str,
        context: Option<&str>,
    ) -> Result<Self, KubeconfigError> {
        Self::build(kubeconfig, context, Some((3, 5))).await
    }

    async fn build(
        kubeconfig: &str,
        context: Option<&str>,
        timeouts_secs: Option<(u64, u64)>,
    ) -> Result<Self, KubeconfigError> {
        let paths = split_kubeconfig_spec(kubeconfig);
        let target = context.map(str::to_string);
        let kubeconfig =
            tokio::task::spawn_blocking(move || merged_kubeconfig(&paths, target.as_deref()))
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })??;

        let options = KubeConfigOptions {
            context: context.map(str::to_string),
            ..Default::default()
        };

        let mut config = Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .map_err(|e| KubeconfigError::MergeError {
                reason: e.to_string(),
            })?;

        if let Some((connect, read)) = timeouts_secs {
            config.connect_timeout = Some(Duration::from_secs(connect));
            config.read_timeout = Some(Duration::from_secs(read));
        }

        let inner = Client::try_from(config).map_err(|e| KubeconfigError::ClientError {
            reason: e.to_string(),
        })?;

        Ok(Self { inner })
    }

    /// Kubernetes server version (`gitVersion` from `/version`).
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn server_version(&self) -> Result<String, KubeconfigError> {
        let doc = self.raw_get("/version").await?;
        doc["gitVersion"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| KubeconfigError::ClientError {
                reason: "missing gitVersion in /version response".to_string(),
            })
    }

    /// Number of nodes in the cluster (best used by reachability probes).
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn node_count(&self) -> Result<usize, KubeconfigError> {
        let api: Api<Node> = Api::all(self.inner.clone());
        let list =
            api.list(&Default::default())
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })?;
        Ok(list.items.len())
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

    /// Fetch one pod's containers (app, sidecar, init) with live status,
    /// for the log-panel container picker.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn get_pod_containers(
        &self,
        namespace: &str,
        pod: &str,
    ) -> Result<Vec<crate::resources::ContainerDetail>, KubeconfigError> {
        let api: Api<Pod> = Api::namespaced(self.inner.clone(), namespace);
        let raw = api
            .get(pod)
            .await
            .map_err(|e| KubeconfigError::ClientError {
                reason: e.to_string(),
            })?;
        Ok(crate::watcher::pod_to_container_details(&raw))
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

    /// List Helm v3 releases (latest revision per release) in `namespace`,
    /// or across all namespaces when `None`.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_helm_releases(
        &self,
        namespace: Option<&str>,
    ) -> Result<Vec<HelmReleaseInfo>, KubeconfigError> {
        let api: Api<Secret> = match namespace {
            Some(ns) => Api::namespaced(self.inner.clone(), ns),
            None => Api::all(self.inner.clone()),
        };
        let params = ListParams::default().labels("owner=helm");
        let list = api
            .list(&params)
            .await
            .map_err(|e| KubeconfigError::ClientError {
                reason: e.to_string(),
            })?;
        let releases = list
            .items
            .iter()
            .filter(|s| s.type_.as_deref() == Some("helm.sh/release.v1"))
            .filter_map(parse_release_secret)
            .collect();
        Ok(latest_releases(releases))
    }

    /// Fetch pod CPU/memory usage from metrics-server.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails —
    /// including a 404 when metrics-server is not installed.
    pub async fn list_pod_metrics(
        &self,
        namespace: Option<&str>,
    ) -> Result<Vec<PodMetricsInfo>, KubeconfigError> {
        let path = match namespace {
            Some(ns) => format!("/apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods"),
            None => "/apis/metrics.k8s.io/v1beta1/pods".to_string(),
        };
        let doc = self.raw_get(&path).await?;
        Ok(doc["items"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .filter_map(pod_metrics_from_item)
            .collect())
    }

    /// Per-node usage (metrics-server) joined with allocatable capacity
    /// (node status). Also serves as the node inventory for the UI.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when either API call fails.
    pub async fn cluster_capacity(&self) -> Result<Vec<NodeCapacityInfo>, KubeconfigError> {
        let nodes_api: Api<Node> = Api::all(self.inner.clone());
        let nodes = nodes_api.list(&Default::default()).await.map_err(|e| {
            KubeconfigError::ClientError {
                reason: e.to_string(),
            }
        })?;

        let usage_doc = self.raw_get("/apis/metrics.k8s.io/v1beta1/nodes").await?;
        let usage: std::collections::HashMap<String, (f64, u64)> = usage_doc["items"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .filter_map(|item| {
                let name = item["metadata"]["name"].as_str()?.to_string();
                let cpu = item["usage"]["cpu"].as_str().and_then(parse_cpu_millis)?;
                let mem = item["usage"]["memory"]
                    .as_str()
                    .and_then(parse_memory_bytes)?;
                Some((name, (cpu, mem)))
            })
            .collect();

        Ok(nodes
            .items
            .into_iter()
            .filter_map(|node| {
                let name = node.metadata.name?;
                let allocatable = node.status.as_ref().and_then(|s| s.allocatable.as_ref());
                let cpu_allocatable_millis = allocatable
                    .and_then(|a| a.get("cpu"))
                    .and_then(|q| parse_cpu_millis(&q.0))
                    .unwrap_or(0.0);
                let memory_allocatable_bytes = allocatable
                    .and_then(|a| a.get("memory"))
                    .and_then(|q| parse_memory_bytes(&q.0))
                    .unwrap_or(0);
                let (cpu_used_millis, memory_used_bytes) =
                    usage.get(&name).copied().unwrap_or((0.0, 0));
                Some(NodeCapacityInfo {
                    name,
                    cpu_used_millis,
                    cpu_allocatable_millis,
                    memory_used_bytes,
                    memory_allocatable_bytes,
                })
            })
            .collect())
    }

    /// GET an arbitrary API path as JSON.
    async fn raw_get(&self, path: &str) -> Result<serde_json::Value, KubeconfigError> {
        let request = http::Request::get(path).body(Vec::new()).map_err(|e| {
            KubeconfigError::ClientError {
                reason: e.to_string(),
            }
        })?;
        self.inner
            .request::<serde_json::Value>(request)
            .await
            .map_err(|e| KubeconfigError::ClientError {
                reason: e.to_string(),
            })
    }

    /// List jobs in `namespace`, or across all namespaces when `None`.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_jobs(
        &self,
        namespace: Option<&str>,
    ) -> Result<Vec<JobInfo>, KubeconfigError> {
        let api: Api<Job> = match namespace {
            Some(ns) => Api::namespaced(self.inner.clone(), ns),
            None => Api::all(self.inner.clone()),
        };
        let list =
            api.list(&Default::default())
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })?;
        Ok(list.items.into_iter().filter_map(job_to_info).collect())
    }

    /// List cron jobs in `namespace`, or across all namespaces when `None`.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_cronjobs(
        &self,
        namespace: Option<&str>,
    ) -> Result<Vec<CronJobInfo>, KubeconfigError> {
        let api: Api<CronJob> = match namespace {
            Some(ns) => Api::namespaced(self.inner.clone(), ns),
            None => Api::all(self.inner.clone()),
        };
        let list =
            api.list(&Default::default())
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })?;
        Ok(list.items.into_iter().filter_map(cronjob_to_info).collect())
    }

    /// List stateful sets in `namespace`, or across all namespaces when `None`.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_statefulsets(
        &self,
        namespace: Option<&str>,
    ) -> Result<Vec<StatefulSetInfo>, KubeconfigError> {
        let api: Api<StatefulSet> = match namespace {
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
            .filter_map(statefulset_to_info)
            .collect())
    }

    /// List DaemonSets in `namespace`, or across all namespaces when `None`,
    /// by name only (the Logs view's workload picker, #529).
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_daemonsets(
        &self,
        namespace: Option<&str>,
    ) -> Result<Vec<WorkloadRef>, KubeconfigError> {
        let api: Api<DaemonSet> = match namespace {
            Some(ns) => Api::namespaced(self.inner.clone(), ns),
            None => Api::all(self.inner.clone()),
        };
        let list = api.list_metadata(&Default::default()).await.map_err(|e| {
            KubeconfigError::ClientError {
                reason: e.to_string(),
            }
        })?;
        Ok(list
            .items
            .into_iter()
            .filter_map(|d| {
                Some(WorkloadRef {
                    name: d.metadata.name?,
                    namespace: d.metadata.namespace.unwrap_or_default(),
                })
            })
            .collect())
    }

    /// List persistent volume claims in `namespace`, or across all namespaces when `None`.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_pvcs(
        &self,
        namespace: Option<&str>,
    ) -> Result<Vec<PvcInfo>, KubeconfigError> {
        let api: Api<PersistentVolumeClaim> = match namespace {
            Some(ns) => Api::namespaced(self.inner.clone(), ns),
            None => Api::all(self.inner.clone()),
        };
        let list =
            api.list(&Default::default())
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })?;
        Ok(list.items.into_iter().filter_map(pvc_to_info).collect())
    }

    /// List nodes (read-only inventory).
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails.
    pub async fn list_nodes(&self) -> Result<Vec<NodeInfo>, KubeconfigError> {
        let api: Api<Node> = Api::all(self.inner.clone());
        let list =
            api.list(&Default::default())
                .await
                .map_err(|e| KubeconfigError::ClientError {
                    reason: e.to_string(),
                })?;
        Ok(list.items.into_iter().filter_map(node_to_info).collect())
    }

    /// Fetch one resource and render it as cleaned YAML (managedFields
    /// stripped, like `kubectl get -o yaml`).
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] when the API call fails or
    /// the resource kind does not support YAML rendering.
    pub async fn get_resource_yaml(
        &self,
        resource_type: ResourceType,
        namespace: &str,
        name: &str,
    ) -> Result<String, KubeconfigError> {
        let client = self.inner.clone();
        match resource_type {
            ResourceType::Pod => fetch_yaml::<Pod>(client, namespace, name).await,
            ResourceType::Deployment => fetch_yaml::<Deployment>(client, namespace, name).await,
            ResourceType::Service => fetch_yaml::<Service>(client, namespace, name).await,
            ResourceType::ConfigMap => fetch_yaml::<ConfigMap>(client, namespace, name).await,
            ResourceType::Secret => fetch_yaml::<Secret>(client, namespace, name).await,
            ResourceType::Ingress => fetch_yaml::<Ingress>(client, namespace, name).await,
            ResourceType::Namespace => Err(KubeconfigError::ClientError {
                reason: "YAML view is not supported for namespaces".to_string(),
            }),
        }
    }

    /// Replace one resource with an edited YAML manifest (PUT, `kubectl
    /// replace` semantics).
    ///
    /// The manifest must be a mapping of the target's kind whose
    /// `metadata.name` is `name` (and `metadata.namespace`, when present,
    /// `namespace`). The `resourceVersion` it carries gives optimistic
    /// concurrency: a concurrent change makes the API answer 409.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::ClientError`] for an invalid or mismatched
    /// manifest, a kind without YAML support, a conflict (friendly message)
    /// or any other API failure.
    pub async fn apply_resource_yaml(
        &self,
        resource_type: ResourceType,
        namespace: &str,
        name: &str,
        yaml: &str,
    ) -> Result<(), KubeconfigError> {
        let client = self.inner.clone();
        match resource_type {
            ResourceType::Pod => replace_yaml::<Pod>(client, namespace, name, yaml).await,
            ResourceType::Deployment => {
                replace_yaml::<Deployment>(client, namespace, name, yaml).await
            }
            ResourceType::Service => replace_yaml::<Service>(client, namespace, name, yaml).await,
            ResourceType::ConfigMap => {
                replace_yaml::<ConfigMap>(client, namespace, name, yaml).await
            }
            ResourceType::Secret => replace_yaml::<Secret>(client, namespace, name, yaml).await,
            ResourceType::Ingress => replace_yaml::<Ingress>(client, namespace, name, yaml).await,
            ResourceType::Namespace => Err(KubeconfigError::ClientError {
                reason: "Editing is not supported for namespaces".to_string(),
            }),
        }
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
        let now = k8s_openapi::jiff::Timestamp::now().to_string();
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

/// Fetch one namespaced object and serialize it as cleaned YAML.
async fn fetch_yaml<K>(
    client: Client,
    namespace: &str,
    name: &str,
) -> Result<String, KubeconfigError>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + serde::Serialize
        + serde::de::DeserializeOwned
        + std::fmt::Debug,
    <K as kube::Resource>::DynamicType: Default,
{
    let api: Api<K> = Api::namespaced(client, namespace);
    let obj = api
        .get(name)
        .await
        .map_err(|e| KubeconfigError::ClientError {
            reason: e.to_string(),
        })?;
    to_clean_yaml(&obj)
}

/// Parse `yaml` and PUT it over `namespace/name`.
async fn replace_yaml<K>(
    client: Client,
    namespace: &str,
    name: &str,
    yaml: &str,
) -> Result<(), KubeconfigError>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + serde::Serialize
        + serde::de::DeserializeOwned
        + std::fmt::Debug,
    <K as kube::Resource>::DynamicType: Default,
{
    let obj: K = parse_manifest(yaml, namespace, name)?;
    let api: Api<K> = Api::namespaced(client, namespace);
    api.replace(name, &PostParams::default(), &obj)
        .await
        .map(|_| ())
        .map_err(apply_error)
}

/// Parse an edited manifest into `K`, rejecting anything that would not
/// replace exactly the target object: not a mapping, another kind, another
/// name, or another namespace. Renames and moves are not supported.
fn parse_manifest<K>(yaml: &str, namespace: &str, name: &str) -> Result<K, KubeconfigError>
where
    K: kube::Resource + serde::de::DeserializeOwned,
    <K as kube::Resource>::DynamicType: Default,
{
    let invalid = |reason: String| KubeconfigError::ClientError { reason };
    let value: serde_yaml::Value = serde_yaml::from_str(yaml)
        .map_err(|e| invalid(format!("The manifest is not valid YAML: {e}")))?;
    if !value.is_mapping() {
        return Err(invalid("The manifest must be a YAML mapping".to_string()));
    }
    let expected_kind = K::kind(&K::DynamicType::default()).to_string();
    if let Some(kind) = value.get("kind") {
        if kind.as_str() != Some(expected_kind.as_str()) {
            return Err(invalid(format!(
                "The manifest kind must stay {expected_kind}"
            )));
        }
    }
    let obj: K = serde_yaml::from_value(value)
        .map_err(|e| invalid(format!("The manifest is not a valid {expected_kind}: {e}")))?;
    if obj.meta().name.as_deref() != Some(name) {
        return Err(invalid(format!(
            "metadata.name must stay \"{name}\" (renaming is not supported)"
        )));
    }
    if obj
        .meta()
        .namespace
        .as_deref()
        .is_some_and(|ns| ns != namespace)
    {
        return Err(invalid(format!(
            "metadata.namespace must stay \"{namespace}\" (moving is not supported)"
        )));
    }
    Ok(obj)
}

/// Map a replace failure to a message for the YAML editor.
fn apply_error(error: kube::Error) -> KubeconfigError {
    let reason = match &error {
        kube::Error::Api(status) if status.code == 409 => {
            "The resource changed since you opened it. Reload and edit again.".to_string()
        }
        kube::Error::Api(status) if !status.message.is_empty() => status.message.clone(),
        _ => error.to_string(),
    };
    KubeconfigError::ClientError { reason }
}

/// Serialize an API object to YAML with noisy server-side bookkeeping
/// (`metadata.managedFields`) stripped, like `kubectl get -o yaml`.
fn to_clean_yaml<T: serde::Serialize>(obj: &T) -> Result<String, KubeconfigError> {
    let mut value = serde_json::to_value(obj).map_err(|e| KubeconfigError::ClientError {
        reason: e.to_string(),
    })?;
    if let Some(meta) = value.get_mut("metadata").and_then(|m| m.as_object_mut()) {
        meta.remove("managedFields");
    }
    serde_yaml::to_string(&value).map_err(|e| KubeconfigError::ClientError {
        reason: e.to_string(),
    })
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
        .and_then(|s| s.last_observed_time.as_ref().map(|t| t.0.to_string()))
        .or_else(|| e.last_timestamp.as_ref().map(|t| t.0.to_string()))
        .or_else(|| e.event_time.as_ref().map(|t| t.0.to_string()));

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

/// Read and merge kubeconfig files with kube-rs for a client of `context`
/// (`None`: the merged `current-context`). Missing files are skipped;
/// relative certificate/key paths are resolved against each file's directory
/// by [`Kubeconfig::read_from`].
///
/// Names clash first-wins (kubectl), except that the target context's cluster
/// and user come from the file that defines the context whenever that file
/// defines those names (#543): a stale entry with the same name in an earlier
/// file must not redirect the context. Only the content of the named entries
/// changes, so names seen elsewhere stay the same.
///
/// This is the document [`KubeClient::new`] builds its client from.
///
/// # Errors
///
/// Returns [`KubeconfigError::FileNotFound`] when none of `paths` exists, or
/// [`KubeconfigError::MergeError`] when a file cannot be read, parsed or
/// merged.
// Public only for the shared kubeconfig fixture and property tests
// (`tests/kubeconfig_fixtures.rs`, `tests/kubeconfig_merge_property.rs`,
// #548), which check the client path without a cluster; not part of the
// supported API, hence hidden from the docs.
#[doc(hidden)]
pub fn merged_kubeconfig(
    paths: &[PathBuf],
    context: Option<&str>,
) -> Result<Kubeconfig, KubeconfigError> {
    let mut files = Vec::new();
    for path in paths.iter().filter(|p| p.exists()) {
        let mut file = Kubeconfig::read_from(path).map_err(|e| KubeconfigError::MergeError {
            reason: format!("{}: {e}", path.display()),
        })?;
        // kubectl treats `current-context: ""` as unset, so a later file's
        // value still applies (#552); kube-rs `merge` keeps the first `Some`.
        if file.current_context.as_deref() == Some("") {
            file.current_context = None;
        }
        files.push(file);
    }
    let mut merged: Option<Kubeconfig> = None;
    for next in files.iter().cloned() {
        merged = Some(match merged {
            Some(acc) => acc.merge(next).map_err(|e| KubeconfigError::MergeError {
                reason: e.to_string(),
            })?,
            None => next,
        });
    }
    let mut merged = merged.ok_or_else(|| KubeconfigError::FileNotFound {
        path: if paths.is_empty() {
            "(no kubeconfig paths provided)".to_string()
        } else {
            paths
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        },
    })?;
    let target = context
        .map(str::to_string)
        .or_else(|| merged.current_context.clone());
    if let Some(target) = target {
        prefer_context_file_entries(&mut merged, &files, &target);
    }
    Ok(merged)
}

/// Replace the content of the cluster and user that `context` references in
/// `merged` with the entries of the first file in `files` that defines
/// `context`, when that file defines them. Anything else is left as merged.
fn prefer_context_file_entries(merged: &mut Kubeconfig, files: &[Kubeconfig], context: &str) {
    let Some((own, details)) = files.iter().find_map(|file| {
        file.contexts
            .iter()
            .find(|c| c.name == context)
            .map(|c| (file, c.context.as_ref()))
    }) else {
        return;
    };
    let Some(details) = details else {
        return;
    };
    replace_named(&mut merged.clusters, &own.clusters, &details.cluster, |c| {
        &c.name
    });
    if let Some(user) = details.user.as_deref() {
        replace_named(&mut merged.auth_infos, &own.auth_infos, user, |u| &u.name);
    }
}

/// Overwrite the entry called `name` in `merged` with the one in `own`, when
/// both lists have it.
fn replace_named<T: Clone>(merged: &mut [T], own: &[T], name: &str, name_of: fn(&T) -> &String) {
    let Some(own_entry) = own.iter().find(|e| name_of(e) == name) else {
        return;
    };
    if let Some(slot) = merged.iter_mut().find(|e| name_of(e) == name) {
        *slot = own_entry.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_kubeconfig(dir: &std::path::Path, name: &str, yaml: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, yaml).expect("write kubeconfig");
        path
    }

    const FILE_A: &str = r#"
apiVersion: v1
kind: Config
current-context: dev
contexts:
  - name: dev
    context: { cluster: dev-cluster, user: shared-user }
clusters:
  - name: dev-cluster
    cluster: { server: "https://a.example:6443" }
users:
  - name: shared-user
    user: { token: from-a }
"#;

    const FILE_B: &str = r#"
apiVersion: v1
kind: Config
current-context: staging
contexts:
  - name: staging
    context: { cluster: staging-cluster, user: shared-user }
  - name: dev
    context: { cluster: staging-cluster, user: shared-user }
clusters:
  - name: staging-cluster
    cluster: { server: "https://b.example:6443" }
users:
  - name: shared-user
    user: { token: from-b }
"#;

    #[tokio::test]
    async fn merged_kubeconfig_resolves_contexts_from_every_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let a = write_kubeconfig(dir.path(), "a.yaml", FILE_A);
        let b = write_kubeconfig(dir.path(), "b.yaml", FILE_B);
        let missing = dir.path().join("missing.yaml");
        let paths = [a, missing, b];

        // A context defined only in the second file resolves to that file's
        // cluster, and to that file's user even though the first file
        // defines a user with the same name (#543).
        let (url, token) = resolved(&paths, Some("staging")).await;
        assert_eq!(url, "https://b.example:6443/");
        assert_eq!(token, "from-b");

        // A clashing context name keeps the first file's definition.
        let (url, token) = resolved(&paths, Some("dev")).await;
        assert_eq!(url, "https://a.example:6443/");
        assert_eq!(token, "from-a");

        // current-context comes from the first file that sets it.
        let merged = merged_kubeconfig(&paths, None).expect("merge");
        assert_eq!(merged.current_context.as_deref(), Some("dev"));
    }

    /// Earlier file with a stale cluster/user no context of its own uses.
    const STALE: &str = r#"
apiVersion: v1
kind: Config
clusters:
  - name: aks-prod
    cluster: { server: "https://old.example:6443" }
  - name: only-stale
    cluster: { server: "https://only-stale.example:6443" }
users:
  - name: aks-user
    user: { token: old-token }
"#;

    /// Later file that defines its context with its own cluster and user.
    const OWN: &str = r#"
apiVersion: v1
kind: Config
current-context: aks-prod
contexts:
  - name: aks-prod
    context: { cluster: aks-prod, user: aks-user }
  - name: cross
    context: { cluster: only-stale, user: aks-user }
clusters:
  - name: aks-prod
    cluster: { server: "https://new.example:6443" }
users:
  - name: aks-user
    user: { token: new-token }
"#;

    /// Cluster URL and bearer token kube-rs would use for `context`.
    async fn resolved(paths: &[PathBuf], context: Option<&str>) -> (String, serde_json::Value) {
        let merged = merged_kubeconfig(paths, context).expect("merge");
        let opts = KubeConfigOptions {
            context: context.map(str::to_string),
            ..Default::default()
        };
        let cfg = Config::from_custom_kubeconfig(merged, &opts)
            .await
            .expect("config");
        let auth = serde_json::to_value(&cfg.auth_info).expect("auth json");
        (cfg.cluster_url.to_string(), auth["token"].clone())
    }

    #[tokio::test]
    async fn client_uses_the_cluster_and_user_of_the_context_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let stale = write_kubeconfig(dir.path(), "config", STALE);
        let own = write_kubeconfig(dir.path(), "own", OWN);
        let paths = [stale, own];

        let (url, token) = resolved(&paths, Some("aks-prod")).await;
        assert_eq!(url, "https://new.example:6443/");
        assert_eq!(token, "new-token");

        // current-context (`context: None`) follows the same rule.
        let (url, token) = resolved(&paths, None).await;
        assert_eq!(url, "https://new.example:6443/");
        assert_eq!(token, "new-token");

        // A cluster the context's file does not define still resolves from
        // the earlier file (kubectl cross-file reference).
        let (url, token) = resolved(&paths, Some("cross")).await;
        assert_eq!(url, "https://only-stale.example:6443/");
        assert_eq!(token, "new-token");
    }

    #[tokio::test]
    async fn context_file_listed_first_is_unchanged() {
        let dir = tempfile::tempdir().expect("tempdir");
        let own = write_kubeconfig(dir.path(), "own", OWN);
        let stale = write_kubeconfig(dir.path(), "config", STALE);
        // Context file first: its entries win either way.
        let (url, token) = resolved(&[own, stale], Some("aks-prod")).await;
        assert_eq!(url, "https://new.example:6443/");
        assert_eq!(token, "new-token");
    }

    #[test]
    fn merged_kubeconfig_skips_an_empty_current_context() {
        let dir = tempfile::tempdir().expect("tempdir");
        let empty = write_kubeconfig(
            dir.path(),
            "a.yaml",
            "apiVersion: v1\nkind: Config\ncurrent-context: \"\"\n",
        );
        let b = write_kubeconfig(dir.path(), "b.yaml", FILE_B);
        let merged = merged_kubeconfig(&[empty.clone(), b], None).expect("merge");
        assert_eq!(merged.current_context.as_deref(), Some("staging"));

        let alone = merged_kubeconfig(&[empty], None).expect("merge");
        assert_eq!(alone.current_context, None);
    }

    #[test]
    fn merged_kubeconfig_errors_when_no_file_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = merged_kubeconfig(&[dir.path().join("nope.yaml")], None).expect_err("no files");
        assert!(matches!(err, KubeconfigError::FileNotFound { .. }));
        let err = merged_kubeconfig(&[], None).expect_err("empty list");
        assert!(matches!(err, KubeconfigError::FileNotFound { .. }));
    }
    use k8s_openapi::api::core::v1::{EventSource, ObjectReference};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, Time};

    #[test]
    fn to_clean_yaml_strips_managed_fields() {
        let obj = serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": "api-0",
                "managedFields": [{ "manager": "kubectl" }]
            },
            "spec": { "containers": [] }
        });
        let yaml = to_clean_yaml(&obj).expect("yaml");
        assert!(yaml.contains("name: api-0"));
        assert!(!yaml.contains("managedFields"));
        assert!(yaml.contains("kind: Pod"));
    }

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
                "2026-07-11T10:00:00Z"
                    .parse::<k8s_openapi::jiff::Timestamp>()
                    .expect("valid test timestamp"),
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

    // --- API calls against a mock apiserver (no network) ---

    use http::{Method, StatusCode};

    use crate::test_support::{mock_client, requests};

    fn list(kind: &str, items: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "apiVersion": "v1",
            "kind": kind,
            "metadata": { "resourceVersion": "1" },
            "items": items,
        })
    }

    fn pod(ns: &str, name: &str) -> serde_json::Value {
        serde_json::json!({
            "metadata": { "name": name, "namespace": ns },
            "status": { "phase": "Running" },
        })
    }

    #[tokio::test]
    async fn list_pods_targets_one_namespace_or_all() {
        let (client, server) = mock_client(|_, uri| {
            let items = if uri.starts_with("/api/v1/namespaces/team/") {
                serde_json::json!([pod("team", "api-0")])
            } else {
                serde_json::json!([pod("team", "api-0"), pod("infra", "dns-0")])
            };
            (StatusCode::OK, list("PodList", items))
        });

        let scoped = client.list_pods(Some("team")).await.expect("scoped list");
        let all = client.list_pods(None).await.expect("cluster-wide list");

        assert_eq!(
            scoped.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            ["api-0"]
        );
        assert_eq!(
            all.iter()
                .map(|p| (p.namespace.as_str(), p.name.as_str()))
                .collect::<Vec<_>>(),
            [("team", "api-0"), ("infra", "dns-0")]
        );
        let seen = requests(client, server).await;
        assert!(seen[0].uri.starts_with("/api/v1/namespaces/team/pods?"));
        assert!(seen[1].uri.starts_with("/api/v1/pods?"));
    }

    #[tokio::test]
    async fn server_version_and_node_count() {
        let (client, server) = mock_client(|_, uri| {
            if uri == "/version" {
                (
                    StatusCode::OK,
                    serde_json::json!({ "gitVersion": "v1.32.4" }),
                )
            } else {
                let node = serde_json::json!({ "metadata": { "name": "n" } });
                (
                    StatusCode::OK,
                    list("NodeList", serde_json::json!([node.clone(), node])),
                )
            }
        });

        assert_eq!(client.server_version().await.expect("version"), "v1.32.4");
        assert_eq!(client.node_count().await.expect("nodes"), 2);
        let seen = requests(client, server).await;
        assert!(seen[1].uri.starts_with("/api/v1/nodes?"));
    }

    #[tokio::test]
    async fn server_version_without_git_version_is_an_error() {
        let (client, server) = mock_client(|_, _| (StatusCode::OK, serde_json::json!({})));
        let err = client
            .server_version()
            .await
            .expect_err("missing gitVersion");
        assert!(err.to_string().contains("missing gitVersion"));
        requests(client, server).await;
    }

    #[tokio::test]
    async fn delete_pod_sends_delete_to_the_pod() {
        let (client, server) = mock_client(|_, _| (StatusCode::OK, pod("team", "api-0")));
        client.delete_pod("team", "api-0").await.expect("delete");
        let seen = requests(client, server).await;
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].method, Method::DELETE);
        assert_eq!(seen[0].uri, "/api/v1/namespaces/team/pods/api-0?");
    }

    fn deployment() -> serde_json::Value {
        serde_json::json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": "web", "namespace": "team" },
        })
    }

    #[tokio::test]
    async fn scale_deployment_merge_patches_replicas() {
        let (client, server) = mock_client(|_, _| (StatusCode::OK, deployment()));
        client
            .scale_deployment("team", "web", 3)
            .await
            .expect("scale");
        let seen = requests(client, server).await;
        assert_eq!(seen[0].method, Method::PATCH);
        assert!(seen[0]
            .uri
            .starts_with("/apis/apps/v1/namespaces/team/deployments/web?"));
        assert_eq!(
            seen[0].content_type.as_deref(),
            Some("application/merge-patch+json")
        );
        assert_eq!(
            seen[0].body,
            serde_json::json!({ "spec": { "replicas": 3 } })
        );
    }

    #[tokio::test]
    async fn restart_deployment_stamps_restarted_at() {
        let (client, server) = mock_client(|_, _| (StatusCode::OK, deployment()));
        client
            .restart_deployment("team", "web")
            .await
            .expect("restart");
        let seen = requests(client, server).await;
        assert_eq!(seen[0].method, Method::PATCH);
        let stamp = seen[0].body["spec"]["template"]["metadata"]["annotations"]
            ["kubectl.kubernetes.io/restartedAt"]
            .as_str()
            .expect("restartedAt annotation");
        stamp
            .parse::<k8s_openapi::jiff::Timestamp>()
            .expect("restartedAt is RFC 3339");
    }

    #[tokio::test]
    async fn api_errors_surface_as_client_errors() {
        let (client, server) = mock_client(|_, _| {
            (
                StatusCode::NOT_FOUND,
                serde_json::json!({
                    "apiVersion": "v1",
                    "kind": "Status",
                    "status": "Failure",
                    "message": "pods \"ghost\" not found",
                    "reason": "NotFound",
                    "code": 404,
                }),
            )
        });
        let err = client.delete_pod("team", "ghost").await.expect_err("404");
        assert!(matches!(err, KubeconfigError::ClientError { .. }));
        assert!(err.to_string().contains("not found"), "{err}");
        requests(client, server).await;
    }

    #[tokio::test]
    async fn list_events_maps_items() {
        let (client, server) = mock_client(|_, _| {
            let event = serde_json::json!({
                "metadata": { "name": "api-0.1", "namespace": "team" },
                "involvedObject": { "kind": "Pod", "name": "api-0" },
                "reason": "BackOff",
                "type": "Warning",
                "count": 3,
                "lastTimestamp": "2026-07-11T10:00:00Z",
            });
            (
                StatusCode::OK,
                list("EventList", serde_json::json!([event])),
            )
        });
        let events = client.list_events(Some("team")).await.expect("events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].reason.as_deref(), Some("BackOff"));
        assert_eq!(events[0].count, 3);
        assert_eq!(
            events[0].last_timestamp.as_deref(),
            Some("2026-07-11T10:00:00Z")
        );
        let seen = requests(client, server).await;
        assert!(seen[0].uri.starts_with("/api/v1/namespaces/team/events?"));
    }

    // -- apply_resource_yaml (#487) ------------------------------------------

    const CM: &str = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  namespace: dev\n  resourceVersion: \"42\"\ndata:\n  key: value\n";

    fn reason(err: KubeconfigError) -> String {
        match err {
            KubeconfigError::ClientError { reason } => reason,
            other => panic!("unexpected error {other:?}"),
        }
    }

    #[test]
    fn parse_manifest_accepts_the_target_object() {
        let cm: ConfigMap = parse_manifest(CM, "dev", "app").expect("valid");
        assert_eq!(cm.metadata.resource_version.as_deref(), Some("42"));
        assert_eq!(
            cm.data.and_then(|d| d.get("key").cloned()).as_deref(),
            Some("value")
        );
    }

    #[test]
    fn parse_manifest_accepts_missing_kind_and_namespace() {
        let yaml = "metadata:\n  name: app\ndata: {}\n";
        assert!(parse_manifest::<ConfigMap>(yaml, "dev", "app").is_ok());
    }

    #[test]
    fn parse_manifest_rejects_invalid_yaml_and_non_mappings() {
        let broken = reason(parse_manifest::<ConfigMap>("data: [\n", "dev", "app").unwrap_err());
        assert!(
            broken.starts_with("The manifest is not valid YAML"),
            "{broken}"
        );
        let list = reason(parse_manifest::<ConfigMap>("- a\n- b\n", "dev", "app").unwrap_err());
        assert_eq!(list, "The manifest must be a YAML mapping");
    }

    #[test]
    fn parse_manifest_rejects_another_kind_name_or_namespace() {
        let kind = CM.replace("kind: ConfigMap", "kind: Secret");
        assert_eq!(
            reason(parse_manifest::<ConfigMap>(&kind, "dev", "app").unwrap_err()),
            "The manifest kind must stay ConfigMap"
        );
        let renamed = CM.replace("name: app", "name: other");
        assert!(
            reason(parse_manifest::<ConfigMap>(&renamed, "dev", "app").unwrap_err())
                .starts_with("metadata.name must stay \"app\"")
        );
        let moved = CM.replace("namespace: dev", "namespace: prod");
        assert!(
            reason(parse_manifest::<ConfigMap>(&moved, "dev", "app").unwrap_err())
                .starts_with("metadata.namespace must stay \"dev\"")
        );
    }

    #[test]
    fn parse_manifest_rejects_fields_of_the_wrong_type() {
        let bad = CM.replace("key: value", "key: [1, 2]");
        assert!(
            reason(parse_manifest::<ConfigMap>(&bad, "dev", "app").unwrap_err())
                .starts_with("The manifest is not a valid ConfigMap")
        );
    }

    #[test]
    fn apply_error_maps_conflicts_and_api_messages() {
        let status = |code: u16, message: &str| {
            kube::Error::Api(Box::new(kube::core::Status {
                code,
                message: message.to_string(),
                ..Default::default()
            }))
        };
        assert_eq!(
            reason(apply_error(status(409, "Operation cannot be fulfilled"))),
            "The resource changed since you opened it. Reload and edit again."
        );
        assert_eq!(
            reason(apply_error(status(422, "spec.replicas: Invalid value"))),
            "spec.replicas: Invalid value"
        );
    }
}
