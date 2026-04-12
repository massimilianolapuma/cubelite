//! Kubeconfig file loading, parsing, and manipulation.
//!
//! Supports:
//! - Single-file load from `~/.kube/config`
//! - Multi-file merge via `KUBECONFIG` environment variable (`:` separated)
//! - Context switching with optional disk persistence

use std::env;
use std::path::PathBuf;

use crate::error::KubeconfigError;
use crate::types::{ContextDetails, ContextInfo, KubeConfigFile, NamedContext};

// ---------------------------------------------------------------------------
// Public surface: KubeConfig
// ---------------------------------------------------------------------------

/// High-level kubeconfig state produced after loading and merging one or more
/// kubeconfig files.
///
/// # Example
///
/// ```no_run
/// use cubelite_core::KubeConfig;
///
/// let cfg = KubeConfig::load()?;
/// for name in cfg.list_context_names() {
///     println!("{name}");
/// }
/// # Ok::<(), cubelite_core::KubeconfigError>(())
/// ```
#[derive(Debug, Clone)]
pub struct KubeConfig {
    /// Parsed, merged kubeconfig document.
    raw: KubeConfigFile,
    /// Paths that were actually loaded (first path wins for `current-context`).
    paths: Vec<PathBuf>,
}

impl KubeConfig {
    /// Load kubeconfig from the path(s) specified by the `KUBECONFIG`
    /// environment variable, falling back to `~/.kube/config` when the
    /// variable is absent or empty.
    ///
    /// Multiple paths in `KUBECONFIG` are `:` separated.  The first file's
    /// `current-context` takes precedence during merging.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::FileNotFound`] when a path does not exist,
    /// [`KubeconfigError::ParseError`] on invalid YAML, or
    /// [`KubeconfigError::Io`] for other filesystem errors.
    pub fn load() -> Result<Self, KubeconfigError> {
        let paths = resolve_kubeconfig_paths()?;
        Self::load_from_paths(&paths)
    }

