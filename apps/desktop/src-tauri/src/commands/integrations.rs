//! Finding the integrations' services when a context connects (#527).
//!
//! Only the Kubernetes API is contacted: Elasticsearch and Prometheus are
//! reached, and ECK secrets read, only when the user enables them.

use cubelite_core::integration::{self, Detected};

use super::elastic::kube;

/// Elasticsearch, Kibana, Prometheus and Grafana services of the context,
/// from one listing of the services across namespaces. Nothing is found
/// (no error) when the user may not list them.
#[tauri::command]
pub async fn integrations_detect(
    kubeconfig_path: String,
    context: String,
) -> Result<Detected, String> {
    integration::detect_all(kube(&kubeconfig_path, &context).await?.client()).await
}
