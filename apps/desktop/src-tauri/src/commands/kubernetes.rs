use cubelite_core::{
    client::KubeClient,
    helm::HelmReleaseInfo,
    logs::{stream_pod_logs, stream_pod_logs_opts, LogStreamOptions},
    metrics::{NodeCapacityInfo, PodMetricsInfo},
    portforward::forward_pod_port,
    resources::{
        ConfigMapInfo, ContainerDetail, CronJobInfo, DeploymentInfo, EventInfo, IngressInfo,
        JobInfo, NamespaceInfo, NodeInfo, PodInfo, PvcInfo, SecretInfo, ServiceInfo,
        StatefulSetInfo,
    },
    ResourceType, ResourceWatcher, WatchEvent,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// Monotonically increasing counter for generating unique watch IDs.
static WATCH_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Monotonically increasing counter for generating unique log stream IDs.
static LOG_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Maximum number of pods aggregated into one log stream.
const MAX_LOG_PODS: usize = 20;

/// Tauri managed state holding all active log stream task handles.
///
/// Keyed by the stream ID string returned from [`stream_logs`]; each stream
/// aggregates one task per followed pod.
#[derive(Default)]
pub struct LogState {
    handles: Mutex<HashMap<String, Vec<JoinHandle<()>>>>,
}

/// A pod to follow in an aggregated log stream.
#[derive(Debug, Deserialize)]
pub struct PodRef {
    /// Namespace of the pod.
    pub namespace: String,
    /// Pod name.
    pub name: String,
}

/// Monotonically increasing counter for generating unique forward IDs.
static FORWARD_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Tauri managed state holding all active port-forward accept loops.
///
/// Keyed by the session ID returned from [`start_port_forward`].
#[derive(Default)]
pub struct PortForwardState {
    handles: Mutex<HashMap<String, JoinHandle<()>>>,
}

/// Result of starting a port-forward session.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStartResult {
    /// Session ID for [`stop_port_forward`].
    pub id: String,
    /// The actually-bound local port (relevant when 0 = auto was requested).
    pub local_port: u16,
}

/// Starts forwarding `127.0.0.1:<local_port>` → `<pod>:<remote_port>`.
///
/// `local_port == 0` auto-assigns a free port; the bound port is returned.
/// Errors (kubeconfig, port in use) are returned as strings for the UI.
#[tauri::command]
pub async fn start_port_forward(
    app: AppHandle,
    kubeconfig_path: String,
    context: Option<String>,
    namespace: String,
    pod: String,
    local_port: u16,
    remote_port: u16,
) -> Result<ForwardStartResult, String> {
    let kube_client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    let (bound, handle) =
        forward_pod_port(kube_client.client(), namespace, pod, local_port, remote_port)
            .await
            .map_err(|e| e.to_string())?;

    let id = FORWARD_COUNTER.fetch_add(1, Ordering::SeqCst).to_string();
    app.state::<PortForwardState>()
        .handles
        .lock()
        .await
        .insert(id.clone(), handle);

    Ok(ForwardStartResult {
        id,
        local_port: bound,
    })
}

/// Stops a port-forward session: aborts the accept loop and drops the
/// local listener. Connections already established keep relaying until
/// either side closes.
#[tauri::command]
pub async fn stop_port_forward(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(handle) = app
        .state::<PortForwardState>()
        .handles
        .lock()
        .await
        .remove(&id)
    {
        handle.abort();
    }
    Ok(())
}

/// Tauri managed state holding all active watch task handles.
///
/// Keyed by the watch ID string returned from [`watch_resources`].
#[derive(Default)]
pub struct WatchState {
    handles: Mutex<HashMap<String, JoinHandle<()>>>,
}

/// List pods in the given namespace for the specified kubeconfig context.
#[tauri::command]
pub async fn list_pods(
    kubeconfig_path: String,
    namespace: Option<String>,
    context: Option<String>,
) -> Result<Vec<PodInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .list_pods(namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// List all namespaces accessible from the specified kubeconfig context.
#[tauri::command]
pub async fn list_namespaces(
    kubeconfig_path: String,
    context: Option<String>,
) -> Result<Vec<NamespaceInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client.list_namespaces().await.map_err(|e| e.to_string())
}

/// List all deployments in the given namespace for the specified kubeconfig context.
#[tauri::command]
pub async fn list_deployments(
    kubeconfig_path: String,
    namespace: String,
    context: Option<String>,
) -> Result<Vec<DeploymentInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .list_deployments(&namespace)
        .await
        .map_err(|e| e.to_string())
}

