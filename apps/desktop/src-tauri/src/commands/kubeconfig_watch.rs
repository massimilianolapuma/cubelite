//! Live reload of kubeconfig files (spec §3.1).
//!
//! Watches the parent directories of the listed files (editors and
//! `aws eks update-kubeconfig` replace files atomically, which a per-file
//! watch would miss), keeps only events for listed files, debounces them and
//! emits one `kubeconfig-changed` event with the changed paths.

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// Event name delivered to the webview.
pub const KUBECONFIG_CHANGED: &str = "kubeconfig-changed";
/// Quiet period after the last file event before emitting.
const DEBOUNCE: Duration = Duration::from_millis(500);

static KUBECONFIG_WATCH_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Tauri managed state: one debounce task per watch id (dropping the task
/// drops the `notify` watcher it owns).
#[derive(Default)]
pub struct KubeconfigWatchState {
    handles: Mutex<HashMap<String, JoinHandle<()>>>,
}

/// Payload of [`KUBECONFIG_CHANGED`].
#[derive(Debug, Clone, Serialize)]
pub struct KubeconfigChanged {
    pub paths: Vec<String>,
}

/// Parent directories of `paths`, deduplicated, in first-seen order.
pub fn watched_dirs(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for path in paths {
        if let Some(parent) = path.parent() {
            if !dirs.iter().any(|d| d == parent) {
                dirs.push(parent.to_path_buf());
            }
        }
    }
    dirs
}

/// True when `event_path` is one of the listed files (exact match).
pub fn is_listed_change(event_path: &Path, listed: &[PathBuf]) -> bool {
    listed.iter().any(|p| p == event_path)
}

/// Start watching the listed kubeconfig files; returns a watch id.
#[tauri::command]
pub async fn watch_kubeconfig(app: AppHandle, paths: Vec<String>) -> Result<String, String> {
    let listed: Vec<PathBuf> = paths
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .collect();
    if listed.is_empty() {
        return Err("no kubeconfig paths to watch".to_string());
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<PathBuf>>();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        if let Ok(event) = result {
            if matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                // Ignore send errors: the debounce task is gone, so is the watch.
                let _ = tx.send(event.paths);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    for dir in watched_dirs(&listed) {
        watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .map_err(|e| format!("cannot watch {}: {e}", dir.display()))?;
    }

    let watch_id = KUBECONFIG_WATCH_COUNTER
        .fetch_add(1, Ordering::SeqCst)
        .to_string();
    let app_clone = app.clone();
    let handle = tokio::spawn(async move {
        // Owns the watcher; dropping this task stops it.
        let _watcher = watcher;
        while let Some(first) = rx.recv().await {
            let mut changed: Vec<PathBuf> = first
                .into_iter()
                .filter(|p| is_listed_change(p, &listed))
                .collect();
            // Debounce: swallow everything that arrives within the quiet period.
            loop {
                match tokio::time::timeout(DEBOUNCE, rx.recv()).await {
                    Ok(Some(more)) => {
                        changed.extend(more.into_iter().filter(|p| is_listed_change(p, &listed)))
                    }
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
            changed.sort();
            changed.dedup();
            if changed.is_empty() {
                continue;
            }
            let payload = KubeconfigChanged {
                paths: changed.iter().map(|p| p.display().to_string()).collect(),
            };
            // Ignore emit errors — the window may have been closed.
            let _ = app_clone.emit(KUBECONFIG_CHANGED, payload);
        }
    });
    app.state::<KubeconfigWatchState>()
        .handles
        .lock()
        .await
        .insert(watch_id.clone(), handle);
    Ok(watch_id)
}

/// Stop a kubeconfig watch started by [`watch_kubeconfig`].
#[tauri::command]
pub async fn unwatch_kubeconfig(app: AppHandle, watch_id: String) -> Result<(), String> {
    if let Some(handle) = app
        .state::<KubeconfigWatchState>()
        .handles
        .lock()
        .await
        .remove(&watch_id)
    {
        handle.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn watched_dirs_dedupes_parents_in_order() {
        let dirs = watched_dirs(&[
            PathBuf::from("/home/u/.kube/config"),
            PathBuf::from("/home/u/.kube/team.yaml"),
            PathBuf::from("/opt/kube/other"),
        ]);
        assert_eq!(
            dirs,
            vec![PathBuf::from("/home/u/.kube"), PathBuf::from("/opt/kube")]
        );
    }

    #[test]
    fn is_listed_change_matches_exact_paths_only() {
        let listed = [PathBuf::from("/home/u/.kube/config")];
        assert!(is_listed_change(Path::new("/home/u/.kube/config"), &listed));
        assert!(!is_listed_change(
            Path::new("/home/u/.kube/config.swp"),
            &listed
        ));
        assert!(!is_listed_change(
            Path::new("/home/u/.kube/team.yaml"),
            &listed
        ));
    }
}
