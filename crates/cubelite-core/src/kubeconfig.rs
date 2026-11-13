//! Kubeconfig file loading, parsing, and manipulation.
//!
//! Supports:
//! - Load from `~/.kube/config` plus the kubeconfig files discovered in
//!   `~/.kube/`, or from a `KUBECONFIG` list
//! - Multi-file merge via `KUBECONFIG` environment variable (platform path
//!   list: `:` on Unix, `;` on Windows), first file wins on name clashes;
//!   a context resolves its cluster and user against its own file first
//! - Context switching with optional disk persistence

use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};

use crate::error::KubeconfigError;
use crate::types::{
    ContextDetails, ContextInfo, KubeConfigFile, KubeconfigSource, NamedCluster, NamedContext,
};

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
    /// Every requested path in merge order, including missing ones.
    requested: Vec<PathBuf>,
    /// Context name → file that defines it (the first file that listed it).
    context_sources: HashMap<String, PathBuf>,
    /// Per requested file: context names hidden by an earlier file.
    shadowed: HashMap<PathBuf, Vec<String>>,
    /// Per loaded file: the clusters it defines, so a context resolves its
    /// cluster against the file that defines the context (#543).
    file_clusters: HashMap<PathBuf, Vec<NamedCluster>>,
    /// Per loaded file: cluster and user names an earlier file defines
    /// differently.
    redefined: HashMap<PathBuf, Redefined>,
}

/// Cluster and user names a file defines differently from an earlier file.
#[derive(Debug, Clone, Default)]
struct Redefined {
    clusters: Vec<String>,
    users: Vec<String>,
}

/// Which clusters and users count as "defined differently" by a later file
/// (Preferences note, #543).
///
/// - A cluster entry is compared on [`CLUSTER_IDENTITY_KEYS`] only, so
///   cosmetic keys such as `extensions` do not count.
/// - A user entry is compared whole, unmodelled keys (`exec`,
///   `auth-provider`, …) included.
/// - Mappings compare regardless of key order; scalars by value and type.
/// - Relative file paths ([`PATH_KEYS`]) are resolved against the directory
///   of the file that lists them first, as kubectl does, so the same relative
///   path in two directories is two different files.
/// - Identical duplicates are not reported.
const CLUSTER_IDENTITY_KEYS: [&str; 6] = [
    "server",
    "certificate-authority",
    "certificate-authority-data",
    "insecure-skip-tls-verify",
    "tls-server-name",
    "proxy-url",
];

/// Cluster and user keys holding a file path, relative to the kubeconfig.
const PATH_KEYS: [&str; 3] = ["certificate-authority", "client-certificate", "client-key"];

/// Raw `(name, body)` pairs of one named list (`clusters`, `users`) of a
/// kubeconfig document in `dir`, the body reduced to `keep` when given and
/// its relative [`PATH_KEYS`] resolved against `dir`. Raw YAML so fields the
/// typed model does not know (`exec`, `auth-provider`, …) count.
fn raw_named_entries(
    doc: &serde_yaml::Value,
    list: &str,
    body: &str,
    keep: Option<&[&str]>,
    dir: &Path,
) -> Vec<(String, serde_yaml::Value)> {
    doc.get(list)
        .and_then(serde_yaml::Value::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.to_string();
            let mut value = item.get(body).cloned().unwrap_or(serde_yaml::Value::Null);
            if let serde_yaml::Value::Mapping(map) = &mut value {
                if let Some(keys) = keep {
                    map.retain(|k, _| k.as_str().is_some_and(|k| keys.contains(&k)));
                }
                for key in PATH_KEYS {
                    if let Some(serde_yaml::Value::String(file)) = map.get_mut(key) {
                        if !Path::new(file.as_str()).is_absolute() {
                            *file = dir.join(file.as_str()).display().to_string();
                        }
                    }
                }
            }
            Some((name, value))
        })
        .collect()
}

/// Earlier definitions per name, with the file that made each one.
type SeenEntries = HashMap<String, Vec<(PathBuf, serde_yaml::Value)>>;

/// Names among `entries` (from `path`) that another, earlier file defines
/// with a different body; records `entries` as seen.
fn note_redefinitions(
    seen: &mut SeenEntries,
    path: &Path,
    entries: Vec<(String, serde_yaml::Value)>,
) -> Vec<String> {
    let mut redefined = Vec::new();
    for (name, value) in entries {
        let earlier = seen.entry(name.clone()).or_default();
        let differs = earlier.iter().any(|(p, v)| p != path && *v != value);
        if differs && !redefined.contains(&name) {
            redefined.push(name);
        }
        earlier.push((path.to_path_buf(), value));
    }
    redefined
}