    /// Load kubeconfig from an explicit list of file paths.
    ///
    /// Contexts, clusters, and users are merged across all files; name
    /// collisions are resolved by keeping the first occurrence (first-wins).
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::FileNotFound`] when any path is missing, or
    /// [`KubeconfigError::ParseError`] on invalid YAML content.
    pub fn load_from_paths(paths: &[PathBuf]) -> Result<Self, KubeconfigError> {
        if paths.is_empty() {
            return Err(KubeconfigError::FileNotFound {
                path: "(no kubeconfig paths provided)".to_string(),
            });
        }

        let mut merged = KubeConfigFile::default();
        let mut first_current_context: Option<String> = None;

        for path in paths {
            if !path.exists() {
                return Err(KubeconfigError::FileNotFound {
                    path: path.display().to_string(),
                });
            }

            let content = std::fs::read_to_string(path)?;
            let raw: KubeConfigFile = serde_yaml::from_str(&content)?;

            // First file's current-context takes precedence.
            if first_current_context.is_none() {
                first_current_context = raw.current_context.clone();
            }

            // Merge contexts — first occurrence wins on name collision.
            for ctx in raw.contexts {
                if !merged.contexts.iter().any(|c| c.name == ctx.name) {
                    merged.contexts.push(ctx);
                }
            }

            // Merge clusters.
            for cluster in raw.clusters {
                if !merged.clusters.iter().any(|c| c.name == cluster.name) {
                    merged.clusters.push(cluster);
                }
            }

            // Merge users.
            for user in raw.users {
                if !merged.users.iter().any(|u| u.name == user.name) {
                    merged.users.push(user);
                }
            }
        }

        merged.current_context = first_current_context;

        Ok(Self {
            raw: merged,
            paths: paths.to_vec(),
        })
    }

    // -----------------------------------------------------------------------
    // Accessors
    // -----------------------------------------------------------------------

    /// Return an iterator over all context names in the loaded config.
    pub fn list_context_names(&self) -> impl Iterator<Item = &str> {
        self.raw.contexts.iter().map(|c| c.name.as_str())
    }

    /// Return all context names as an owned `Vec<String>`.
    pub fn context_names(&self) -> Vec<String> {
        self.raw.contexts.iter().map(|c| c.name.clone()).collect()
    }

    /// Return the name of the currently active context, if any.
    pub fn current_context(&self) -> Option<&str> {
        self.raw.current_context.as_deref()
    }

    /// Return rich [`ContextInfo`] for every context in the config.
    ///
    /// Each entry includes the resolved cluster server URL (if available),
    /// the default namespace, and whether it is the currently active context.
    pub fn list_contexts(&self) -> Vec<ContextInfo> {
        self.raw
            .contexts
            .iter()
            .map(|named| self.resolve_context_info(named))
            .collect()
    }

    /// Look up a single [`ContextInfo`] by name.
    ///
    /// Returns `None` when no context with the given `name` exists.
    pub fn get_context(&self, name: &str) -> Option<ContextInfo> {
        self.raw
            .contexts
            .iter()
            .find(|c| c.name == name)
            .map(|named| self.resolve_context_info(named))
    }

    // -----------------------------------------------------------------------
    // Mutation
    // -----------------------------------------------------------------------

    /// Switch the active context to `name` in memory.
    ///
    /// The change is **not** persisted to disk; call [`Self::save`] afterwards
    /// to make the switch durable.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::MergeError`] when `name` is not present in
    /// the loaded configuration.
    pub fn set_active_context(&mut self, name: &str) -> Result<(), KubeconfigError> {
        if self.raw.contexts.iter().any(|c| c.name == name) {
            self.raw.current_context = Some(name.to_string());
            Ok(())
        } else {
            Err(KubeconfigError::MergeError {
                reason: format!("context '{name}' not found in kubeconfig"),
            })
        }
    }

    /// Persist the (potentially modified) merged config back to the **first**
    /// kubeconfig path that was loaded.
    ///
    /// This mirrors how `kubectl` behaves when `KUBECONFIG` specifies multiple
    /// paths.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::FileNotFound`] when no load path is known,
    /// [`KubeconfigError::ParseError`] if serialisation fails, or
    /// [`KubeconfigError::Io`] on write failure.
    pub fn save(&self) -> Result<(), KubeconfigError> {
        let primary = self
            .paths
            .first()
            .ok_or_else(|| KubeconfigError::FileNotFound {
                path: "(no kubeconfig paths known — cannot save)".to_string(),
            })?;
        let yaml = serde_yaml::to_string(&self.raw)?;
        std::fs::write(primary, yaml)?;
        Ok(())
    }

    /// Return a reference to the raw merged [`KubeConfigFile`].
    ///
    /// Useful for callers that need direct access to cluster or user details
    /// without going through the higher-level helpers.
    pub fn raw(&self) -> &KubeConfigFile {
        &self.raw
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    fn resolve_context_info(&self, named: &NamedContext) -> ContextInfo {
        let details: Option<&ContextDetails> = named.context.as_ref();
        let cluster_name = details.map(|d| d.cluster.as_str()).unwrap_or("");
        let namespace = details
            .and_then(|d| d.namespace.clone())
            .unwrap_or_else(|| "default".to_string());

        let cluster_server = self
            .raw
            .clusters
            .iter()
            .find(|c| c.name == cluster_name)
            .and_then(|c| c.cluster.as_ref())
            .map(|cl| cl.server.clone());

        ContextInfo {
            name: named.name.clone(),
            cluster_server,
            namespace,
            is_active: self.raw.current_context.as_deref() == Some(named.name.as_str()),
        }
    }
}

// ---------------------------------------------------------------------------
// Module-level convenience functions
// ---------------------------------------------------------------------------

/// Load the default kubeconfig and return all context names.
///
/// Convenience wrapper around [`KubeConfig::load`] + [`KubeConfig::context_names`].
///
/// # Errors
///
/// Propagates any [`KubeconfigError`] encountered during loading.
pub fn list_contexts() -> Result<Vec<String>, KubeconfigError> {
    let cfg = KubeConfig::load()?;
    Ok(cfg.context_names())
}

