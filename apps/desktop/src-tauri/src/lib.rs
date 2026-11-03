pub mod commands;
pub mod env;

use commands::elastic::{
    elastic_auth_method, elastic_close_cursor, elastic_detect, elastic_disconnect,
    elastic_save_auth, elastic_search, elastic_test, elastic_use_eck_credentials,
    kibana_discover_url, kibana_port_forward, open_kibana_discover, ElasticState,
};
use commands::kubeconfig_watch::{unwatch_kubeconfig, watch_kubeconfig, KubeconfigWatchState};
use commands::kubernetes::{
    apply_resource_yaml, cluster_capacity, delete_pod, exec_send, export_log, get_current_context,
    get_pod_containers, get_resource_yaml, kubeconfig_sources, list_configmaps, list_contexts,
    list_cronjobs, list_deployments, list_events, list_helm_releases, list_ingresses, list_jobs,
    list_namespaces, list_nodes, list_pod_metrics, list_pods, list_pvcs, list_secrets,
    list_services, list_statefulsets, probe_cluster, restart_deployment, scale_deployment,
    set_context, start_exec, start_port_forward, stop_exec, stop_logs, stop_port_forward,
    stream_logs, stream_pod_log, unwatch_resources, watch_resources, ExecState, LogState,
    PortForwardState, WatchState,
};
use commands::prometheus::{
    grafana_port_forward, open_grafana_explore, prometheus_auth_method, prometheus_detect,
    prometheus_disconnect, prometheus_metrics, prometheus_save_auth, prometheus_sparklines,
    prometheus_test, PrometheusState,
};

/// Entry point for the Tauri application.
pub fn run() {
    // Must run before anything can spawn kubeconfig exec plugins.
    env::fix_path();
    env::import_kubeconfig();

    if let Err(e) = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(WatchState::default())
        .manage(KubeconfigWatchState::default())
        .manage(LogState::default())
        .manage(PortForwardState::default())
        .manage(ExecState::default())
        .manage(ElasticState::default())
        .manage(PrometheusState::default())
        .invoke_handler(tauri::generate_handler![
            elastic_detect,
            kibana_port_forward,
            prometheus_detect,
            prometheus_test,
            prometheus_metrics,
            prometheus_sparklines,
            prometheus_save_auth,
            prometheus_auth_method,
            prometheus_disconnect,
            grafana_port_forward,
            open_grafana_explore,
            elastic_test,
            elastic_search,
            elastic_close_cursor,
            elastic_save_auth,
            elastic_auth_method,
            elastic_use_eck_credentials,
            elastic_disconnect,
            kibana_discover_url,
            open_kibana_discover,
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
            apply_resource_yaml,
            start_exec,
            exec_send,
            stop_exec,
            watch_resources,
            unwatch_resources,
            watch_kubeconfig,
            unwatch_kubeconfig,
            stream_logs,
            stream_pod_log,
            get_pod_containers,
            stop_logs,
            delete_pod,
            restart_deployment,
            scale_deployment,
            list_contexts,
            kubeconfig_sources,
            get_current_context,
            set_context,
            start_port_forward,
            stop_port_forward,
            export_log,
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("error while running tauri application: {e}");
        std::process::exit(1);
    }
}