impl KubeConfig {
    /// Load kubeconfig from the path(s) specified by the `KUBECONFIG`
    /// environment variable, falling back to `~/.kube/config` plus the kubeconfig
    /// files discovered in `~/.kube/` when the variable is absent or empty.
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

    /// Load kubeconfig from a `KUBECONFIG`-style path list. A blank spec
    /// behaves like [`KubeConfig::load`].
    ///
    /// # Errors
    ///
    /// Same as [`KubeConfig::load_from_paths`].
    pub fn load_from_spec(spec: &str) -> Result<Self, KubeconfigError> {
        let paths = split_kubeconfig_spec(spec);
        if paths.is_empty() {
            Self::load()
        } else {
            Self::load_from_paths(&paths)
        }
    }

    /// Load kubeconfig from an explicit list of file paths.
    ///
    /// Contexts, clusters, and users are merged across all files; name
    /// collisions are resolved by keeping the first occurrence (first-wins).
    /// A context resolves its cluster against the file that defines the
    /// context first, falling back to the merged entry only when that file
    /// does not define the name (#543). Missing files are skipped, as kubectl
    /// does with `KUBECONFIG`.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::FileNotFound`] when the list is empty or
    /// none of the paths exist, or [`KubeconfigError::ParseError`] on invalid
    /// YAML content.
    pub fn load_from_paths(paths: &[PathBuf]) -> Result<Self, KubeconfigError> {
        let existing: Vec<PathBuf> = paths.iter().filter(|p| p.exists()).cloned().collect();
        if existing.is_empty() {
            let listed = paths
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(KubeconfigError::FileNotFound {
                path: if listed.is_empty() {
                    "(no kubeconfig paths provided)".to_string()
                } else {
                    listed
                },
            });
        }

        let mut merged = KubeConfigFile::default();
        let mut first_current_context: Option<String> = None;
        let mut context_sources = HashMap::new();
        let mut shadowed: HashMap<PathBuf, Vec<String>> = HashMap::new();
        let mut file_clusters = HashMap::new();
        let mut redefined = HashMap::new();
        let mut seen_clusters = SeenEntries::new();
        let mut seen_users = SeenEntries::new();

        for path in &existing {
            let content = std::fs::read_to_string(path)?;
            let raw: KubeConfigFile = serde_yaml::from_str(&content)?;
            let doc: serde_yaml::Value = serde_yaml::from_str(&content)?;
            let dir = path.parent().unwrap_or(Path::new(""));
            let keep = Some(CLUSTER_IDENTITY_KEYS.as_slice());
            let clusters = raw_named_entries(&doc, "clusters", "cluster", keep, dir);
            let users = raw_named_entries(&doc, "users", "user", None, dir);
            redefined.insert(
                path.clone(),
                Redefined {
                    clusters: note_redefinitions(&mut seen_clusters, path, clusters),
                    users: note_redefinitions(&mut seen_users, path, users),
                },
            );
            file_clusters.insert(path.clone(), raw.clusters.clone());

            // The first non-empty current-context wins; kubectl treats
            // `current-context: ""` as unset (#552).
            if first_current_context.is_none() {
                first_current_context = raw.current_context.clone().filter(|c| !c.is_empty());
            }

            // Merge contexts — first occurrence wins on name collision.
            for ctx in raw.contexts {
                if merged.contexts.iter().any(|c| c.name == ctx.name) {
                    shadowed.entry(path.clone()).or_default().push(ctx.name);
                } else {
                    context_sources.insert(ctx.name.clone(), path.clone());
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
            paths: existing,
            requested: paths.to_vec(),
            context_sources,
            shadowed,
            file_clusters,
            redefined,
        })
    }

    /// Describe every requested kubeconfig file in merge order: whether it
    /// exists, how many contexts it contributes, which of its context names
    /// are hidden by an earlier file, and which of its cluster and user names
    /// an earlier file defines differently.
    pub fn sources(&self) -> Vec<KubeconfigSource> {
        self.requested
            .iter()
            .map(|path| {
                let redefined = self.redefined.get(path).cloned().unwrap_or_default();
                KubeconfigSource {
                    path: path.display().to_string(),
                    exists: self.paths.contains(path),
                    contexts: self.context_sources.values().filter(|p| *p == path).count(),
                    shadowed: self.shadowed.get(path).cloned().unwrap_or_default(),
                    redefined_clusters: redefined.clusters,
                    redefined_users: redefined.users,
                }
            })
            .collect()
    }

    /// The loaded file list joined with the platform separator — the same
    /// shape as `KUBECONFIG`, suitable for [`split_kubeconfig_spec`] and
    /// [`crate::KubeClient::new`].
    pub fn resolved_spec(&self) -> String {
        env::join_paths(&self.paths)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|_| {
                self.paths
                    .first()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default()
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
    /// Only the `current-context` key of the primary file is patched: the
    /// document is round-tripped as raw YAML so fields our typed model does
    /// not know about (`exec` credential plugins, `auth-provider`,
    /// extensions, …) are preserved verbatim, and a merged multi-file
    /// KUBECONFIG is never flattened into the primary file.
    ///
    /// # Errors
    ///
    /// Returns [`KubeconfigError::FileNotFound`] when no load path is known,
    /// [`KubeconfigError::ParseError`] if (de)serialisation fails, or
    /// [`KubeconfigError::Io`] on write failure.
    pub fn save(&self) -> Result<(), KubeconfigError> {
        let primary = self
            .paths
            .first()
            .ok_or_else(|| KubeconfigError::FileNotFound {
                path: "(no kubeconfig paths known, cannot save)".to_string(),
            })?;

        let content = std::fs::read_to_string(primary)?;
        let mut doc: serde_yaml::Value = serde_yaml::from_str(&content)?;
        let mapping = doc
            .as_mapping_mut()
            .ok_or_else(|| KubeconfigError::MergeError {
                reason: format!("kubeconfig root is not a mapping: {}", primary.display()),
            })?;
        mapping.insert(
            serde_yaml::Value::String("current-context".to_string()),
            serde_yaml::Value::String(self.raw.current_context.clone().unwrap_or_default()),
        );

        let yaml = serde_yaml::to_string(&doc)?;
        std::fs::write(primary, yaml)?;
        Ok(())
    }

    /// Return a reference to the raw merged [`KubeConfigFile`].
    ///
    /// Useful for callers that need direct access to cluster or user details
    /// without going through the higher-level helpers. Its clusters and users
    /// are merged first-wins by name; to find the cluster a context actually
    /// uses, go through [`Self::get_context`].
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

        // The context's own file first; the merged (first-wins) entry only
        // when that file does not define the name (cross-file reference).
        let own_file = self
            .context_sources
            .get(&named.name)
            .and_then(|path| self.file_clusters.get(path));
        let cluster_server = own_file
            .and_then(|clusters| clusters.iter().find(|c| c.name == cluster_name))
            .or_else(|| self.raw.clusters.iter().find(|c| c.name == cluster_name))
            .and_then(|c| c.cluster.as_ref())
            .map(|cl| cl.server.clone());

        ContextInfo {
            name: named.name.clone(),
            cluster_server,
            namespace,
            is_active: self.raw.current_context.as_deref() == Some(named.name.as_str()),
            source: self
                .context_sources
                .get(&named.name)
                .map(|p| p.display().to_string()),
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

/// Split a `KUBECONFIG`-style path list with the platform separator (`:` on
/// Unix, `;` on Windows), dropping empty entries.
pub fn split_kubeconfig_spec(spec: &str) -> Vec<PathBuf> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    env::split_paths(trimmed)
        .filter(|p| !p.as_os_str().is_empty())
        .collect()
}

/// Resolve the ordered list of kubeconfig file paths to load.
///
/// Reads the `KUBECONFIG` env var (platform path list) when set; otherwise
/// `~/.kube/config` followed by every other kubeconfig discovered in
/// `~/.kube/` (see [`discover_kubeconfig_files`]), mirroring the macOS app.
fn resolve_kubeconfig_paths() -> Result<Vec<PathBuf>, KubeconfigError> {
    if let Ok(val) = env::var("KUBECONFIG") {
        let paths = split_kubeconfig_spec(&val);
        if !paths.is_empty() {
            return Ok(paths);
        }
    }

    let home = dirs::home_dir().ok_or_else(|| KubeconfigError::FileNotFound {
        path: "~/.kube/config (home directory not found)".to_string(),
    })?;
    let kube_dir = home.join(".kube");
    let default = kube_dir.join("config");
    let mut paths = vec![default.clone()];
    paths.extend(discover_kubeconfig_files(&kube_dir, &default));
    Ok(paths)
}

/// Kubeconfig files to merge in addition to the default one: regular, non-hidden files directly inside `dir` (so nothing under `cache/`), other than `excluding`, that [`is_kubeconfig_file`] accepts. Sorted by path; empty when `dir` cannot be read.
///
/// The whole document is parsed: kubectl writes keys in sorted order, so with inline certificate data `kind: Config` sits thousands of bytes in (#479).
pub fn discover_kubeconfig_files(dir: &Path, excluding: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path != excluding)
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| !name.starts_with('.'))
        })
        // `metadata` follows symlinks, so a symlink to a directory is skipped too.
        .filter(|path| std::fs::metadata(path).map(|m| m.is_file()).unwrap_or(false))
        .filter(|path| is_kubeconfig_file(path))
        .collect();
    found.sort();
    found
}