/// Load the default kubeconfig, switch the active context to `name`, and
/// persist the change to disk.
///
/// # Errors
///
/// Returns [`KubeconfigError::MergeError`] when the context is not found, or
/// propagates any I/O / parse error from load or save.
pub fn set_active_context(name: &str) -> Result<(), KubeconfigError> {
    let mut cfg = KubeConfig::load()?;
    cfg.set_active_context(name)?;
    cfg.save()
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Resolve the ordered list of kubeconfig file paths to load.
///
/// Reads `KUBECONFIG` env var (`:` separated) when set; falls back to
/// `~/.kube/config` otherwise.
fn resolve_kubeconfig_paths() -> Result<Vec<PathBuf>, KubeconfigError> {
    if let Ok(val) = env::var("KUBECONFIG") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed
                .split(':')
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .collect());
        }
    }

    let home = dirs::home_dir().ok_or_else(|| KubeconfigError::FileNotFound {
        path: "~/.kube/config (home directory not found)".to_string(),
    })?;
    Ok(vec![home.join(".kube").join("config")])
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(content: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().expect("tempfile");
        f.write_all(content.as_bytes()).expect("write");
        f
    }

    // -- Error cases ---------------------------------------------------------

    #[test]
    fn empty_paths_returns_file_not_found() {
        let result = KubeConfig::load_from_paths(&[]);
        assert!(
            matches!(result, Err(KubeconfigError::FileNotFound { .. })),
            "expected FileNotFound, got {result:?}"
        );
    }

    #[test]
    fn missing_file_returns_file_not_found() {
        let path = PathBuf::from("/tmp/does-not-exist-cubelite-test-99999.yaml");
        let result = KubeConfig::load_from_paths(&[path]);
        assert!(matches!(result, Err(KubeconfigError::FileNotFound { .. })));
    }

    #[test]
    fn malformed_yaml_returns_parse_error() {
        let f = write_temp("{ not valid yaml: [");
        let result = KubeConfig::load_from_paths(&[f.path().to_path_buf()]);
        assert!(matches!(result, Err(KubeconfigError::ParseError { .. })));
    }

    // -- Single-file loading -------------------------------------------------

    #[test]
    fn single_context_round_trip() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: dev
contexts:
  - name: dev
    context:
      cluster: dev-cluster
      user: dev-user
      namespace: kube-system
clusters:
  - name: dev-cluster
    cluster:
      server: https://192.168.1.1:6443
users:
  - name: dev-user
    user:
      token: fake-token
"#;
        let f = write_temp(yaml);
        let cfg = KubeConfig::load_from_paths(&[f.path().to_path_buf()]).expect("should load");

        assert_eq!(cfg.context_names(), vec!["dev".to_string()]);
        assert_eq!(cfg.current_context(), Some("dev"));

        let infos = cfg.list_contexts();
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].name, "dev");
        assert_eq!(infos[0].namespace, "kube-system");
        assert_eq!(
            infos[0].cluster_server.as_deref(),
            Some("https://192.168.1.1:6443")
        );
        assert!(infos[0].is_active);
    }

    #[test]
    fn context_with_no_namespace_defaults_to_default() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: dev
contexts:
  - name: dev
    context:
      cluster: dev-cluster
      user: dev-user
