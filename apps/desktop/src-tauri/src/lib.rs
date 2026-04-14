pub mod commands;

use commands::kubernetes::{
    get_current_context, list_contexts, list_deployments, list_namespaces, list_pods, set_context,
    unwatch_resources, watch_resources, WatchState,
};

/// Entry point for the Tauri application.
pub fn run() {
    if let Err(e) = tauri::Builder::default()
        .manage(WatchState::default())
        .invoke_handler(tauri::generate_handler![
            list_pods,
            list_namespaces,
            list_deployments,
            watch_resources,
            unwatch_resources,
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
