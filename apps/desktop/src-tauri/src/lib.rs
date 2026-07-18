pub mod commands;
pub mod env;

use commands::kubernetes::{
    cluster_capacity, delete_pod, get_current_context, get_pod_containers, get_resource_yaml,
    list_configmaps, list_contexts, list_cronjobs, list_deployments, list_events,
    list_helm_releases, list_ingresses, list_jobs, list_namespaces, list_nodes, list_pod_metrics,
    list_pods, list_pvcs, list_secrets, list_services, list_statefulsets, probe_cluster,
    restart_deployment, scale_deployment, set_context, start_port_forward, stop_logs,
    stop_port_forward, stream_logs, stream_pod_log, unwatch_resources, watch_resources, LogState,
    PortForwardState, WatchState,
};

/// Entry point for the Tauri application.
pub fn run() {
    // Must run before anything can spawn kubeconfig exec plugins.
    env::fix_path();

    if let Err(e) = tauri::Builder::default()
        .manage(WatchState::default())
        .manage(LogState::default())
        .manage(PortForwardState::default())
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
            list_jobs,
            list_cronjobs,
            list_statefulsets,
            list_nodes,
            list_pvcs,
            get_resource_yaml,
            watch_resources,
            unwatch_resources,
            stream_logs,
            stream_pod_log,
            get_pod_containers,
            stop_logs,
            delete_pod,
            restart_deployment,
            scale_deployment,
            list_contexts,
            get_current_context,
            set_context,
            start_port_forward,
            stop_port_forward,
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("error while running tauri application: {e}");
        std::process::exit(1);
    }
}