"#;
        let f = write_temp(yaml);
        let cfg = KubeConfig::load_from_paths(&[f.path().to_path_buf()]).expect("load");
        let info = cfg.get_context("dev").expect("should find dev");
        assert_eq!(info.namespace, "default");
    }

    // -- Multi-file merge ----------------------------------------------------

    #[test]
    fn multi_file_merge_deduplicates_contexts() {
        let yaml_a = r#"
apiVersion: v1
kind: Config
current-context: dev
contexts:
  - name: dev
    context:
      cluster: dev-cluster
      user: dev-user
"#;
        let yaml_b = r#"
apiVersion: v1
kind: Config
current-context: staging
contexts:
  - name: staging
    context:
      cluster: staging-cluster
      user: staging-user
  - name: dev
    context:
      cluster: dev-cluster
      user: dev-user
"#;
        let fa = write_temp(yaml_a);
        let fb = write_temp(yaml_b);
        let cfg = KubeConfig::load_from_paths(&[fa.path().to_path_buf(), fb.path().to_path_buf()])
            .expect("should merge");

        let mut names = cfg.context_names();
        names.sort();
        assert_eq!(names, vec!["dev".to_string(), "staging".to_string()]);
        assert_eq!(cfg.current_context(), Some("dev"));
    }

    #[test]
    fn multi_file_merge_combines_clusters_and_users() {
        let yaml_a = r#"
apiVersion: v1
kind: Config
contexts: []
clusters:
  - name: cluster-a
    cluster:
      server: https://a:6443
users:
  - name: user-a
    user:
      token: token-a
"#;
        let yaml_b = r#"
apiVersion: v1
kind: Config
contexts: []
clusters:
  - name: cluster-b
    cluster:
      server: https://b:6443
users:
  - name: user-b
    user:
      token: token-b
"#;
        let fa = write_temp(yaml_a);
        let fb = write_temp(yaml_b);
        let cfg = KubeConfig::load_from_paths(&[fa.path().to_path_buf(), fb.path().to_path_buf()])
            .expect("merge");

        let raw = cfg.raw();
        assert_eq!(raw.clusters.len(), 2);
        assert_eq!(raw.users.len(), 2);
    }

    // -- Context switching ---------------------------------------------------

    #[test]
    fn set_active_context_updates_current() {
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
        let f = write_temp(yaml);
        let mut cfg = KubeConfig::load_from_paths(&[f.path().to_path_buf()]).expect("load");
        cfg.set_active_context("prod").expect("switch");
        assert_eq!(cfg.current_context(), Some("prod"));
    }

    #[test]
    fn set_active_context_unknown_returns_error() {
        let yaml = r#"
apiVersion: v1
kind: Config
contexts:
  - name: dev
    context: {}
"#;
        let f = write_temp(yaml);
        let mut cfg = KubeConfig::load_from_paths(&[f.path().to_path_buf()]).expect("load");
        let result = cfg.set_active_context("nonexistent");
        assert!(
            matches!(result, Err(KubeconfigError::MergeError { .. })),
            "expected MergeError, got {result:?}"
        );
    }

    // -- Persistence ---------------------------------------------------------

    #[test]
    fn save_persists_context_switch() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: dev
contexts:
  - name: dev
    context: {}
  - name: staging
    context: {}
"#;
        let f = write_temp(yaml);
        let path = f.path().to_path_buf();

        let mut cfg = KubeConfig::load_from_paths(std::slice::from_ref(&path)).expect("load");
        cfg.set_active_context("staging").expect("switch");
        cfg.save().expect("save");

        let reloaded = KubeConfig::load_from_paths(std::slice::from_ref(&path)).expect("reload");
        assert_eq!(reloaded.current_context(), Some("staging"));
    }

    // -- KUBECONFIG env var --------------------------------------------------

    #[test]
    fn kubeconfig_env_var_single_path() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: env-ctx
contexts:
  - name: env-ctx
    context: {}
"#;
        let f = write_temp(yaml);
        let path_str = f.path().to_string_lossy().to_string();

        env::set_var("KUBECONFIG", &path_str);
        let cfg = KubeConfig::load().expect("load via KUBECONFIG");
        env::remove_var("KUBECONFIG");

        assert_eq!(cfg.current_context(), Some("env-ctx"));
    }

    #[test]
    fn kubeconfig_env_var_multiple_paths() {
        let yaml_a = r#"
apiVersion: v1
kind: Config
current-context: ctx-a
contexts:
  - name: ctx-a
    context: {}
"#;
        let yaml_b = r#"
apiVersion: v1
kind: Config
contexts:
  - name: ctx-b
    context: {}
"#;
        let fa = write_temp(yaml_a);
        let fb = write_temp(yaml_b);
        let kubeconfig_val = format!(
            "{}:{}",
            fa.path().to_string_lossy(),
            fb.path().to_string_lossy()
        );

        env::set_var("KUBECONFIG", &kubeconfig_val);
        let cfg = KubeConfig::load().expect("multi-path KUBECONFIG");
        env::remove_var("KUBECONFIG");

        let mut names = cfg.context_names();
        names.sort();
        assert_eq!(names, vec!["ctx-a".to_string(), "ctx-b".to_string()]);
        assert_eq!(cfg.current_context(), Some("ctx-a"));
    }
}