/// Minimal view of a YAML document used to read its `kind`.
#[derive(serde::Deserialize)]
struct KindProbe {
    kind: Option<String>,
}

/// Files larger than this are never read as kubeconfigs; real kubeconfigs
/// are a few KiB to a few hundred KiB.
pub const MAX_KUBECONFIG_FILE_SIZE: u64 = 16 * 1024 * 1024;

/// True when the file is a kubeconfig document: at most
/// [`MAX_KUBECONFIG_FILE_SIZE`] bytes, the whole document deserialises as
/// `KubeConfigFile`, and either `kind` is exactly `Config` or — `kind`
/// absent, as kubectl tolerates (#481) — at least one of `clusters`,
/// `contexts`, `users` has an entry.
///
/// Every field of a kubeconfig is optional, so a bare parse accepts any YAML
/// or JSON mapping as an empty config; the `kind` / entries check is what
/// tells a kubeconfig apart from an unrelated file. Used by `~/.kube`
/// discovery and by the desktop app to validate files the user adds
/// explicitly.
pub fn is_kubeconfig_file(path: &Path) -> bool {
    // `metadata` follows symlinks, so the cap applies to the target.
    let fits = std::fs::metadata(path).is_ok_and(|m| m.len() <= MAX_KUBECONFIG_FILE_SIZE);
    if !fits {
        return false;
    }
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(probe) = serde_yaml::from_str::<KindProbe>(&content) else {
        return false;
    };
    let Ok(config) = serde_yaml::from_str::<KubeConfigFile>(&content) else {
        return false;
    };
    match probe.kind.as_deref() {
        Some(kind) => kind == "Config",
        None => {
            !(config.clusters.is_empty() && config.contexts.is_empty() && config.users.is_empty())
        }
    }
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

    const TWO_FILE_A: &str = r#"
apiVersion: v1
kind: Config
current-context: dev
contexts:
  - name: dev
    context:
      cluster: dev-cluster
      user: dev-user
clusters:
  - name: dev-cluster
    cluster:
      server: https://a.example:6443
"#;

    const TWO_FILE_B: &str = r#"
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
      cluster: other-cluster
      user: other-user
clusters:
  - name: staging-cluster
    cluster:
      server: https://b.example:6443
"#;

    #[test]
    fn contexts_remember_the_file_that_defines_them() {
        let fa = write_temp(TWO_FILE_A);
        let fb = write_temp(TWO_FILE_B);
        let cfg = KubeConfig::load_from_paths(&[fa.path().to_path_buf(), fb.path().to_path_buf()])
            .expect("should merge");

        let dev = cfg.get_context("dev").expect("dev");
        let staging = cfg.get_context("staging").expect("staging");
        // First file wins the clash: dev keeps a's cluster and source.
        assert_eq!(
            dev.source.as_deref(),
            Some(fa.path().to_str().expect("utf8"))
        );
        assert_eq!(
            dev.cluster_server.as_deref(),
            Some("https://a.example:6443")
        );
        assert_eq!(
            staging.source.as_deref(),
            Some(fb.path().to_str().expect("utf8"))
        );
        assert_eq!(
            staging.cluster_server.as_deref(),
            Some("https://b.example:6443")
        );
    }

    #[test]
    fn sources_report_counts_and_shadowed_names_in_merge_order() {
        let fa = write_temp(TWO_FILE_A);
        let fb = write_temp(TWO_FILE_B);
        let missing = PathBuf::from("/tmp/does-not-exist-cubelite-test-sources.yaml");
        let cfg = KubeConfig::load_from_paths(&[
            fa.path().to_path_buf(),
            missing.clone(),
            fb.path().to_path_buf(),
        ])
        .expect("missing files are skipped");

        let sources = cfg.sources();
        assert_eq!(sources.len(), 3);
        assert_eq!(sources[0].path, fa.path().display().to_string());
        assert!(sources[0].exists);
        assert_eq!(sources[0].contexts, 1);
        assert!(sources[0].shadowed.is_empty());

        assert_eq!(sources[1].path, missing.display().to_string());
        assert!(!sources[1].exists);
        assert_eq!(sources[1].contexts, 0);

        assert!(sources[2].exists);
        assert_eq!(sources[2].contexts, 1);
        assert_eq!(sources[2].shadowed, vec!["dev".to_string()]);
    }

    #[test]
    fn missing_files_are_skipped_but_all_missing_is_an_error() {
        let fa = write_temp(TWO_FILE_A);
        let missing = PathBuf::from("/tmp/does-not-exist-cubelite-test-skip.yaml");
        let cfg = KubeConfig::load_from_paths(&[missing.clone(), fa.path().to_path_buf()])
            .expect("one existing file is enough");
        assert_eq!(cfg.context_names(), vec!["dev".to_string()]);
        // The spec only lists files that were actually loaded.
        assert_eq!(cfg.resolved_spec(), fa.path().display().to_string());

        let err = KubeConfig::load_from_paths(&[missing]).expect_err("all missing");
        assert!(matches!(err, KubeconfigError::FileNotFound { .. }));
    }

    #[test]
    fn save_writes_to_the_first_existing_file() {
        let fa = write_temp(TWO_FILE_A);
        let missing = PathBuf::from("/tmp/does-not-exist-cubelite-test-save.yaml");
        let mut cfg =
            KubeConfig::load_from_paths(&[missing.clone(), fa.path().to_path_buf()]).expect("load");
        cfg.set_active_context("dev").expect("dev exists");
        cfg.save().expect("save to first existing file");
        assert!(!missing.exists());
        let written = std::fs::read_to_string(fa.path()).expect("read back");
        assert!(written.contains("current-context: dev"));
    }

    #[test]
    fn resolved_spec_round_trips_through_split() {
        let fa = write_temp(TWO_FILE_A);
        let fb = write_temp(TWO_FILE_B);
        let paths = vec![fa.path().to_path_buf(), fb.path().to_path_buf()];
        let cfg = KubeConfig::load_from_paths(&paths).expect("load");
        assert_eq!(split_kubeconfig_spec(&cfg.resolved_spec()), paths);
    }

    #[test]
    fn load_from_spec_merges_the_listed_files() {
        let fa = write_temp(TWO_FILE_A);
        let fb = write_temp(TWO_FILE_B);
        let spec = env::join_paths([fa.path(), fb.path()])
            .expect("join")
            .to_string_lossy()
            .into_owned();
        let cfg = KubeConfig::load_from_spec(&spec).expect("load");
        assert_eq!(cfg.sources().len(), 2);
        assert_eq!(split_kubeconfig_spec(&cfg.resolved_spec()).len(), 2);
    }

    #[test]
    fn split_spec_drops_empty_entries() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let spec = format!("  /a/config{sep}{sep}/b/config{sep}  ");
        assert_eq!(
            split_kubeconfig_spec(&spec),
            vec![PathBuf::from("/a/config"), PathBuf::from("/b/config")]
        );
        assert!(split_kubeconfig_spec("   ").is_empty());
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

    // -- Own-file cluster/user resolution (#543) -----------------------------

    /// Earlier file: stale `aks-prod` cluster/user that no context here uses,
    /// plus entries a later file repeats verbatim.
    const STALE_FIRST: &str = r#"
apiVersion: v1
kind: Config
clusters:
  - name: aks-prod
    cluster:
      server: https://old.example:6443
  - name: shared
    cluster:
      server: https://shared.example:6443
      certificate-authority-data: Q0E=
  - name: only-first
    cluster:
      server: https://only-first.example:6443
  - name: ca-changed
    cluster:
      server: https://ca.example:6443
      certificate-authority-data: T0xE
users:
  - name: aks-user
    user:
      token: old-token
  - name: same-user
    user:
      token: same-token
  - name: exec-user
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: az-old
"#;

    /// Later file: defines its contexts together with their cluster and user.
    const OWN_SECOND: &str = r#"
apiVersion: v1
kind: Config
current-context: aks-prod
contexts:
  - name: aks-prod
    context:
      cluster: aks-prod
      user: aks-user
  - name: shared-ctx
    context:
      cluster: shared
      user: same-user
  - name: cross
    context:
      cluster: only-first
      user: aks-user
clusters:
  - name: aks-prod
    cluster:
      server: https://new.example:6443
  - name: shared
    cluster:
      server: https://shared.example:6443
      certificate-authority-data: Q0E=
  - name: ca-changed
    cluster:
      server: https://ca.example:6443
      certificate-authority-data: TkVX
users:
  - name: aks-user
    user:
      token: new-token
  - name: same-user
    user:
      token: same-token
  - name: exec-user
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: kubelogin
"#;

    fn load_stale_then_own() -> (NamedTempFile, NamedTempFile, KubeConfig) {
        let first = write_temp(STALE_FIRST);
        let second = write_temp(OWN_SECOND);
        let cfg =
            KubeConfig::load_from_paths(&[first.path().to_path_buf(), second.path().to_path_buf()])
                .expect("merge");
        (first, second, cfg)
    }

    #[test]
    fn an_empty_current_context_does_not_hide_a_later_files() {
        // `kubectl config set-cluster --kubeconfig <new file>` writes `""` (#552).
        let first = write_temp("apiVersion: v1\nkind: Config\ncurrent-context: \"\"\n");
        let second = write_temp(
            "apiVersion: v1\nkind: Config\ncurrent-context: team\ncontexts:\n- name: team\n  context: {cluster: c, user: u}\n",
        );
        let cfg =
            KubeConfig::load_from_paths(&[first.path().to_path_buf(), second.path().to_path_buf()])
                .expect("merge");
        assert_eq!(cfg.current_context(), Some("team"));

        let only_empty = KubeConfig::load_from_paths(&[first.path().to_path_buf()]).expect("load");
        assert_eq!(only_empty.current_context(), None);
    }

    #[test]
    fn a_file_with_null_lists_does_not_break_the_merge() {
        // kubectl writes `contexts: null` / `users: null` for empty lists (#557).
        let first = write_temp(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {server: https://c.example.com:6443}\ncontexts: null\nusers: null\n",
        );
        let second = write_temp(
            "apiVersion: v1\nkind: Config\ncurrent-context: team\ncontexts:\n- name: team\n  context: {cluster: c, user: u}\nusers:\n- name: u\n  user: {token: fake-token-1}\n",
        );
        let cfg =
            KubeConfig::load_from_paths(&[first.path().to_path_buf(), second.path().to_path_buf()])
                .expect("merge with null lists");
        assert_eq!(cfg.context_names(), vec!["team"]);
        let ctx = cfg.get_context("team").expect("team");
        assert_eq!(
            ctx.cluster_server.as_deref(),
            Some("https://c.example.com:6443")
        );
    }

    #[test]
    fn context_resolves_its_cluster_against_its_own_file_on_a_clash() {
        let (_a, _b, cfg) = load_stale_then_own();
        let ctx = cfg.get_context("aks-prod").expect("aks-prod");
        assert_eq!(
            ctx.cluster_server.as_deref(),
            Some("https://new.example:6443")
        );
        // Identity is unchanged: same context name, nothing synthetic.
        assert_eq!(cfg.context_names(), vec!["aks-prod", "shared-ctx", "cross"]);
        let listed = cfg.list_contexts();
        assert_eq!(
            listed[0].cluster_server.as_deref(),
            Some("https://new.example:6443")
        );
        assert!(listed[0].is_active);
    }

    #[test]
    fn context_cluster_missing_from_its_file_falls_back_to_an_earlier_file() {
        let (_a, _b, cfg) = load_stale_then_own();
        let cross = cfg.get_context("cross").expect("cross");
        assert_eq!(
            cross.cluster_server.as_deref(),
            Some("https://only-first.example:6443")
        );
        let shared = cfg.get_context("shared-ctx").expect("shared-ctx");
        assert_eq!(
            shared.cluster_server.as_deref(),
            Some("https://shared.example:6443")
        );
    }

    #[test]
    fn sources_report_clusters_and_users_an_earlier_file_defines_differently() {
        let (_a, _b, cfg) = load_stale_then_own();
        let sources = cfg.sources();
        assert!(sources[0].redefined_clusters.is_empty());
        assert!(sources[0].redefined_users.is_empty());
        // Identical duplicates (`shared`, `same-user`) are not reported; a CA
        // or an unmodelled field (`exec`) is enough to differ.
        assert_eq!(
            sources[1].redefined_clusters,
            vec!["aks-prod", "ca-changed"]
        );
        assert_eq!(sources[1].redefined_users, vec!["aks-user", "exec-user"]);
    }

    #[test]
    fn sources_report_nothing_redefined_without_clashes() {
        let fa = write_temp(TWO_FILE_A);
        let fb = write_temp(TWO_FILE_B);
        let cfg = KubeConfig::load_from_paths(&[fa.path().to_path_buf(), fb.path().to_path_buf()])
            .expect("merge");
        for source in cfg.sources() {
            assert!(source.redefined_clusters.is_empty());
            assert!(source.redefined_users.is_empty());
        }
    }

    // The redefinition fixture (#543) is the `redefinitions-parity` case of
    // `testdata/kubeconfig` (#548), run by `tests/kubeconfig_fixtures.rs`.

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
    fn save_preserves_exec_credential_plugins() {
        let yaml = r#"
apiVersion: v1
kind: Config
current-context: aks
contexts:
  - name: aks
    context: { cluster: aks, user: aks-user }
  - name: kind
    context: { cluster: kind, user: kind-user }
clusters:
  - name: aks
    cluster: { server: "https://aks:443" }
  - name: kind
    cluster: { server: "https://127.0.0.1:6443" }
users:
  - name: aks-user
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: kubelogin
        args: ["get-token", "--login", "azurecli"]
        env: null
        interactiveMode: IfAvailable
        provideClusterInfo: false
  - name: kind-user
    user:
      auth-provider:
        name: oidc
        config:
          idp-issuer-url: https://issuer.example.com
"#;
        let f = write_temp(yaml);
        let mut cfg = KubeConfig::load_from_paths(&[f.path().to_path_buf()]).expect("load");
        cfg.set_active_context("kind").expect("switch");
        cfg.save().expect("save");

        let written = std::fs::read_to_string(f.path()).expect("read back");
        assert!(written.contains("current-context: kind"));
        assert!(written.contains("command: kubelogin"), "exec block dropped");
        assert!(written.contains("interactiveMode: IfAvailable"));
        assert!(written.contains("auth-provider"), "auth-provider dropped");
        assert!(written.contains("idp-issuer-url"));
    }

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
    #[serial_test::serial]
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
    #[serial_test::serial]
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

    // -- Discovery (~/.kube/*) ------------------------------------------------

    fn kube_dir_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        for (name, content) in files {
            let path = dir.path().join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("mkdir");
            }
            std::fs::write(&path, content).expect("write");
        }
        dir
    }

    const MARKED: &str = "apiVersion: v1\nkind: Config\ncontexts: []\n";
    /// kubectl-compatible file without `apiVersion` / `kind` (#481).
    const NO_KIND: &str = "clusters:\n- name: lab\n  cluster: {server: \"https://lab.example:6443\"}\ncontexts:\n- name: lab\n  context: {cluster: lab, user: admin}\ncurrent-context: lab\nusers:\n- name: admin\n  user: {token: t}\n";

    #[test]
    fn discover_picks_marked_regular_files_sorted_and_skips_the_rest() {
        let dir = kube_dir_with(&[
            ("config", MARKED),
            ("zeta.yaml", MARKED),
            ("alpha.yaml", "apiVersion: v1\nkind: \"Config\"\n"),
            ("notes.txt", "just notes\n"),
            (".hidden", MARKED),
            ("cache/discovery/some.json", MARKED),
        ]);
        let default = dir.path().join("config");
        let found = discover_kubeconfig_files(dir.path(), &default);
        assert_eq!(
            found,
            vec![dir.path().join("alpha.yaml"), dir.path().join("zeta.yaml")]
        );
    }

    #[test]
    fn discover_skips_files_that_do_not_parse_as_kubeconfig() {
        let dir = kube_dir_with(&[
            (
                "configmap.yaml",
                "apiVersion: v1\nkind: ConfigMap\ndata: {a: b}\n",
            ),
            ("broken.yaml", "kind: Config\ncontexts: [\n"),
            ("good.yaml", MARKED),
        ]);
        let found = discover_kubeconfig_files(dir.path(), &dir.path().join("config"));
        assert_eq!(found, vec![dir.path().join("good.yaml")]);
    }

    #[test]
    fn is_kubeconfig_file_requires_kind_config_or_entries_and_a_full_parse() {
        let dir = kube_dir_with(&[
            ("good.yaml", MARKED),
            ("quoted.yaml", "apiVersion: v1\nkind: \"Config\"\n"),
            ("blob.json", "{\"name\": \"x\", \"items\": [1, 2]}\n"),
            ("no-kind.yaml", "apiVersion: v1\ncontexts: []\n"),
            ("no-kind-entries.yaml", NO_KIND),
            ("no-kind-users-only.yaml", "users:\n- name: u\n  user: {}\n"),
            (
                "other-kind-entries.yaml",
                "kind: Secret\ncontexts:\n- name: c\n  context: {cluster: c, user: u}\n",
            ),
            ("no-kind-mapping.yaml", "name: x\nitems: [1, 2]\n"),
            ("secret.yaml", "apiVersion: v1\nkind: Secret\ndata: {}\n"),
            ("broken.yaml", "kind: Config\ncontexts: [\n"),
            (
                "null-lists.yaml",
                "apiVersion: v1\nclusters:\n- cluster: {server: https://c.example.com}\n  name: c\ncontexts: null\nkind: Config\nusers: null\n",
            ),
            ("empty.yaml", ""),
        ]);
        let at = |name: &str| dir.path().join(name);
        assert!(is_kubeconfig_file(&at("good.yaml")));
        assert!(is_kubeconfig_file(&at("quoted.yaml")));
        assert!(!is_kubeconfig_file(&at("blob.json")));
        assert!(!is_kubeconfig_file(&at("no-kind.yaml")));
        assert!(is_kubeconfig_file(&at("no-kind-entries.yaml")));
        assert!(is_kubeconfig_file(&at("no-kind-users-only.yaml")));
        assert!(!is_kubeconfig_file(&at("other-kind-entries.yaml")));
        assert!(!is_kubeconfig_file(&at("no-kind-mapping.yaml")));
        assert!(!is_kubeconfig_file(&at("secret.yaml")));
        assert!(!is_kubeconfig_file(&at("broken.yaml")));
        assert!(is_kubeconfig_file(&at("null-lists.yaml")));
        assert!(!is_kubeconfig_file(&at("empty.yaml")));
        assert!(!is_kubeconfig_file(&at("missing.yaml")));
    }

    #[test]
    fn discover_finds_kubectl_ordered_file_with_long_certificate_data() {
        // kubectl sorts keys: with inline CA data `kind: Config` sits far
        // past the 512-byte header the old prefilter read (#479).
        let kubectl = format!(
            "apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: {}\n    server: https://prod.example:6443\n  name: prod\ncontexts:\n- context:\n    cluster: prod\n    user: admin\n  name: prod\ncurrent-context: prod\nkind: Config\npreferences: {{}}\nusers:\n- name: admin\n  user:\n    token: t\n",
            "QUJD".repeat(2_000)
        );
        let dir = kube_dir_with(&[("kubectl-generated", &kubectl), ("early.yaml", MARKED)]);
        let found = discover_kubeconfig_files(dir.path(), &dir.path().join("config"));
        assert_eq!(
            found,
            vec![
                dir.path().join("early.yaml"),
                dir.path().join("kubectl-generated")
            ]
        );
    }

    #[test]
    fn is_kubeconfig_file_skips_files_over_the_size_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("huge");
        let file = std::fs::File::create(&path).expect("create");
        std::io::Write::write_all(&mut &file, MARKED.as_bytes()).expect("write");
        file.set_len(MAX_KUBECONFIG_FILE_SIZE + 1).expect("set_len");
        assert!(!is_kubeconfig_file(&path));
    }

    #[test]
    fn discover_unreadable_dir_is_empty() {
        let missing = PathBuf::from("/tmp/cubelite-no-such-dir-424242");
        assert!(discover_kubeconfig_files(&missing, &missing.join("config")).is_empty());
    }
}
