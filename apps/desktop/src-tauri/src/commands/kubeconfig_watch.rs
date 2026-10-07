//! Live reload of kubeconfig files (spec §3.1).
//!
//! Watches the parent directories of the listed files (editors and
//! `aws eks update-kubeconfig` replace files atomically, which a per-file
//! watch would miss), keeps only events for listed files, debounces them and
//! emits one `kubeconfig-changed` event with the changed paths.

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// Event name delivered to the webview.
pub const KUBECONFIG_CHANGED: &str = "kubeconfig-changed";
/// Quiet period after the last file event before emitting.
const DEBOUNCE: Duration = Duration::from_millis(500);

static KUBECONFIG_WATCH_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Tauri managed state: a single live watch. Aborting its task drops the
/// `notify` watcher it owns.
#[derive(Default)]
pub struct KubeconfigWatchState {
    /// The one live watch (id, task). `watch_kubeconfig` replaces and aborts it.
    current: Mutex<Option<(String, JoinHandle<()>)>>,
    /// Events emitted before this instant are the app's own kubeconfig write.
    suppress_until: Arc<Mutex<Option<Instant>>>,
}

/// Window after an app-driven kubeconfig write during which change events are the app's own.
pub const SELF_WRITE_WINDOW: Duration = Duration::from_millis(1500);

/// Record that the app is about to rewrite a kubeconfig file (context switch).
pub async fn mark_self_write(state: &KubeconfigWatchState) {
    *state.suppress_until.lock().await = Some(Instant::now() + SELF_WRITE_WINDOW);
}

