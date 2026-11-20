mod cache;
pub mod configmaps;
pub mod elastic;
pub mod integrations;
pub mod kubeconfig_watch;
pub mod kubernetes;
pub mod limits;
pub mod prometheus;
pub mod prometheus_cluster;
pub mod secrets;
mod vault;
mod web_ui;

/// The label of the app's main window; the log pop-outs are `logs-…`.
const MAIN_WINDOW: &str = "main";

/// Whether a command's caller is the main window. The log pop-out windows
/// share the main window's capability; the commands that read one value of
/// a Secret or a ConfigMap serve the main window only.
pub(crate) fn is_main_window(label: &str) -> bool {
    label == MAIN_WINDOW
}
