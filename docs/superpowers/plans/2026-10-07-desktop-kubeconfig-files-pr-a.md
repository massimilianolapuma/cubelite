# Desktop Kubeconfig Files — PR A: Core Discovery, Spec-Aware Context Commands, File Watcher

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The core crate discovers extra kubeconfig files in `~/.kube/` and can work from an explicit file list; the Tauri backend exposes origin-aware `kubeconfig_sources`, spec-aware context commands, a debounced kubeconfig file watcher, and the dialog plugin — everything PR B's Preferences UI needs, with no UI change yet.

**Architecture:** Pure functions first (`discover_kubeconfig_files`, `KubeConfig::load_from_spec`, `context::*_in`), then Tauri commands that are thin wrappers around them, then a small `kubeconfig_watch` module built on `notify` with the debounce done in a tokio task. Every piece of logic that does not need Tauri types lives in a plain function with a unit test.

**Tech Stack:** Rust 2021 (`cubelite-core`, `cubelite-desktop`), `notify = "8"`, `tauri-plugin-dialog = "2"`, `tempfile` (dev), cargo fmt/clippy/test; `@tauri-apps/plugin-dialog` (npm), TypeScript wrappers in `apps/desktop/src/lib/tauri.ts`, vitest typecheck.

**Spec:** `docs/superpowers/specs/2026-10-07-desktop-kubeconfig-files-design.md` — §1, §2, §3, §5 (Rust rows), §6 PR A.

## Global Constraints

- Branch `feat/desktop-kubeconfig-files` (from `main`). PR A targets `main`. Conventional Commits; no AI attribution footer.
- Rust gates before every commit: `cargo fmt --check && cargo clippy --workspace --all-targets -- --deny warnings && cargo test --workspace; echo "EXIT=$?"`. No `unwrap()` / `expect()` outside `#[cfg(test)]`.
- Desktop gates when `apps/desktop` files change: `pnpm --filter desktop lint && pnpm --filter desktop typecheck && pnpm --filter desktop test; echo "EXIT=$?"` (run `pnpm --filter desktop exec svelte-kit sync` once first).
- Discovery rule (spec §1.2, verbatim): regular, non-hidden files directly in `~/.kube/` (so nothing inside `cache/`), excluding `~/.kube/config` itself, whose first 512 bytes contain `kind: Config` or `kind: "Config"`; sorted by path; the default file comes first in the resolved list. Applies only when neither a custom list nor `KUBECONFIG` is in effect.
- Precedence (spec §1.1): custom list → `KUBECONFIG` → default resolution. `origin` is `"custom"`, `"env"` or `"default"`.
- Watcher (spec §3.1): watch parent directories (non-recursive); only events whose path equals a listed file count; debounce 500 ms; event name `kubeconfig-changed`, payload `{ "paths": [...] }`.
- Context switch with a spec writes `current-context` to the first file of the spec only (existing `KubeConfig::save` behaviour).
- Backward compatibility: existing frontend calls (`kubeconfig_sources()` with no args, `list_contexts()`, `get_current_context()`, `set_context(contextName)`) keep working — new arguments are `Option`.

---

## File map

| File | Responsibility |
|---|---|
| `crates/cubelite-core/src/kubeconfig.rs` | `discover_kubeconfig_files`, `looks_like_kubeconfig`, default resolution with discovery, `KubeConfig::load_from_spec` |
| `crates/cubelite-core/src/context.rs` | `list_context_infos_in`, `current_context_in`, `set_active_context_in` (+ private `load_spec`) |
| `crates/cubelite-core/src/lib.rs` | re-export `discover_kubeconfig_files` |
| `apps/desktop/src-tauri/src/commands/kubernetes.rs` | `KubeconfigOrigin`, `select_kubeconfig_origin`, `kubeconfig_sources(custom_paths)`, spec-aware `list_contexts` / `get_current_context` / `set_context` |
| `apps/desktop/src-tauri/src/commands/kubeconfig_watch.rs` (new) | `KubeconfigWatchState`, `watch_kubeconfig`, `unwatch_kubeconfig`, `watched_dirs`, `is_listed_change`, `WatchedPaths` |
| `apps/desktop/src-tauri/src/commands/mod.rs`, `src/lib.rs` | module + command registration, dialog plugin init |
| `apps/desktop/src-tauri/Cargo.toml` | `notify`, `tauri-plugin-dialog` |
| `apps/desktop/src-tauri/capabilities/default.json` | `dialog:allow-open` |
| `apps/desktop/package.json` (+ lockfile) | `@tauri-apps/plugin-dialog` |
| `apps/desktop/src/lib/tauri.ts` | `KubeconfigOrigin`, `kubeconfigSources(customPaths?)`, context wrappers with optional `kubeconfigPath`, `watchKubeconfig`, `unwatchKubeconfig` |
| `apps/desktop/tests/e2e/tauri-mock.ts` | mock responses for the new commands |
| `CHANGELOG.md` | Unreleased entry |

