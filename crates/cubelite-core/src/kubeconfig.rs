use std::env;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::ConfigError;

// ---------------------------------------------------------------------------
// Serde models (minimal — covers what we need from the kubeconfig spec)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct RawKubeConfig {
    #[serde(default)]
    pub contexts: Vec<NamedContext>,
    #[serde(rename = "current-context", default)]
    pub current_context: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NamedContext {
    pub name: String,
    // We don't need the inner `context` object for listing/switching purposes.
    #[serde(default)]
    pub context: Option<serde_yaml::Value>,
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/// High-level kubeconfig state.
#[derive(Debug, Clone)]
pub struct KubeConfig {
    /// All context names gathered from the loaded kubeconfig(s).
    pub contexts: Vec<String>,
    /// The currently active context, if any.
    pub current_context: Option<String>,
    /// The raw merged config (kept so we can serialise back on context switch).
    raw: RawKubeConfig,
    /// Paths that were actually loaded (first path wins for current-context).
    paths: Vec<PathBuf>,
}

impl KubeConfig {
    /// Load kubeconfig from the path(s) specified by `KUBECONFIG`, falling back
    /// to `~/.kube/config`.  Multiple paths separated by `:` are merged.
    pub fn load() -> Result<Self, ConfigError> {
        let paths = resolve_kubeconfig_paths()?;
        Self::load_from_paths(&paths)
    }

    /// Load kubeconfig from an explicit list of paths.
    pub fn load_from_paths(paths: &[PathBuf]) -> Result<Self, ConfigError> {
        if paths.is_empty() {
            return Err(ConfigError::FileNotFound {
                path: "(no kubeconfig paths)".to_string(),
            });
        }

        let mut merged = RawKubeConfig::default();
        let mut first_current_context: Option<String> = None;

        for path in paths {
            if !path.exists() {
                return Err(ConfigError::FileNotFound {
                    path: path.display().to_string(),
                });
            }

            let content = std::fs::read_to_string(path)?;
            let raw: RawKubeConfig = serde_yaml::from_str(&content)?;

            // The first file's current-context takes precedence.
            if first_current_context.is_none() {
                first_current_context = raw.current_context.clone();
            }

            // Merge contexts, skipping name collisions.
            for ctx in raw.contexts {
                if !merged.contexts.iter().any(|c| c.name == ctx.name) {
                    merged.contexts.push(ctx);
                }
            }
        }

        merged.current_context = first_current_context;

        let contexts: Vec<String> = merged.contexts.iter().map(|c| c.name.clone()).collect();
        let current_context = merged.current_context.clone();

        Ok(Self {
            contexts,
            current_context,
            raw: merged,
            paths: paths.to_vec(),
        })
    }

    /// Return all context names.
    pub fn list_contexts(&self) -> &[String] {
        &self.contexts
    }

    /// Switch the active context for this in-memory config.
    /// The change is **not** persisted back to disk; see `save()` for that.
    pub fn set_active_context(&mut self, name: &str) -> Result<(), ConfigError> {
        if self.contexts.iter().any(|c| c == name) {
            self.current_context = Some(name.to_string());
            self.raw.current_context = Some(name.to_string());
            Ok(())
        } else {
            Err(ConfigError::ContextNotFound {
                name: name.to_string(),
            })
        }
    }

    /// Persist the (potentially modified) merged config back to the **first**
    /// path in `paths`.  This mirrors how `kubectl` behaves.
    pub fn save(&self) -> Result<(), ConfigError> {
        let primary = self
            .paths
            .first()
            .ok_or_else(|| ConfigError::FileNotFound {
                path: "(no kubeconfig paths)".to_string(),
            })?;
        let yaml =
            serde_yaml::to_string(&self.raw).map_err(|e| ConfigError::ParseError { source: e })?;
        std::fs::write(primary, yaml)?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Module-level convenience wrappers
// ---------------------------------------------------------------------------

/// Load the default kubeconfig and return all context names.
pub fn list_contexts() -> Result<Vec<String>, ConfigError> {
    let cfg = KubeConfig::load()?;
    Ok(cfg.contexts)
}

/// Load the default kubeconfig, switch the active context, and save.
pub fn set_active_context(name: &str) -> Result<(), ConfigError> {
    let mut cfg = KubeConfig::load()?;
    cfg.set_active_context(name)?;
    cfg.save()
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn resolve_kubeconfig_paths() -> Result<Vec<PathBuf>, ConfigError> {
    if let Ok(val) = env::var("KUBECONFIG") {
        if !val.trim().is_empty() {
            return Ok(val
                .split(':')
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .collect());
        }
    }

    // Fallback: ~/.kube/config
    let home = dirs::home_dir().ok_or_else(|| ConfigError::FileNotFound {
        path: "~/.kube/config".to_string(),
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

    #[test]
    fn missing_file_returns_error() {
        let path = PathBuf::from("/tmp/does-not-exist-cubelite-test-99999.yaml");
        let result = KubeConfig::load_from_paths(&[path]);
        assert!(matches!(result, Err(ConfigError::FileNotFound { .. })));
    }

    #[test]
    fn malformed_yaml_returns_parse_error() {
        let f = write_temp("{ not valid yaml: [");
        let result = KubeConfig::load_from_paths(&[f.path().to_path_buf()]);
        assert!(matches!(result, Err(ConfigError::ParseError { .. })));
    }

    #[test]
    fn valid_single_context() {
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
        let cfg = KubeConfig::load_from_paths(&[f.path().to_path_buf()]).expect("should load");
        assert_eq!(cfg.list_contexts(), &["dev".to_string()]);
        assert_eq!(cfg.current_context.as_deref(), Some("dev"));
    }

    #[test]
    fn valid_multi_context_merge() {
        let yaml_a = r#"
apiVersion: v1
kind: Config
current-context: dev
contexts:
  - name: dev
    context: {}
"#;
        let yaml_b = r#"
apiVersion: v1
kind: Config
current-context: staging
contexts:
  - name: staging
    context: {}
  - name: dev
    context: {}
"#;
        let fa = write_temp(yaml_a);
        let fb = write_temp(yaml_b);
        let cfg = KubeConfig::load_from_paths(&[fa.path().to_path_buf(), fb.path().to_path_buf()])
            .expect("should merge");

        let mut names = cfg.list_contexts().to_vec();
        names.sort();
        assert_eq!(names, vec!["dev".to_string(), "staging".to_string()]);
        // First file's current-context wins.
        assert_eq!(cfg.current_context.as_deref(), Some("dev"));
    }
}
