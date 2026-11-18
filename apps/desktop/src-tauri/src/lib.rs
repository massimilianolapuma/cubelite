pub mod clipboard;
pub mod commands;
pub mod env;

use tauri::Manager;

use clipboard::ClipboardState;
use commands::elastic::{
    elastic_auth_method, elastic_close_cursor, elastic_detect, elastic_disconnect,
    elastic_save_auth, elastic_search, elastic_test, elastic_use_eck_credentials,
    kibana_discover_url, kibana_port_forward, open_kibana_discover, open_kibana_home,
    open_kibana_workload, ElasticState,
};
use commands::integrations::integrations_detect;
use commands::kubeconfig_watch::{unwatch_kubeconfig, watch_kubeconfig, KubeconfigWatchState};
use commands::kubernetes::{
    apply_resource_yaml, cluster_capacity, delete_pod, discover_resource_kinds, exec_send,
    export_log, get_current_context, get_dynamic_resource_yaml, get_pod_containers,
    get_resource_yaml, kubeconfig_sources, list_configmaps, list_contexts, list_cronjobs,
    list_daemonsets, list_deployments, list_events, list_helm_releases, list_ingresses, list_jobs,
    list_namespaces, list_nodes, list_pod_metrics, list_pods, list_pvcs, list_resource_table,
    list_secrets, list_services, list_statefulsets, probe_cluster, restart_deployment,
    scale_deployment, set_context, start_exec, start_port_forward, stop_exec, stop_logs,
    stop_port_forward, stream_logs, stream_pod_log, unwatch_resources, watch_resources, ExecState,
    LogState, PortForwardState, WatchState,
};
use commands::limits::{
    apply_resources, clear_resources_override, evaluate_resources, resource_facts,
};
use commands::prometheus::{
    grafana_port_forward, open_grafana_explore, open_grafana_home, open_grafana_workload,
    prometheus_auth_method, prometheus_detect, prometheus_disconnect, prometheus_metrics,
    prometheus_save_auth, prometheus_sparklines, prometheus_test, PrometheusState,
};
use commands::prometheus_cluster::{
    prometheus_alert_expr, prometheus_alerts, prometheus_cluster_usage, prometheus_node_metrics,
};
use commands::secrets::{copy_secret_value, export_secret_env, reveal_secret_value};

/// Entry point for the Tauri application.
pub fn run() {
    // Must run before anything can spawn kubeconfig exec plugins.
    env::fix_path();
    env::import_kubeconfig();

    let app = tauri::Builder::default()
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
        .manage(ClipboardState::default())
        .invoke_handler(tauri::generate_handler![
            elastic_detect,
            integrations_detect,
            kibana_port_forward,
            prometheus_detect,
            prometheus_test,
            prometheus_metrics,
            prometheus_sparklines,
            prometheus_cluster_usage,
            prometheus_node_metrics,
            prometheus_alerts,
            prometheus_alert_expr,
            prometheus_save_auth,
            prometheus_auth_method,
            prometheus_disconnect,
            grafana_port_forward,
            open_grafana_explore,
            open_grafana_workload,
            open_grafana_home,
            elastic_test,
            elastic_search,
            elastic_close_cursor,
            elastic_save_auth,
            elastic_auth_method,
            elastic_use_eck_credentials,
            elastic_disconnect,
            kibana_discover_url,
            open_kibana_discover,
            open_kibana_workload,
            open_kibana_home,
            list_pods,
            list_namespaces,
            list_deployments,
            list_services,
            list_ingresses,
            list_configmaps,
            list_secrets,
            reveal_secret_value,
            copy_secret_value,
            export_secret_env,
            list_events,
            list_helm_releases,
            list_pod_metrics,
            cluster_capacity,
            probe_cluster,
            list_jobs,
            list_cronjobs,
            list_statefulsets,
            list_daemonsets,
            list_nodes,
            list_pvcs,
            get_resource_yaml,
            discover_resource_kinds,
            list_resource_table,
            get_dynamic_resource_yaml,
            apply_resource_yaml,
            resource_facts,
            evaluate_resources,
            apply_resources,
            clear_resources_override,
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
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|handle, event| {
            // Every exit the app is told about, the restart after an update
            // included: a pending clipboard clear runs now, on its condition
            // (#661). A crash or a kill is not covered.
            if let tauri::RunEvent::Exit = event {
                handle
                    .state::<ClipboardState>()
                    .clear_pending_now(EXIT_CLEAR_WAIT);
            }
        }),
        Err(e) => {
            eprintln!("error while running tauri application: {e}");
            std::process::exit(1);
        }
    }
}

/// How long the exit waits for a pending clipboard clear.
const EXIT_CLEAR_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