---

### Task 1: Discovery of extra kubeconfig files in `~/.kube/`

**Files:**
- Modify: `crates/cubelite-core/src/kubeconfig.rs` (`resolve_kubeconfig_paths`, new helpers, tests)
- Modify: `crates/cubelite-core/src/lib.rs` (re-export)

**Interfaces:**
- Produces: `pub fn discover_kubeconfig_files(dir: &Path, excluding: &Path) -> Vec<PathBuf>` (sorted; empty when `dir` is unreadable) and `pub(crate) fn looks_like_kubeconfig(path: &Path) -> bool`. Re-exported as `cubelite_core::discover_kubeconfig_files`.

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests` in `crates/cubelite-core/src/kubeconfig.rs`:

```rust
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
    fn discover_only_reads_the_first_512_bytes() {
        let late_marker = format!("{}kind: Config\n", "# ".repeat(300));
        let dir = kube_dir_with(&[("late.yaml", &late_marker), ("early.yaml", MARKED)]);
        let found = discover_kubeconfig_files(dir.path(), &dir.path().join("config"));
        assert_eq!(found, vec![dir.path().join("early.yaml")]);
    }

    #[test]
    fn discover_unreadable_dir_is_empty() {
        let missing = PathBuf::from("/tmp/cubelite-no-such-dir-424242");
        assert!(discover_kubeconfig_files(&missing, &missing.join("config")).is_empty());
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p cubelite-core discover 2>&1 | grep -E 'error\[|cannot find|test result' | head -5`
Expected: `cannot find function 'discover_kubeconfig_files'`.

- [ ] **Step 3: Implement**

In `crates/cubelite-core/src/kubeconfig.rs`, add `use std::io::Read;` and `use std::path::Path;` to the imports (keep existing ones), then replace `resolve_kubeconfig_paths` and add the helpers:

```rust
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

/// Kubeconfig files to merge in addition to the default one: regular,
/// non-hidden files directly inside `dir` (so nothing under `cache/`), other
/// than `excluding`, whose first 512 bytes contain `kind: Config` or
/// `kind: "Config"`. Sorted by path; empty when `dir` cannot be read.
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
        .filter(|path| looks_like_kubeconfig(path))
        .collect();
    found.sort();
    found
}

/// True when the first 512 bytes of `path` carry the kubeconfig `kind` marker.
pub(crate) fn looks_like_kubeconfig(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 512];
    let read = file.read(&mut head).unwrap_or(0);
    let text = String::from_utf8_lossy(&head[..read]);
    text.contains("kind: Config") || text.contains("kind: \"Config\"")
}
```

In `crates/cubelite-core/src/lib.rs` change the re-export line to `pub use kubeconfig::{discover_kubeconfig_files, KubeConfig};`.

- [ ] **Step 4: Run the tests and the Rust gates**

Run: `cargo test -p cubelite-core discover 2>&1 | grep 'test result'` → `3 passed`. Then the Rust gates (Global Constraints) → `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add crates/cubelite-core/src/kubeconfig.rs crates/cubelite-core/src/lib.rs
git commit -m "feat(core): discover extra kubeconfig files in ~/.kube like the macOS app"
```

---

### Task 2: `KubeConfig::load_from_spec` and spec-aware context helpers

**Files:**
- Modify: `crates/cubelite-core/src/kubeconfig.rs` (`load_from_spec` + test)
- Modify: `crates/cubelite-core/src/context.rs` (`_in` helpers + tests)

**Interfaces:**
- Produces: `KubeConfig::load_from_spec(spec: &str) -> Result<KubeConfig, KubeconfigError>` (empty/blank spec → `load()`); `context::list_context_infos_in(spec: Option<&str>)`, `context::current_context_in(spec: Option<&str>)`, `context::set_active_context_in(spec: Option<&str>, name: &str)` — `None` or blank → same as the existing no-spec functions. Used by Task 3.

- [ ] **Step 1: Write the failing tests**

In `crates/cubelite-core/src/kubeconfig.rs` `mod tests`, after `resolved_spec_round_trips_through_split`:

```rust
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
```

(`TWO_FILE_A` / `TWO_FILE_B` already exist in that module.)

In `crates/cubelite-core/src/context.rs` `mod tests` (these need no `KUBECONFIG`, so no `#[serial]`):

