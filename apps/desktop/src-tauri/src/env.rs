//! PATH repair for GUI-launched processes.
//!
//! Apps started from Finder/launchd (macOS) or a desktop launcher (Linux)
//! inherit a minimal PATH, so kubeconfig `exec` credential plugins
//! (`kubelogin`, `aws`, `gke-gcloud-auth-plugin`, krew plugins, …) spawned
//! by kube-rs are not found. At startup we ask the user's login shell for
//! its PATH and merge it into the process environment.

use std::process::Command;

/// Merge `extra` PATH entries after `current`, deduplicating while keeping
/// order (current entries win).
fn merge_paths(current: &str, extra: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut merged = Vec::new();
    for entry in current.split(':').chain(extra.split(':')) {
        if entry.is_empty() {
            continue;
        }
        if seen.insert(entry.to_string()) {
            merged.push(entry);
        }
    }
    merged.join(":")
}

/// Well-known plugin locations appended even when the shell probe fails.
fn fallback_entries() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    [
        "/usr/local/bin".to_string(),
        "/opt/homebrew/bin".to_string(),
        format!("{home}/.krew/bin"),
        format!("{home}/.local/bin"),
    ]
    .join(":")
}

/// Ask the user's login shell for its PATH (GUI processes get a minimal one).
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok()?;
    let output = Command::new(shell)
        .args(["-lc", "printf %s \"$PATH\""])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8(output.stdout).ok()?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Repair PATH so kubeconfig exec credential plugins resolve.
///
/// No-op on Windows (GUI processes inherit the full user PATH there).
pub fn fix_path() {
    #[cfg(unix)]
    {
        let current = std::env::var("PATH").unwrap_or_default();
        let shell_path = login_shell_path().unwrap_or_default();
        let merged = merge_paths(&merge_paths(&current, &shell_path), &fallback_entries());
        // Setting PATH for our own process before any threads spawn plugins.
        std::env::set_var("PATH", merged);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_order_and_dedupes() {
        let merged = merge_paths("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin");
        assert_eq!(merged, "/usr/bin:/bin:/opt/homebrew/bin");
    }

    #[test]
    fn merge_skips_empty_entries() {
        let merged = merge_paths("", "/usr/local/bin::/bin");
        assert_eq!(merged, "/usr/local/bin:/bin");
    }

    #[test]
    fn fallbacks_include_krew() {
        assert!(fallback_entries().contains(".krew/bin"));
    }
}