/// List services in the given namespace (all namespaces when `None`).
#[tauri::command]
pub async fn list_services(
    kubeconfig_path: String,
    namespace: Option<String>,
    context: Option<String>,
) -> Result<Vec<ServiceInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .list_services(namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// List ingresses in the given namespace (all namespaces when `None`).
#[tauri::command]
pub async fn list_ingresses(
    kubeconfig_path: String,
    namespace: Option<String>,
    context: Option<String>,
) -> Result<Vec<IngressInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .list_ingresses(namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// List config maps in the given namespace (all namespaces when `None`).
#[tauri::command]
pub async fn list_configmaps(
    kubeconfig_path: String,
    namespace: Option<String>,
    context: Option<String>,
) -> Result<Vec<ConfigMapInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .list_configmaps(namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// List secrets in the given namespace (all namespaces when `None`).
///
/// Secret values are base64-decoded locally in the Rust backend and never
/// leave the machine.
#[tauri::command]
pub async fn list_secrets(
    kubeconfig_path: String,
    namespace: Option<String>,
    context: Option<String>,
) -> Result<Vec<SecretInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .list_secrets(namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// List events in the given namespace (all namespaces when `None`),
/// sorted most-recent first.
#[tauri::command]
pub async fn list_events(
    kubeconfig_path: String,
    namespace: Option<String>,
    context: Option<String>,
) -> Result<Vec<EventInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .list_events(namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Start watching a Kubernetes resource type and emit Tauri events for each change.
///
/// `resource_type` must be one of `"pod"`, `"namespace"`, `"deployment"`,
/// `"service"`, `"ingress"`, `"configmap"`, or `"secret"`.
/// Returns a unique watch ID that can be passed to [`unwatch_resources`] to stop
/// the stream.
///
/// Emitted events:
/// - `"resource-updated"` — resource created or updated
/// - `"resource-deleted"` — resource deleted
/// - `"watch-error"`     — watcher encountered an error
#[tauri::command]
pub async fn watch_resources(
    app: AppHandle,
    kubeconfig_path: String,
    namespace: Option<String>,
    resource_type: String,
    context: Option<String>,
) -> Result<String, String> {
    let rt: ResourceType = serde_json::from_value(serde_json::Value::String(resource_type))
        .map_err(|e| format!("invalid resource_type: {e}"))?;

    let kube_client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    let watcher = ResourceWatcher::new(kube_client.client());
    let mut stream = watcher.watch_resources(namespace.as_deref(), rt);

    let watch_id = WATCH_COUNTER.fetch_add(1, Ordering::SeqCst).to_string();

    let app_clone = app.clone();
    let handle = tokio::spawn(async move {
        while let Some(event) = stream.next().await {
            let event_name = match &event {
                WatchEvent::Applied(_) => "resource-updated",
                WatchEvent::Deleted(_) => "resource-deleted",
                WatchEvent::Error(_) => "watch-error",
            };
            // Ignore emit errors — the frontend window may have been closed.
            let _ = app_clone.emit(event_name, event);
        }
    });

    app.state::<WatchState>()
        .handles
        .lock()
        .await
        .insert(watch_id.clone(), handle);

    Ok(watch_id)
}

/// List Helm v3 releases (latest revision per release) in the given
/// namespace (all namespaces when `None`).
#[tauri::command]
pub async fn list_helm_releases(
    kubeconfig_path: String,
    namespace: Option<String>,
    context: Option<String>,
) -> Result<Vec<HelmReleaseInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .list_helm_releases(namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Fetch pod CPU/memory usage from metrics-server (404 when absent).
#[tauri::command]
pub async fn list_pod_metrics(
    kubeconfig_path: String,
    namespace: Option<String>,
    context: Option<String>,
) -> Result<Vec<PodMetricsInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .list_pod_metrics(namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Per-node usage + allocatable capacity (node inventory for the UI).
#[tauri::command]
pub async fn cluster_capacity(
    kubeconfig_path: String,
    context: Option<String>,
) -> Result<Vec<NodeCapacityInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client.cluster_capacity().await.map_err(|e| e.to_string())
}

/// Result of a cluster reachability probe.
#[derive(Debug, Serialize)]
pub struct ClusterHealthInfo {
    /// Context name that was probed.
    pub context: String,
    /// `true` when the API server answered /version.
    pub reachable: bool,
    /// Kubernetes server version, when reachable.
    pub version: Option<String>,
    /// Node count, when the caller may list nodes.
    pub node_count: Option<usize>,
    /// Failure reason, when unreachable.
    pub error: Option<String>,
}

/// Probe one context with short timeouts: /version + best-effort node count.
#[tauri::command]
pub async fn probe_cluster(
    kubeconfig_path: String,
    context: String,
) -> Result<ClusterHealthInfo, String> {
    let client = match KubeClient::new_probe(Path::new(&kubeconfig_path), Some(&context)).await {
        Ok(c) => c,
        Err(e) => {
            return Ok(ClusterHealthInfo {
                context,
                reachable: false,
                version: None,
                node_count: None,
                error: Some(e.to_string()),
            });
        }
    };

    match client.server_version().await {
        Ok(version) => {
            // Node listing may be forbidden; the probe still counts as healthy.
            let node_count = client.node_count().await.ok();
            Ok(ClusterHealthInfo {
                context,
                reachable: true,
                version: Some(version),
                node_count,
                error: None,
            })
        }
        Err(e) => Ok(ClusterHealthInfo {
            context,
            reachable: false,
            version: None,
            node_count: None,
            error: Some(e.to_string()),
        }),
    }
}

/// List jobs in the given namespace (all namespaces when `None`).
#[tauri::command]
pub async fn list_jobs(
    kubeconfig_path: String,
    namespace: Option<String>,
    context: Option<String>,
) -> Result<Vec<JobInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .list_jobs(namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// List cron jobs in the given namespace (all namespaces when `None`).
#[tauri::command]
pub async fn list_cronjobs(
    kubeconfig_path: String,
    namespace: Option<String>,
    context: Option<String>,
) -> Result<Vec<CronJobInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .list_cronjobs(namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// List stateful sets in the given namespace (all namespaces when `None`).
#[tauri::command]
pub async fn list_statefulsets(
    kubeconfig_path: String,
    namespace: Option<String>,
    context: Option<String>,
) -> Result<Vec<StatefulSetInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .list_statefulsets(namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// List persistent volume claims in the given namespace (all namespaces when `None`).
#[tauri::command]
pub async fn list_pvcs(
    kubeconfig_path: String,
    namespace: Option<String>,
    context: Option<String>,
) -> Result<Vec<PvcInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .list_pvcs(namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// List cluster nodes (read-only inventory).
#[tauri::command]
pub async fn list_nodes(
    kubeconfig_path: String,
    context: Option<String>,
) -> Result<Vec<NodeInfo>, String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client.list_nodes().await.map_err(|e| e.to_string())
}

/// Render one resource as cleaned YAML (managedFields stripped).
///
/// `resource_type` accepts the same lowercase names as `watch_resources`.
#[tauri::command]
pub async fn get_resource_yaml(
    kubeconfig_path: String,
    resource_type: String,
    namespace: String,
    name: String,
    context: Option<String>,
) -> Result<String, String> {
    let rt: ResourceType = serde_json::from_value(serde_json::Value::String(resource_type))
        .map_err(|e| format!("invalid resource_type: {e}"))?;

    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .get_resource_yaml(rt, &namespace, &name)
        .await
        .map_err(|e| e.to_string())
}

/// Delete a pod (the owning controller will recreate it).
#[tauri::command]
pub async fn delete_pod(
    kubeconfig_path: String,
    namespace: String,
    name: String,
    context: Option<String>,
) -> Result<(), String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .delete_pod(&namespace, &name)
        .await
        .map_err(|e| e.to_string())
}

/// Trigger a rolling restart of a deployment (kubectl rollout restart).
#[tauri::command]
pub async fn restart_deployment(
    kubeconfig_path: String,
    namespace: String,
    name: String,
    context: Option<String>,
) -> Result<(), String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .restart_deployment(&namespace, &name)
        .await
        .map_err(|e| e.to_string())
}

/// Scale a deployment to the given number of replicas.
#[tauri::command]
pub async fn scale_deployment(
    kubeconfig_path: String,
    namespace: String,
    name: String,
    replicas: i32,
    context: Option<String>,
) -> Result<(), String> {
    let client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    client
        .scale_deployment(&namespace, &name, replicas)
        .await
        .map_err(|e| e.to_string())
}

/// Start an aggregated log stream over the given pods (capped at 20).
///
/// Each line is parsed (timestamp + severity) and emitted as a `"log-line"`
/// Tauri event with a `LogLine` payload. Returns a stream ID for
/// [`stop_logs`].
#[tauri::command]
pub async fn stream_logs(
    app: AppHandle,
    kubeconfig_path: String,
    pods: Vec<PodRef>,
    context: Option<String>,
) -> Result<String, String> {
    let kube_client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let client = kube_client.client();

    let stream_id = LOG_COUNTER.fetch_add(1, Ordering::SeqCst).to_string();
    let mut handles = Vec::new();

    for pod in pods.into_iter().take(MAX_LOG_PODS) {
        let app_clone = app.clone();
        let mut stream = stream_pod_logs(client.clone(), pod.namespace, pod.name, 50);
        handles.push(tokio::spawn(async move {
            while let Some(line) = stream.next().await {
                // Ignore emit errors — the frontend window may have been closed.
                let _ = app_clone.emit("log-line", line);
            }
        }));
    }

    app.state::<LogState>()
        .handles
        .lock()
        .await
        .insert(stream_id.clone(), handles);

    Ok(stream_id)
}

/// Start a single-container log stream for the log panel.
///
/// Lines are emitted as `pod-log-line:{stream_id}` events (a `LogLine`
/// payload each); when the stream ends — server drop, previous-instance
/// fetch completed — a final `pod-log-end:{stream_id}` event fires so the
/// frontend session store can reconnect with backoff. Returns the stream ID
/// for [`stop_logs`].
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stream_pod_log(
    app: AppHandle,
    kubeconfig_path: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    previous: bool,
    tail_lines: Option<i64>,
    since_time: Option<String>,
    context: Option<String>,
) -> Result<String, String> {
    let kube_client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let client = kube_client.client();

    let stream_id = LOG_COUNTER.fetch_add(1, Ordering::SeqCst).to_string();
    let opts = LogStreamOptions {
        container,
        previous,
        follow: !previous,
        tail_lines: tail_lines.unwrap_or(500),
        since_time,
    };

    let app_clone = app.clone();
    let id_clone = stream_id.clone();
    let mut stream = stream_pod_logs_opts(client, namespace, pod, opts);
    let handle = tokio::spawn(async move {
        while let Some(line) = stream.next().await {
            // Ignore emit errors — the frontend window may have been closed.
            let _ = app_clone.emit(&format!("pod-log-line:{id_clone}"), line);
        }
        let _ = app_clone.emit(&format!("pod-log-end:{id_clone}"), ());
    });

    app.state::<LogState>()
        .handles
        .lock()
        .await
        .insert(stream_id.clone(), vec![handle]);

    Ok(stream_id)
}

/// Fetch one pod's containers (app, sidecar, init) with live status.
#[tauri::command]
pub async fn get_pod_containers(
    kubeconfig_path: String,
    namespace: String,
    pod: String,
    context: Option<String>,
) -> Result<Vec<ContainerDetail>, String> {
    let kube_client = KubeClient::new(Path::new(&kubeconfig_path), context.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    kube_client
        .get_pod_containers(&namespace, &pod)
        .await
        .map_err(|e| e.to_string())
}

/// Stop an aggregated log stream by its stream ID.
///
/// All per-pod tasks are aborted. Silently succeeds if `stream_id` is not
/// found.
#[tauri::command]
pub async fn stop_logs(app: AppHandle, stream_id: String) -> Result<(), String> {
    if let Some(handles) = app
        .state::<LogState>()
        .handles
        .lock()
        .await
        .remove(&stream_id)
    {
        for handle in handles {
            handle.abort();
        }
    }
    Ok(())
}

/// Stop a running watch stream by its watch ID.
///
/// The spawned task is aborted and the handle is removed from managed state.
/// Silently succeeds if `watch_id` is not found.
#[tauri::command]
pub async fn unwatch_resources(app: AppHandle, watch_id: String) -> Result<(), String> {
    if let Some(handle) = app
        .state::<WatchState>()
        .handles
        .lock()
        .await
        .remove(&watch_id)
    {
        handle.abort();
    }
    Ok(())
}

/// List all contexts from the kubeconfig.
#[tauri::command]
pub async fn list_contexts() -> Result<Vec<cubelite_core::ContextInfo>, String> {
    tokio::task::spawn_blocking(|| {
        cubelite_core::context::list_context_infos().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Get the name of the currently active context.
#[tauri::command]
pub async fn get_current_context() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| {
        cubelite_core::context::current_context().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Switch to a different kubeconfig context (persists to disk).
#[tauri::command]
pub async fn set_context(context_name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        cubelite_core::context::set_active_context(&context_name).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