```rust
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
        assert_eq!(current_context_in(Some(&spec)).expect("current").as_deref(), Some("a-ctx"));
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p cubelite-core _in 2>&1 | grep -E 'cannot find|no function|test result' | head -5`
Expected: `cannot find function 'list_context_infos_in'` (and friends).

- [ ] **Step 3: Implement**

`crates/cubelite-core/src/kubeconfig.rs`, inside `impl KubeConfig` right after `load()`:

```rust
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
```

`crates/cubelite-core/src/context.rs`, after `context_exists`:

```rust
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
```

Then make the three existing no-spec functions delegate, to avoid duplication: `list_context_infos()` → `list_context_infos_in(None)`, `current_context()` → `current_context_in(None)`, `set_active_context(name)` → `set_active_context_in(None, name)`.

- [ ] **Step 4: Tests + gates**

Run: `cargo test -p cubelite-core 2>&1 | grep 'test result'` → all passed, then the Rust gates → `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add crates/cubelite-core/src/kubeconfig.rs crates/cubelite-core/src/context.rs
git commit -m "feat(core): load kubeconfig from an explicit spec and spec-aware context helpers"
```

---

### Task 3: Origin-aware `kubeconfig_sources` and spec-aware context commands

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/kubernetes.rs`
- Modify: `apps/desktop/src/lib/tauri.ts` (types + wrappers)
- Modify: `apps/desktop/tests/e2e/tauri-mock.ts` (fixture gains `origin`)

**Interfaces:**
- Produces (Rust): `pub enum KubeconfigOrigin { Custom, Env, Default }` (serde lowercase), `pub fn select_kubeconfig_origin(custom_non_empty: bool, env_set: bool) -> KubeconfigOrigin`, `pub fn kubeconfig_env_is_set() -> bool`; commands `kubeconfig_sources(custom_paths: Option<Vec<String>>) -> KubeconfigSources { spec, sources, origin }`, `list_contexts(kubeconfig_path: Option<String>)`, `get_current_context(kubeconfig_path: Option<String>)`, `set_context(context_name: String, kubeconfig_path: Option<String>)`.
- Produces (TS): `type KubeconfigOrigin = "custom" | "env" | "default"`, `KubeconfigSources.origin`, `kubeconfigSources(customPaths: string[] = [])`, `listContexts(kubeconfigPath?: string)`, `getCurrentContext(kubeconfigPath?: string)`, `setContext(contextName: string, kubeconfigPath?: string)`.

- [ ] **Step 1: Write the failing Rust test**

Append to `apps/desktop/src-tauri/src/commands/kubernetes.rs`:

```rust
#[cfg(test)]
mod kubeconfig_origin_tests {
    use super::*;

    #[test]
    fn custom_list_wins_over_env_and_default() {
        assert!(matches!(select_kubeconfig_origin(true, true), KubeconfigOrigin::Custom));
        assert!(matches!(select_kubeconfig_origin(true, false), KubeconfigOrigin::Custom));
        assert!(matches!(select_kubeconfig_origin(false, true), KubeconfigOrigin::Env));
        assert!(matches!(select_kubeconfig_origin(false, false), KubeconfigOrigin::Default));
    }

    #[test]
    fn origin_serialises_lowercase() {
        assert_eq!(serde_json::to_string(&KubeconfigOrigin::Env).unwrap(), "\"env\"");
    }
}
```

Run: `cargo test -p cubelite-desktop kubeconfig_origin 2>&1 | grep -E 'cannot find|test result' | head -3` → `cannot find function 'select_kubeconfig_origin'`.

- [ ] **Step 2: Implement the backend**

Replace the `KubeconfigSources` struct and `kubeconfig_sources` command with:

```rust
/// Where the kubeconfig list came from (spec §1.1 precedence).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KubeconfigOrigin {
    /// The user's custom list from Preferences.
    Custom,
    /// `KUBECONFIG` from the environment (or imported from the login shell).
    Env,
    /// `~/.kube/config` plus discovered `~/.kube/*` files.
    Default,
}

