use cubelite_core::{
    client::KubeClient,
    resources::{DeploymentInfo, NamespaceInfo, PodInfo},
    ResourceType, ResourceWatcher, WatchEvent,
};
use futures::StreamExt;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// Monotonically increasing counter for generating unique watch IDs.
static WATCH_COUNTER: AtomicU64 = AtomicU64::new(1);

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

/// Start watching a Kubernetes resource type and emit Tauri events for each change.
///
/// `resource_type` must be one of `"pod"`, `"namespace"`, or `"deployment"`.
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
