use cubelite_core::{
    client::KubeClient,
    resources::{DeploymentInfo, NamespaceInfo, PodInfo},
};
use std::path::Path;

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