/// True when `now` falls inside a recorded self-write window.
pub fn is_suppressed(now: Instant, suppress_until: Option<Instant>) -> bool {
    suppress_until.is_some_and(|until| now < until)
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

/// Split `dirs` into (existing, missing) using `Path::is_dir`.
pub fn partition_existing_dirs(dirs: &[PathBuf]) -> (Vec<PathBuf>, Vec<PathBuf>) {
    dirs.iter().cloned().partition(|d| d.is_dir())
}

/// Listed paths affected by a `notify` result. Errors and unclassified events
/// mean "anything may have changed" and yield the full listed set.
pub fn paths_for_event(result: &notify::Result<Event>, listed: &[PathBuf]) -> Vec<PathBuf> {
    match result {
        Err(_) => listed.to_vec(),
        Ok(event) => match event.kind {
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => event
                .paths
                .iter()
                .filter(|p| is_listed_change(p, listed))
                .cloned()
                .collect(),
            EventKind::Other | EventKind::Any => listed.to_vec(),
            EventKind::Access(_) => Vec::new(),
        },
    }
}

/// Start watching the listed kubeconfig files; returns a watch id. Replaces
/// (and aborts) any previous watch.
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
    let callback_listed = listed.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let matched = paths_for_event(&result, &callback_listed);
        if !matched.is_empty() {
            // Ignore send errors: the debounce task is gone, so is the watch.
            let _ = tx.send(matched);
        }
    })
    .map_err(|e| e.to_string())?;

    let (existing, _missing) = partition_existing_dirs(&watched_dirs(&listed));
    let mut failures: Vec<String> = Vec::new();
    let mut watched = 0usize;
    for dir in &existing {
        match watcher.watch(dir, RecursiveMode::NonRecursive) {
            Ok(()) => watched += 1,
            Err(e) => failures.push(format!("{}: {e}", dir.display())),
        }
    }
    if watched == 0 {
        let reasons = if failures.is_empty() {
            "no listed directory exists".to_string()
        } else {
            failures.join("; ")
        };
        return Err(format!("cannot watch any kubeconfig directory: {reasons}"));
    }

    let watch_id = KUBECONFIG_WATCH_COUNTER
        .fetch_add(1, Ordering::SeqCst)
        .to_string();
    let state = app.state::<KubeconfigWatchState>();
    let suppress_until = Arc::clone(&state.suppress_until);
    let app_clone = app.clone();
    let handle = tokio::spawn(async move {
        // Owns the watcher; aborting this task drops it and stops the watch.
        let _watcher = watcher;
        while let Some(first) = rx.recv().await {
            let mut changed: Vec<PathBuf> = first;
            // Debounce: swallow everything that arrives within the quiet period.
            loop {
                match tokio::time::timeout(DEBOUNCE, rx.recv()).await {
                    Ok(Some(more)) => changed.extend(more),
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
            changed.sort();
            changed.dedup();
            if changed.is_empty() {
                continue;
            }
            if is_suppressed(Instant::now(), *suppress_until.lock().await) {
                continue;
            }
            let payload = KubeconfigChanged {
                paths: changed.iter().map(|p| p.display().to_string()).collect(),
            };
            // Ignore emit errors — the window may have been closed.
            let _ = app_clone.emit(KUBECONFIG_CHANGED, payload);
        }
    });
    let previous = state
        .current
        .lock()
        .await
        .replace((watch_id.clone(), handle));
    if let Some((_, old)) = previous {
        old.abort();
    }
    Ok(watch_id)
}

/// Stop a kubeconfig watch started by [`watch_kubeconfig`]; aborting the task
/// drops its watcher. No-op when `watch_id` is not the live watch.
#[tauri::command]
pub async fn unwatch_kubeconfig(app: AppHandle, watch_id: String) -> Result<(), String> {
    let state = app.state::<KubeconfigWatchState>();
    let mut current = state.current.lock().await;
    if current.as_ref().is_some_and(|(id, _)| *id == watch_id) {
        if let Some((_, handle)) = current.take() {
            handle.abort();
        }
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

    fn ev(kind: EventKind, path: &str) -> notify::Result<Event> {
        Ok(Event::new(kind).add_path(PathBuf::from(path)))
    }

    #[test]
    fn paths_for_event_modify_listed() {
        let listed = [PathBuf::from("/k/config")];
        let r = ev(
            EventKind::Modify(notify::event::ModifyKind::Any),
            "/k/config",
        );
        assert_eq!(
            paths_for_event(&r, &listed),
            vec![PathBuf::from("/k/config")]
        );
    }

    #[test]
    fn paths_for_event_modify_unlisted_is_empty() {
        let listed = [PathBuf::from("/k/config")];
        let r = ev(
            EventKind::Modify(notify::event::ModifyKind::Any),
            "/k/other",
        );
        assert!(paths_for_event(&r, &listed).is_empty());
    }

    #[test]
    fn paths_for_event_error_and_other_return_all() {
        let listed = [PathBuf::from("/k/a"), PathBuf::from("/k/b")];
        let err: notify::Result<Event> = Err(notify::Error::generic("boom"));
        assert_eq!(paths_for_event(&err, &listed), listed.to_vec());
        let other = ev(EventKind::Other, "/k/zzz");
        assert_eq!(paths_for_event(&other, &listed), listed.to_vec());
    }

    #[test]
    fn paths_for_event_access_is_empty() {
        let listed = [PathBuf::from("/k/config")];
        let r = ev(
            EventKind::Access(notify::event::AccessKind::Any),
            "/k/config",
        );
        assert!(paths_for_event(&r, &listed).is_empty());
    }

    #[test]
    fn partition_existing_dirs_splits() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let present = tmp.path().to_path_buf();
        let missing = tmp.path().join("nope");
        let (e, m) = partition_existing_dirs(&[present.clone(), missing.clone()]);
        assert_eq!(e, vec![present]);
        assert_eq!(m, vec![missing]);
    }

    #[test]
    fn is_suppressed_windows() {
        let now = Instant::now();
        assert!(is_suppressed(now, Some(now + Duration::from_secs(1))));
        assert!(!is_suppressed(
            now + Duration::from_secs(2),
            Some(now + Duration::from_secs(1))
        ));
        assert!(!is_suppressed(now, None));
    }
}
