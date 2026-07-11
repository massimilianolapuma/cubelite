pub mod commands;

use commands::kubernetes::{
    cluster_capacity, delete_pod, get_current_context, list_configmaps, list_contexts,
    list_deployments, list_events, list_helm_releases, list_ingresses, list_namespaces,
    list_pod_metrics, list_pods, list_secrets, list_services, probe_cluster, restart_deployment,
    scale_deployment, set_context, stop_logs, stream_logs, unwatch_resources, watch_resources,
    LogState, WatchState,
};

/// Entry point for the Tauri application.
pub fn run() {
    if let Err(e) = tauri::Builder::default()
        .manage(WatchState::default())
        .manage(LogState::default())
        .invoke_handler(tauri::generate_handler![
            list_pods,
            list_namespaces,
            list_deployments,
            list_services,
            list_ingresses,
            list_configmaps,
            list_secrets,
            list_events,
            list_helm_releases,
            list_pod_metrics,
            cluster_capacity,
            probe_cluster,
            watch_resources,
            unwatch_resources,
            stream_logs,
            stop_logs,
            delete_pod,
            restart_deployment,
            scale_deployment,
            list_contexts,
            get_current_context,
            set_context,
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("error while running tauri application: {e}");
        std::process::exit(1);
    }
}
