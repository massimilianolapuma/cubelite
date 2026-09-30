//! PATH repair for GUI-launched processes.
//!
//! Apps started from Finder/launchd (macOS) or a desktop launcher (Linux)
//! inherit a minimal PATH, so kubeconfig `exec` credential plugins
//! (`kubelogin`, `aws`, `gke-gcloud-auth-plugin`, krew plugins, …) spawned
//! by kube-rs are not found. At startup we ask the user's login shell for
//! its PATH and merge it into the process environment. The same probe
//! imports `KUBECONFIG` when the shell exports it and the process lacks it,
//! so a multi-file kubeconfig list set in `~/.zshrc` works from the Dock.

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

/// Ask the user's login shell for the value of `var` (GUI processes get a
/// minimal environment). `None` when unset, empty or the probe fails.
fn login_shell_var(var: &str) -> Option<String> {
    let shell = std::env::var("SHELL").ok()?;
    let output = Command::new(shell)
        .args(["-lc", &format!("printf %s \"${var}\"")])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// The `KUBECONFIG` value to import: the shell's value, only when the
/// process has none of its own (an explicit process value always wins).
fn pick_kubeconfig(current: Option<&str>, shell: Option<&str>) -> Option<String> {
    if current.is_some_and(|c| !c.trim().is_empty()) {
        return None;
    }
    shell
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Repair PATH so kubeconfig exec credential plugins resolve.
///
/// No-op on Windows (GUI processes inherit the full user PATH there).
pub fn fix_path() {
    #[cfg(unix)]
    {
        let current = std::env::var("PATH").unwrap_or_default();
        let shell_path = login_shell_var("PATH").unwrap_or_default();
        let merged = merge_paths(&merge_paths(&current, &shell_path), &fallback_entries());
        // Setting PATH for our own process before any threads spawn plugins.
        std::env::set_var("PATH", merged);
    }
}

/// Import `KUBECONFIG` from the login shell when the process has none, so
/// the app sees the same kubeconfig file list as `kubectl` in a terminal.
///
/// No-op on Windows (GUI processes inherit the full user environment there).
pub fn import_kubeconfig() {
    #[cfg(unix)]
    {
        let current = std::env::var("KUBECONFIG").ok();
        if current.as_deref().is_some_and(|c| !c.trim().is_empty()) {
            return;
        }
        if let Some(value) =
            pick_kubeconfig(current.as_deref(), login_shell_var("KUBECONFIG").as_deref())
        {
            // Set before any thread reads the environment.
            std::env::set_var("KUBECONFIG", value);
        }
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
    fn kubeconfig_from_shell_only_when_process_has_none() {
        assert_eq!(pick_kubeconfig(None, Some("/a:/b")), Some("/a:/b".into()));
        assert_eq!(pick_kubeconfig(Some(""), Some(" /a ")), Some("/a".into()));
        assert_eq!(pick_kubeconfig(Some("/mine"), Some("/a:/b")), None);
        assert_eq!(pick_kubeconfig(None, None), None);
        assert_eq!(pick_kubeconfig(None, Some("   ")), None);
    }

    #[test]
    fn fallbacks_include_krew() {
        assert!(fallback_entries().contains(".krew/bin"));
    }
}
