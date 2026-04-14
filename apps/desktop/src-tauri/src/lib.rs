pub mod commands;

use commands::kubernetes::{
    list_deployments, list_namespaces, list_pods, unwatch_resources, watch_resources, WatchState,
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
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("error while running tauri application: {e}");
        std::process::exit(1);
    }
}
