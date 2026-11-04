//! Cluster and node history and the firing alerts from Prometheus (#530),
//! on the cached connections of [`super::prometheus`].

use cubelite_core::prometheus::alerts::AlertsResult;
use cubelite_core::prometheus::nodes::HostMetrics;
use cubelite_core::prometheus::{MetricsRange, PromEndpoint};
use tauri::State;

use super::prometheus::{with_connection, PrometheusState};

/// The Overview's cluster CPU and memory against allocatable.
#[tauri::command]
pub async fn prometheus_cluster_usage(
    state: State<'_, PrometheusState>,
    kubeconfig_path: String,
    context: String,
    endpoint: PromEndpoint,
    range: MetricsRange,
) -> Result<HostMetrics, String> {
    let ep = endpoint.clone();
    with_connection(
        &state,
        (kubeconfig_path, context),
        &endpoint,
        |conn| async move { conn.cluster_usage(&ep, range).await },
    )
    .await
}

/// A node's Metrics section.
#[tauri::command]
pub async fn prometheus_node_metrics(
    state: State<'_, PrometheusState>,
    kubeconfig_path: String,
    context: String,
    endpoint: PromEndpoint,
    node: String,
    range: MetricsRange,
) -> Result<HostMetrics, String> {
    let ep = endpoint.clone();
    with_connection(
        &state,
        (kubeconfig_path, context),
        &endpoint,
        |conn| async move { conn.node_metrics(&ep, &node, range).await },
    )
    .await
}

/// The firing alerts, most severe first.
#[tauri::command]
pub async fn prometheus_alerts(
    state: State<'_, PrometheusState>,
    kubeconfig_path: String,
    context: String,
    endpoint: PromEndpoint,
) -> Result<AlertsResult, String> {
    let ep = endpoint.clone();
    with_connection(
        &state,
        (kubeconfig_path, context),
        &endpoint,
        |conn| async move { conn.alerts(&ep).await },
    )
    .await
}
