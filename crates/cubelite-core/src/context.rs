//! Context listing and switching operations.
//!
//! This module provides the primary high-level API for discovering and
//! activating Kubernetes contexts.  All file I/O is delegated to
//! [`crate::kubeconfig`].

use crate::error::{ContextError, KubeconfigError};
use crate::kubeconfig::KubeConfig;
use crate::types::ContextInfo;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Return all context names from the default kubeconfig.
///
/// Respects the `KUBECONFIG` environment variable (`:` separated paths) and
/// falls back to `~/.kube/config`.
///
/// # Errors
///
/// Returns [`ContextError::Kubeconfig`] wrapping any [`KubeconfigError`] that
/// occurs during loading.
pub fn list_contexts() -> Result<Vec<String>, ContextError> {
    let cfg = KubeConfig::load()?;
    Ok(cfg.context_names())
}

/// Return rich [`ContextInfo`] for every context in the default kubeconfig.
///
/// Unlike [`list_contexts`], this includes the cluster server URL, default
/// namespace, and whether each context is currently active.
///
/// # Errors
///
/// Returns [`ContextError::Kubeconfig`] on load failure.
pub fn list_context_infos() -> Result<Vec<ContextInfo>, ContextError> {
    list_context_infos_in(None)
}

/// Return the name of the currently active context, if one is set.
///
/// # Errors
///
/// Returns [`ContextError::Kubeconfig`] on load failure.
pub fn current_context() -> Result<Option<String>, ContextError> {
    current_context_in(None)
}

/// Switch the active context to `name` and persist the change to disk.
///
/// On success the first file of the resolved kubeconfig list (`KUBECONFIG`,
/// or `~/.kube/config` plus discovered files) is rewritten with the new `current-context` value.
///
/// # Errors
///
/// * [`ContextError::NotFound`] — `name` does not exist in the loaded config.
/// * [`ContextError::Kubeconfig`] — a load or save I/O / parse error occurred.
pub fn set_active_context(name: &str) -> Result<(), ContextError> {
    set_active_context_in(None, name)
}

/// Return `true` if a context with the given `name` exists in the default
/// kubeconfig.
///
/// # Errors
///
/// Returns [`ContextError::Kubeconfig`] on load failure.
pub fn context_exists(name: &str) -> Result<bool, ContextError> {
    let cfg = KubeConfig::load()?;
    Ok(cfg.get_context(name).is_some())
}

// ---------------------------------------------------------------------------
// Spec-aware variants (explicit KUBECONFIG-style list, e.g. the desktop's
// custom file list). `None` or a blank spec means the default resolution.
// ---------------------------------------------------------------------------

fn load_spec(spec: Option<&str>) -> Result<KubeConfig, KubeconfigError> {
    match spec.map(str::trim) {
        Some(s) if !s.is_empty() => KubeConfig::load_from_spec(s),
        _ => KubeConfig::load(),
    }
}

/// [`list_context_infos`] for an explicit kubeconfig spec.
///
/// # Errors
///
/// Returns [`ContextError::Kubeconfig`] on load failure.
pub fn list_context_infos_in(spec: Option<&str>) -> Result<Vec<ContextInfo>, ContextError> {
    Ok(load_spec(spec)?.list_contexts())
}

/// [`current_context`] for an explicit kubeconfig spec.
///
/// # Errors
///
/// Returns [`ContextError::Kubeconfig`] on load failure.
pub fn current_context_in(spec: Option<&str>) -> Result<Option<String>, ContextError> {
    Ok(load_spec(spec)?.current_context().map(str::to_string))
}

/// [`set_active_context`] for an explicit kubeconfig spec: `current-context`
/// is written to the first file of the spec, like `kubectl config use-context`.
///
/// # Errors
///
/// * [`ContextError::NotFound`] — `name` is not in the merged config.
/// * [`ContextError::Kubeconfig`] — load or save failed.
pub fn set_active_context_in(spec: Option<&str>, name: &str) -> Result<(), ContextError> {
    let mut cfg = load_spec(spec)?;
    cfg.set_active_context(name).map_err(|e| match e {
        KubeconfigError::MergeError { .. } => ContextError::NotFound {
            name: name.to_string(),
        },
        other => ContextError::Kubeconfig(other),
    })?;
    cfg.save()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::env;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(content: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().expect("tempfile");
        f.write_all(content.as_bytes()).expect("write");
        f
    }

    fn with_kubeconfig<F: FnOnce()>(yaml: &str, f: F) {
        let tmp = write_temp(yaml);
        env::set_var("KUBECONFIG", tmp.path().to_string_lossy().as_ref());
        f();
        env::remove_var("KUBECONFIG");
        drop(tmp);
    }

    #[test]
    #[serial]
    fn list_contexts_returns_all_names() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: dev
contexts:
  - name: dev
    context: {}
  - name: prod
    context: {}
"#;
        with_kubeconfig(yaml, || {
            let names = list_contexts().expect("list_contexts");
            assert!(names.contains(&"dev".to_string()));
            assert!(names.contains(&"prod".to_string()));
        });
    }

    #[test]
    #[serial]
    fn current_context_returns_active() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: staging
contexts:
  - name: staging
    context: {}
