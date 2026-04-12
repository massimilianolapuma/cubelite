//! Integration tests for kubeconfig loading and context switching.
//!
//! These tests exercise the public API end-to-end, using real temp files on
//! disk to simulate `~/.kube/config` and multi-path `KUBECONFIG` setups.

use std::env;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tempfile::NamedTempFile;

/// Serialises all tests that read or write the `KUBECONFIG` environment
/// variable. `env::set_var` is not thread-safe; without this lock, tests that
/// set the variable can race with other tests that read it.
static ENV_LOCK: Mutex<()> = Mutex::new(());

use cubelite_core::{
    context,
    error::{ContextError, KubeconfigError},
    KubeConfig,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn write_temp(content: &str) -> NamedTempFile {
    let mut f = NamedTempFile::new().expect("tempfile");
    f.write_all(content.as_bytes()).expect("write");
    f
}

fn minimal_kubeconfig(current: &str, contexts: &[&str]) -> String {
    let ctx_list: String = contexts
        .iter()
        .map(|name| {
            format!(
                "  - name: {name}\n    context:\n      cluster: {name}-cluster\n      user: {name}-user\n"
            )
        })
        .collect();
    let cluster_list: String = contexts
        .iter()
        .map(|name| {
            format!("  - name: {name}-cluster\n    cluster:\n      server: https://{name}:6443\n")
        })
        .collect();
    let user_list: String = contexts
        .iter()
        .map(|name| format!("  - name: {name}-user\n    user:\n      token: token-{name}\n"))
        .collect();

    format!(
        "apiVersion: v1\nkind: Config\ncurrent-context: {current}\ncontexts:\n{ctx_list}clusters:\n{cluster_list}users:\n{user_list}"
    )
}

// ---------------------------------------------------------------------------
// KubeConfig: load / list
// ---------------------------------------------------------------------------

#[test]
fn load_from_paths_single_file() {
    let yaml = minimal_kubeconfig("dev", &["dev", "staging"]);
    let f = write_temp(&yaml);
    let cfg = KubeConfig::load_from_paths(&[f.path().to_path_buf()]).expect("load");

    let mut names = cfg.context_names();
    names.sort();
    assert_eq!(names, vec!["dev".to_string(), "staging".to_string()]);
    assert_eq!(cfg.current_context(), Some("dev"));
}

#[test]
fn load_returns_rich_context_info() {
    let yaml = minimal_kubeconfig("dev", &["dev"]);
    let f = write_temp(&yaml);
    let cfg = KubeConfig::load_from_paths(&[f.path().to_path_buf()]).expect("load");

    let info = cfg.get_context("dev").expect("get_context");
    assert_eq!(info.name, "dev");
    assert_eq!(info.cluster_server.as_deref(), Some("https://dev:6443"));
    assert!(info.is_active);
    assert_eq!(info.namespace, "default");
}

#[test]
fn missing_file_produces_file_not_found_error() {
    let bad = PathBuf::from("/tmp/cubelite-no-such-file-99999999.yaml");
    let err = KubeConfig::load_from_paths(&[bad]).expect_err("should fail");
    assert!(
        matches!(err, KubeconfigError::FileNotFound { .. }),
        "expected FileNotFound, got {err:?}"
    );
}

#[test]
fn invalid_yaml_produces_parse_error() {
    let f = write_temp("{ bad yaml: [[[");
    let err = KubeConfig::load_from_paths(&[f.path().to_path_buf()]).expect_err("should fail");
    assert!(
        matches!(err, KubeconfigError::ParseError { .. }),
        "expected ParseError, got {err:?}"
    );
}

// ---------------------------------------------------------------------------
// Multi-file merge
// ---------------------------------------------------------------------------

#[test]
fn two_files_merge_without_duplicates() {
    let yaml_a = minimal_kubeconfig("dev", &["dev"]);
    let yaml_b = minimal_kubeconfig("staging", &["staging", "dev"]);

    let fa = write_temp(&yaml_a);
    let fb = write_temp(&yaml_b);

    let cfg = KubeConfig::load_from_paths(&[fa.path().to_path_buf(), fb.path().to_path_buf()])
        .expect("merge");

    let mut names = cfg.context_names();
    names.sort();
    assert_eq!(names, vec!["dev".to_string(), "staging".to_string()]);
    // First file wins for current-context.
    assert_eq!(cfg.current_context(), Some("dev"));
}

#[test]
fn three_files_all_clusters_present() {
    let yaml_a = minimal_kubeconfig("a", &["a"]);
    let yaml_b = minimal_kubeconfig("b", &["b"]);
    let yaml_c = minimal_kubeconfig("c", &["c"]);

    let fa = write_temp(&yaml_a);
    let fb = write_temp(&yaml_b);
    let fc = write_temp(&yaml_c);

    let cfg = KubeConfig::load_from_paths(&[
        fa.path().to_path_buf(),
        fb.path().to_path_buf(),
        fc.path().to_path_buf(),
    ])
    .expect("three-way merge");

    let raw = cfg.raw();
    assert_eq!(raw.clusters.len(), 3);
    assert_eq!(raw.users.len(), 3);

    let mut names = cfg.context_names();
    names.sort();
    assert_eq!(
        names,
        vec!["a".to_string(), "b".to_string(), "c".to_string()]
    );
}

// ---------------------------------------------------------------------------
// Context switching
// ---------------------------------------------------------------------------

#[test]
fn switch_context_updates_in_memory() {
    let yaml = minimal_kubeconfig("dev", &["dev", "prod"]);
    let f = write_temp(&yaml);
    let mut cfg = KubeConfig::load_from_paths(&[f.path().to_path_buf()]).expect("load");

    cfg.set_active_context("prod").expect("switch");
    assert_eq!(cfg.current_context(), Some("prod"));

    // is_active must reflect the new active context.
    let infos = cfg.list_contexts();
    let prod_info = infos.iter().find(|i| i.name == "prod").expect("prod info");
    let dev_info = infos.iter().find(|i| i.name == "dev").expect("dev info");
    assert!(prod_info.is_active);
    assert!(!dev_info.is_active);
}

#[test]
fn switch_context_save_reload_roundtrip() {
    let yaml = minimal_kubeconfig("dev", &["dev", "staging", "prod"]);
    let f = write_temp(&yaml);
    let path = f.path().to_path_buf();

    let mut cfg = KubeConfig::load_from_paths(std::slice::from_ref(&path)).expect("load");
    cfg.set_active_context("prod").expect("switch");
    cfg.save().expect("save");

    let reloaded = KubeConfig::load_from_paths(std::slice::from_ref(&path)).expect("reload");
    assert_eq!(reloaded.current_context(), Some("prod"));
}

#[test]
fn switch_to_nonexistent_context_fails() {
    let yaml = minimal_kubeconfig("dev", &["dev"]);
    let f = write_temp(&yaml);
    let mut cfg = KubeConfig::load_from_paths(&[f.path().to_path_buf()]).expect("load");

    let err = cfg.set_active_context("ghost").expect_err("should fail");
    assert!(
        matches!(err, KubeconfigError::MergeError { .. }),
        "expected MergeError, got {err:?}"
    );
}

// ---------------------------------------------------------------------------
// KUBECONFIG env var
// ---------------------------------------------------------------------------

#[test]
fn kubeconfig_env_var_overrides_default() {
    let yaml = minimal_kubeconfig("env-ctx", &["env-ctx"]);
    let f = write_temp(&yaml);

    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var("KUBECONFIG", f.path().to_string_lossy().as_ref());
    let cfg = KubeConfig::load().expect("load via KUBECONFIG");
    env::remove_var("KUBECONFIG");

    assert_eq!(cfg.current_context(), Some("env-ctx"));
}

#[test]
fn kubeconfig_env_var_colon_separated() {
    let yaml_a = minimal_kubeconfig("first", &["first"]);
    let yaml_b = minimal_kubeconfig("second", &["second"]);
    let fa = write_temp(&yaml_a);
    let fb = write_temp(&yaml_b);

    let val = format!(
        "{}:{}",
        fa.path().to_string_lossy(),
        fb.path().to_string_lossy()
    );
    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var("KUBECONFIG", &val);
    let cfg = KubeConfig::load().expect("multi-path KUBECONFIG");
    env::remove_var("KUBECONFIG");

    let mut names = cfg.context_names();
    names.sort();
    assert_eq!(names, vec!["first".to_string(), "second".to_string()]);
    assert_eq!(cfg.current_context(), Some("first"));
}

// ---------------------------------------------------------------------------
// context module (public API)
// ---------------------------------------------------------------------------

#[test]
fn context_list_contexts_via_module() {
    let yaml = minimal_kubeconfig("alpha", &["alpha", "beta"]);
    let f = write_temp(&yaml);

    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var("KUBECONFIG", f.path().to_string_lossy().as_ref());
    let names = context::list_contexts().expect("list_contexts");
    env::remove_var("KUBECONFIG");

    assert!(names.contains(&"alpha".to_string()));
    assert!(names.contains(&"beta".to_string()));
}

#[test]
fn context_set_active_context_via_module() {
    let yaml = minimal_kubeconfig("alpha", &["alpha", "beta"]);
    let f = write_temp(&yaml);
    let path = f.path().to_path_buf();

    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var("KUBECONFIG", path.to_string_lossy().as_ref());
    context::set_active_context("beta").expect("set_active_context");
    env::remove_var("KUBECONFIG");

    let reloaded = KubeConfig::load_from_paths(&[path]).expect("reload");
    assert_eq!(reloaded.current_context(), Some("beta"));
}

#[test]
fn context_set_active_context_not_found_error() {
    let yaml = minimal_kubeconfig("alpha", &["alpha"]);
    let f = write_temp(&yaml);

    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var("KUBECONFIG", f.path().to_string_lossy().as_ref());
    let err = context::set_active_context("ghost").expect_err("should fail");
    env::remove_var("KUBECONFIG");

    assert!(
        matches!(err, ContextError::NotFound { .. }),
        "expected ContextError::NotFound, got {err:?}"
    );
}

#[test]
fn context_current_context_via_module() {
    let yaml = minimal_kubeconfig("active-one", &["active-one", "other"]);
    let f = write_temp(&yaml);

    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var("KUBECONFIG", f.path().to_string_lossy().as_ref());
    let active = context::current_context().expect("current_context");
    env::remove_var("KUBECONFIG");

    assert_eq!(active.as_deref(), Some("active-one"));
}