/// Precedence: custom list → `KUBECONFIG` → default resolution.
pub fn select_kubeconfig_origin(custom_non_empty: bool, env_set: bool) -> KubeconfigOrigin {
    if custom_non_empty {
        KubeconfigOrigin::Custom
    } else if env_set {
        KubeconfigOrigin::Env
    } else {
        KubeconfigOrigin::Default
    }
}

/// True when `KUBECONFIG` is set to a non-blank value.
pub fn kubeconfig_env_is_set() -> bool {
    std::env::var("KUBECONFIG")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

/// Resolved kubeconfig file list for the UI: `spec` is the loaded files
/// joined like `KUBECONFIG` (what every other command takes as
/// `kubeconfig_path`); `sources` describes each listed file in merge order;
/// `origin` says which precedence level produced the list.
#[derive(Debug, Serialize)]
pub struct KubeconfigSources {
    pub spec: String,
    pub sources: Vec<cubelite_core::KubeconfigSource>,
    pub origin: KubeconfigOrigin,
}

/// Describe the kubeconfig files in use. A non-empty `custom_paths` replaces
/// `KUBECONFIG` / `~/.kube` resolution entirely (spec §1.1).
#[tauri::command]
pub async fn kubeconfig_sources(
    custom_paths: Option<Vec<String>>,
) -> Result<KubeconfigSources, String> {
    let custom: Vec<std::path::PathBuf> = custom_paths
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .map(std::path::PathBuf::from)
        .collect();
    tokio::task::spawn_blocking(move || {
        let origin = select_kubeconfig_origin(!custom.is_empty(), kubeconfig_env_is_set());
        let cfg = if custom.is_empty() {
            cubelite_core::KubeConfig::load()
        } else {
            cubelite_core::KubeConfig::load_from_paths(&custom)
        }
        .map_err(|e| e.to_string())?;
        Ok(KubeconfigSources {
            spec: cfg.resolved_spec(),
            sources: cfg.sources(),
            origin,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
```

Replace the three context commands:

```rust
/// List all contexts from the kubeconfig (`kubeconfig_path` = the resolved
/// spec from [`kubeconfig_sources`]; `None` = default resolution).
#[tauri::command]
pub async fn list_contexts(
    kubeconfig_path: Option<String>,
) -> Result<Vec<cubelite_core::ContextInfo>, String> {
    tokio::task::spawn_blocking(move || {
        cubelite_core::context::list_context_infos_in(kubeconfig_path.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Get the name of the currently active context.
#[tauri::command]
pub async fn get_current_context(kubeconfig_path: Option<String>) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        cubelite_core::context::current_context_in(kubeconfig_path.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Switch to a different kubeconfig context (persists to the first file of
/// the spec, like `kubectl config use-context`).
#[tauri::command]
pub async fn set_context(
    context_name: String,
    kubeconfig_path: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        cubelite_core::context::set_active_context_in(kubeconfig_path.as_deref(), &context_name)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
```

- [ ] **Step 3: Frontend types and wrappers (`apps/desktop/src/lib/tauri.ts`)**

Add after `KubeconfigSource`:

```ts
/** Which precedence level produced the kubeconfig list (spec §1.1). */
export type KubeconfigOrigin = "custom" | "env" | "default";
```

Change `KubeconfigSources` to include `origin: KubeconfigOrigin;` and the wrappers to:

```ts
/** Resolve the kubeconfig list; a non-empty `customPaths` replaces KUBECONFIG. */
export function kubeconfigSources(customPaths: string[] = []): Promise<KubeconfigSources> {
  return invoke<KubeconfigSources>("kubeconfig_sources", { customPaths });
}

export function listContexts(kubeconfigPath?: string): Promise<ContextInfo[]> {
  return invoke<ContextInfo[]>("list_contexts", { kubeconfigPath: kubeconfigPath ?? null });
}

export function getCurrentContext(kubeconfigPath?: string): Promise<string | null> {
  return invoke<string | null>("get_current_context", { kubeconfigPath: kubeconfigPath ?? null });
}

export function setContext(contextName: string, kubeconfigPath?: string): Promise<void> {
  return invoke("set_context", { contextName, kubeconfigPath: kubeconfigPath ?? null });
}
```

Call sites keep compiling (new parameters are optional). In `apps/desktop/tests/e2e/tauri-mock.ts` add `origin: "env",` to `FIXTURES.kubeconfig`.

- [ ] **Step 4: Gates**

Rust gates → `EXIT=0` (the new `kubeconfig_origin_tests` pass). Desktop gates → `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/kubernetes.rs apps/desktop/src/lib/tauri.ts apps/desktop/tests/e2e/tauri-mock.ts
git commit -m "feat(desktop): origin-aware kubeconfig_sources and spec-aware context commands"
```

---

### Task 4: Kubeconfig file watcher (`watch_kubeconfig` / `unwatch_kubeconfig`)

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/kubeconfig_watch.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src/lib/tauri.ts`, `apps/desktop/tests/e2e/tauri-mock.ts`

**Interfaces:**
- Produces (Rust): `pub struct KubeconfigWatchState` (managed), `watch_kubeconfig(app, paths: Vec<String>) -> Result<String, String>`, `unwatch_kubeconfig(app, watch_id: String) -> Result<(), String>`, pure `pub fn watched_dirs(paths: &[PathBuf]) -> Vec<PathBuf>`, `pub fn is_listed_change(event_path: &Path, listed: &[PathBuf]) -> bool`; event `kubeconfig-changed` with payload `KubeconfigChanged { paths: Vec<String> }`.
- Produces (TS): `watchKubeconfig(paths: string[]): Promise<string>`, `unwatchKubeconfig(watchId: string): Promise<void>`, event name constant `KUBECONFIG_CHANGED = "kubeconfig-changed"`.

- [ ] **Step 1: Add the dependency and write the failing tests**

In `apps/desktop/src-tauri/Cargo.toml` `[dependencies]` add `notify = "8"`.

Create `apps/desktop/src-tauri/src/commands/kubeconfig_watch.rs` with only the tests for now:

```rust
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
        assert_eq!(dirs, vec![PathBuf::from("/home/u/.kube"), PathBuf::from("/opt/kube")]);
    }

    #[test]
    fn is_listed_change_matches_exact_paths_only() {
        let listed = [PathBuf::from("/home/u/.kube/config")];
        assert!(is_listed_change(Path::new("/home/u/.kube/config"), &listed));
        assert!(!is_listed_change(Path::new("/home/u/.kube/config.swp"), &listed));
        assert!(!is_listed_change(Path::new("/home/u/.kube/team.yaml"), &listed));
    }
}
```

Register the module in `apps/desktop/src-tauri/src/commands/mod.rs` (`pub mod kubeconfig_watch;`).

Run: `cargo test -p cubelite-desktop kubeconfig_watch 2>&1 | grep -E 'cannot find|test result' | head -3` → `cannot find function 'watched_dirs'`.

- [ ] **Step 2: Implement the module**

Prepend to `kubeconfig_watch.rs`:

```rust
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
                    Ok(Some(more)) => changed.extend(
                        more.into_iter().filter(|p| is_listed_change(p, &listed)),
                    ),
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
```

In `apps/desktop/src-tauri/src/lib.rs`: import `commands::kubeconfig_watch::{unwatch_kubeconfig, watch_kubeconfig, KubeconfigWatchState}`, add `.manage(KubeconfigWatchState::default())` and the two commands to `generate_handler!`.

- [ ] **Step 3: Frontend wrappers and e2e mock**

`apps/desktop/src/lib/tauri.ts`:

```ts
/** Tauri event emitted when a watched kubeconfig file changes on disk. */
export const KUBECONFIG_CHANGED = "kubeconfig-changed";
export type KubeconfigChanged = { paths: string[] };

export function watchKubeconfig(paths: string[]): Promise<string> {
  return invoke<string>("watch_kubeconfig", { paths });
}

export function unwatchKubeconfig(watchId: string): Promise<void> {
  return invoke("unwatch_kubeconfig", { watchId });
}
```

`apps/desktop/tests/e2e/tauri-mock.ts` `responses` switch: add `case "watch_kubeconfig": return "kw1";` and `case "unwatch_kubeconfig": return null;`.

- [ ] **Step 4: Gates + manual smoke**

Rust gates → `EXIT=0`; desktop gates → `EXIT=0`. Smoke (optional but recommended): `cargo run -p cubelite-desktop --no-default-features` is heavy; instead a tiny Rust unit test is not possible for the Tauri command, so verify in PR B's manual test. Note this in the report.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml Cargo.lock apps/desktop/src-tauri/src/commands/kubeconfig_watch.rs apps/desktop/src-tauri/src/commands/mod.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/lib/tauri.ts apps/desktop/tests/e2e/tauri-mock.ts
git commit -m "feat(desktop): debounced kubeconfig file watcher emitting kubeconfig-changed"
```

---

### Task 5: Dialog plugin wiring

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/capabilities/default.json`, `apps/desktop/package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Add the plugin**

- Cargo: `tauri-plugin-dialog = "2"` under `[dependencies]`.
- `lib.rs`: `.plugin(tauri_plugin_dialog::init())` next to the other plugins.
- `capabilities/default.json` `permissions`: add `"dialog:allow-open"`.
- npm: `pnpm --filter desktop add @tauri-apps/plugin-dialog@^2` (updates `package.json` and the lockfile).

- [ ] **Step 2: Verify**

Run: `cargo build -p cubelite-desktop 2>&1 | tail -2; echo "EXIT=$?"` → builds. Rust gates → `EXIT=0`. Desktop gates → `EXIT=0`. `pnpm install --frozen-lockfile; echo "EXIT=$?"` → 0 (lockfile consistent).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml Cargo.lock apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/capabilities/default.json apps/desktop/package.json pnpm-lock.yaml
git commit -m "chore(desktop): add tauri-plugin-dialog for the kubeconfig file picker"
```

---

### Task 6: Changelog, issue, PR A

- [ ] **Step 1: Changelog** — under `## [Unreleased]` add `### Added`:

```markdown
- **Kubeconfig discovery** (desktop, core): without `KUBECONFIG`, CubeLite now
  merges `~/.kube/config` with every other kubeconfig found in `~/.kube/`
  (files whose head says `kind: Config`; hidden files and `cache/` ignored),
  matching the macOS app. The backend also exposes an origin-aware
  `kubeconfig_sources`, spec-aware context commands and a debounced
  `kubeconfig-changed` watcher, ready for file management in Preferences.
```

- [ ] **Step 2: Gates** — Rust and desktop gates, `EXIT=0` each; `cargo doc --workspace --no-deps 2>&1 | grep -c warning` → 0 new warnings.

- [ ] **Step 3: Issue** — if the feature issue does not exist yet (GitHub returned 500 on 2026-10-07), retry: `GH_TOKEN=$(gh auth token --user massilp) gh issue create --title "feat(desktop): manage kubeconfig files in Preferences (add/remove, ~/.kube discovery, live reload)" --label "area:desktop,area:core,type:feat" --body-file <path>` with the body from the spec's §0/§1/§5. Record the number N.

- [ ] **Step 4: Push + PR**

```bash
git -c credential.helper= -c credential.helper='!f() { echo username=massilp; echo "password=$(gh auth token --user massilp)"; }; f' push -u origin feat/desktop-kubeconfig-files
GH_TOKEN=$(gh auth token --user massilp) gh pr create --base main --head feat/desktop-kubeconfig-files \
  --title "feat(core,desktop): kubeconfig discovery, spec-aware context commands and file watcher" \
  --label "area:desktop,area:core,type:feat,status:review" \
  --body "Part of #N (PR A of 2) …"
```

PR body: What (one bullet per task), Spec path (§2, §3), Verification (gate commands + test counts), "PR B (Preferences UI) follows on top". Then `gh pr checks --watch` (cap 20 min) and report.

---

## Self-review

- **Spec coverage (PR A):** §1.2 + §2 discovery → Task 1; §2 `load_from_spec` + `_in` helpers → Task 2; §3.1 `kubeconfig_sources` origin + context commands → Task 3; §3.1 watcher → Task 4; §3.2 plugins/capabilities/deps → Tasks 4–5; §5 Rust tests → Tasks 1–4; §6 PR A → Task 6.
- **Placeholders:** none; the only external unknown (issue number) has an explicit retry step.
- **Type consistency:** `discover_kubeconfig_files(dir, excluding)` same in Task 1 code/tests and Task 1 resolve; `load_from_spec` used by `load_spec` in Task 2; `select_kubeconfig_origin(bool, bool)` and `KubeconfigOrigin` identical in Task 3 code/tests/TS type; `watched_dirs(&[PathBuf])`, `is_listed_change(&Path, &[PathBuf])` identical in Task 4 code/tests; command names `watch_kubeconfig` / `unwatch_kubeconfig` match TS wrappers and the e2e mock.