"#;
        with_kubeconfig(yaml, || {
            let active = current_context().expect("current_context");
            assert_eq!(active.as_deref(), Some("staging"));
        });
    }

    #[test]
    #[serial]
    fn current_context_none_when_unset() {
        let yaml = r#"
apiVersion: v1
kind: Config
contexts:
  - name: dev
    context: {}
"#;
        with_kubeconfig(yaml, || {
            let active = current_context().expect("current_context");
            assert!(active.is_none());
        });
    }

    #[test]
    #[serial]
    fn context_exists_true_for_known_name() {
        let yaml = r#"
apiVersion: v1
kind: Config
contexts:
  - name: dev
    context: {}
"#;
        with_kubeconfig(yaml, || {
            assert!(context_exists("dev").expect("context_exists"));
        });
    }

    #[test]
    #[serial]
    fn context_exists_false_for_unknown_name() {
        let yaml = r#"
apiVersion: v1
kind: Config
contexts:
  - name: dev
    context: {}
"#;
        with_kubeconfig(yaml, || {
            assert!(!context_exists("nonexistent").expect("context_exists"));
        });
    }

    #[test]
    #[serial]
    fn load_from_spec_blank_falls_back_to_default() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: dev
clusters: []
users: []
contexts:
  - name: dev
    context:
      cluster: c
      user: u
"#;
        with_kubeconfig(yaml, || {
            let cfg = KubeConfig::load_from_spec("  ").expect("load");
            assert!(cfg.context_names().contains(&"dev".to_string()));
            let infos = list_context_infos_in(Some("")).expect("list");
            assert!(infos.iter().any(|c| c.name == "dev"));
        });
    }

    #[test]
    #[serial]
    fn set_active_context_unknown_name_returns_not_found() {
        let yaml = r#"
apiVersion: v1
kind: Config
contexts:
  - name: dev
    context: {}
"#;
        let tmp = write_temp(yaml);
        env::set_var("KUBECONFIG", tmp.path().to_string_lossy().as_ref());
        let result = set_active_context("ghost");
        env::remove_var("KUBECONFIG");
        drop(tmp);

        assert!(
            matches!(result, Err(ContextError::NotFound { .. })),
            "expected NotFound, got {result:?}"
        );
    }

    #[test]
    #[serial]
    fn set_active_context_and_persists() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: dev
contexts:
  - name: dev
    context: {}
  - name: prod
    context: {}
"#;
        let tmp = write_temp(yaml);
        let path = tmp.path().to_path_buf();
        env::set_var("KUBECONFIG", path.to_string_lossy().as_ref());
        set_active_context("prod").expect("set_active_context");
        env::remove_var("KUBECONFIG");

        // Reload and verify persistence.
        let cfg = KubeConfig::load_from_paths(&[path]).expect("reload");
        assert_eq!(cfg.current_context(), Some("prod"));
    }

    #[test]
    #[serial]
    fn list_context_infos_includes_active_flag() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: dev
contexts:
  - name: dev
    context:
      cluster: dev-cluster
      user: dev-user
  - name: prod
    context:
      cluster: prod-cluster
      user: prod-user
clusters:
  - name: dev-cluster
    cluster:
      server: https://dev:6443
  - name: prod-cluster
    cluster:
      server: https://prod:6443
users: []
"#;
        with_kubeconfig(yaml, || {
            let infos = list_context_infos().expect("list_context_infos");
            let dev = infos.iter().find(|i| i.name == "dev").expect("dev");
            let prod = infos.iter().find(|i| i.name == "prod").expect("prod");
            assert!(dev.is_active);
            assert!(!prod.is_active);
            assert_eq!(dev.cluster_server.as_deref(), Some("https://dev:6443"));
        });
    }

    const SPEC_A: &str = r#"
apiVersion: v1
kind: Config
current-context: a-ctx
contexts:
  - name: a-ctx
    context: {cluster: a, user: a}
clusters:
  - name: a
    cluster: {server: "https://a:6443"}
users:
  - name: a
    user: {}
"#;
    const SPEC_B: &str = r#"
apiVersion: v1
kind: Config
contexts:
  - name: b-ctx
    context: {cluster: b, user: b}
clusters:
  - name: b
    cluster: {server: "https://b:6443"}
users:
  - name: b
    user: {}
"#;

    fn two_file_spec() -> (NamedTempFile, NamedTempFile, String) {
        let fa = write_temp(SPEC_A);
        let fb = write_temp(SPEC_B);
        let spec = env::join_paths([fa.path(), fb.path()])
            .expect("join")
            .to_string_lossy()
            .into_owned();
        (fa, fb, spec)
    }

    #[test]
    fn list_context_infos_in_reads_every_file_of_the_spec() {
        let (_fa, _fb, spec) = two_file_spec();
        let infos = list_context_infos_in(Some(&spec)).expect("list");
        let names: Vec<_> = infos.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["a-ctx", "b-ctx"]);
        assert_eq!(
            current_context_in(Some(&spec)).expect("current").as_deref(),
            Some("a-ctx")
        );
    }

    #[test]
    fn set_active_context_in_writes_only_the_first_file() {
        let (fa, fb, spec) = two_file_spec();
        set_active_context_in(Some(&spec), "b-ctx").expect("switch");
        let a = std::fs::read_to_string(fa.path()).expect("read a");
        let b = std::fs::read_to_string(fb.path()).expect("read b");
        assert!(a.contains("current-context: b-ctx"));
        assert!(!b.contains("current-context"));
        assert!(matches!(
            set_active_context_in(Some(&spec), "nope"),
            Err(ContextError::NotFound { .. })
        ));
    }
}
