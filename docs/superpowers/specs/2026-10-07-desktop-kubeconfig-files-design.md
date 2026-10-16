# Desktop kubeconfig file management — design

**Date**: 2026-10-07
**Status**: approved design
**Scope**: `crates/cubelite-core`, `apps/desktop` (Tauri backend + Svelte frontend), docs
**Parity target**: macOS app (`KubeconfigService.resolveKubeconfigPaths`, `KubeconfigPathsSection`, `KubeconfigWatcher`)

## 0. Problem

The desktop app loads only the files that `KUBECONFIG` lists, or `~/.kube/config`.
Preferences shows that list read-only. There is no way to add or remove a file,
no auto-discovery of other kubeconfig files in `~/.kube/`, and no reload when a
listed file changes on disk. The macOS app has all three, and
`docs/guide/features.md` already documents them as CubeLite features.

## 1. Decisions

1. **Custom list replaces the environment.** When the persisted custom list is
   non-empty it is the whole kubeconfig list; otherwise `KUBECONFIG`, otherwise
   the default resolution. Same semantics as the macOS app. "Use defaults"
   clears the custom list.
2. **Discovery in the core crate.** Default resolution = `~/.kube/config` plus
   every regular, non-hidden file in `~/.kube/` (not inside `cache/`) whose first
   512 bytes contain `kind: Config` or `kind: "Config"`, sorted by file name,
   `config` first. Applies only when neither a custom list nor `KUBECONFIG` is
   set.
3. **Live reload in this feature.** The Tauri backend watches the listed files
   and emits `kubeconfig-changed`; the frontend reloads contexts and the current
   scope.

## 2. Core (`crates/cubelite-core/src/kubeconfig.rs`, `context.rs`)

- `pub fn discover_kubeconfig_files(dir: &Path, excluding: &Path) -> Vec<PathBuf>`
  — the rule in §1.2; returns an empty list when `dir` is unreadable.
- `fn resolve_kubeconfig_paths()` — unchanged for `KUBECONFIG`; the fallback
  becomes `[~/.kube/config] + discover_kubeconfig_files(~/.kube, ~/.kube/config)`.
- `impl KubeConfig { pub fn load_from_spec(spec: &str) -> Result<Self, KubeconfigError> }`
  — `split_kubeconfig_spec` + `load_from_paths`; an empty spec falls back to
  `load()`.
- `context.rs` gains spec-aware variants used by the desktop commands:
  `list_context_infos_in(spec: Option<&str>)`, `current_context_in(spec)`,
  `set_active_context_in(spec, name)`. `None` or empty → existing behaviour.
  `set_active_context_in` saves `current-context` into the first file of the
  spec, as `kubectl config use-context` does with `KUBECONFIG`.

## 3. Tauri backend (`apps/desktop/src-tauri`)

### 3.1 Commands

| Command | Change |
|---|---|
| `kubeconfig_sources(custom_paths: Vec<String>)` | custom non-empty → `KubeConfig::load_from_paths(custom)`, `origin: "custom"`; else `KubeConfig::load()` with `origin: "env"` when `KUBECONFIG` is set and non-empty, `"default"` otherwise. Returns `{ spec, sources, origin }`. |
| `list_contexts(kubeconfig_path: Option<String>)`, `get_current_context(kubeconfig_path)`, `set_context(context_name, kubeconfig_path)` | pass the spec through to the `_in` helpers. Frontend always passes `app.kubeconfigPath`. |
| `watch_kubeconfig(paths: Vec<String>) -> String` (new) | `notify` recommended watcher on the **parent directories** of the listed files (editors and `aws eks update-kubeconfig` replace files atomically); events whose path matches a listed file are debounced 500 ms and emitted as `kubeconfig-changed` with payload `{ paths: [changed…] }`. Returns a watch id kept in `KubeconfigWatchState`. |
| `unwatch_kubeconfig(watch_id)` (new) | stops the watcher. |

Pure, unit-tested helpers (no Tauri types): `select_kubeconfig_origin(custom_non_empty, env_set) -> Origin`,
`watched_dirs(paths) -> Vec<PathBuf>` (dedupe parents), `is_listed_change(event_path, listed) -> bool`.

### 3.2 Plugins and capabilities

`tauri-plugin-dialog` (Rust) + `@tauri-apps/plugin-dialog` (npm); capability
`dialog:allow-open` on the `default` capability (window `main`). No `fs`
plugin: paths go to the backend, the webview never reads the files. Dependency
`notify = "8"` in `apps/desktop/src-tauri/Cargo.toml`.

## 4. Frontend (`apps/desktop/src`)

- `settings.kubeconfigPaths: persisted<string[]>("kubeconfigPaths", [], isStringArray)`.
- `app.kubeconfigOrigin: "custom" | "env" | "default"` next to `kubeconfigPath` / `kubeconfigSources`.
- New store method `clusters.reloadKubeconfig(reason: "startup" | "preferences" | "file-change")`:
  1. `kubeconfigSources(settings.kubeconfigPaths.value)` → `app.kubeconfigPath`, `app.kubeconfigSources`, `app.kubeconfigOrigin`;
  2. `clusters.refresh()`;
  3. if the active cluster disappeared, pick the active context from the merged file (or the first) and `switchCluster` it; otherwise on `file-change` just `resources.load()` so the current view stays;
  4. restart the kubeconfig watcher with the requested paths (`unwatch_kubeconfig` + `watch_kubeconfig`);
  5. on `file-change`, toast "Kubeconfig updated" (ok tone).
  `+page.svelte` startup calls `reloadKubeconfig("startup")` instead of the inline resolution and listens to `kubeconfig-changed` → `reloadKubeconfig("file-change")`.
- **Preferences → Kubeconfig** (existing section):
  - caption under the title: `From KUBECONFIG` / `From ~/.kube` / `Custom list`;
  - each row keeps path + context count + merged/missing notes and gains a `Remove` button (`aria-label="Remove <path>"`). Removing from a non-custom list first pins the resolved list as custom, then drops the file (the macOS "seed then edit" behaviour);
  - `Add file…` button: `open({ multiple: true, title: "Select kubeconfig files" })` from the dialog plugin; appends new absolute paths (dedupe); when the custom list is empty it is seeded with the resolved files first;
  - `Use defaults` link (visible only for `custom`) clears the list;
  - every change → `clusters.reloadKubeconfig("preferences")`.
- Onboarding step 1 keeps showing `app.kubeconfigPath`; no change.

## 5. Tests

- Rust core: discovery (ignores hidden, `cache/`, non-`kind: Config`, non-regular; sorted; `config` first; excluded default), `load_from_spec` empty → default, `set_active_context_in` writes the first file only.
- Rust backend: origin selection, `watched_dirs`, `is_listed_change`.
- vitest: `settings.kubeconfigPaths` validator; `clusters.reloadKubeconfig` (sources mocked) — custom list passed through, active cluster re-pick, watcher restarted; `PreferencesModal` — Add (dialog mocked, seeds then appends), Remove (pins then drops), Use defaults, origin caption.
- Playwright: `tauri-mock` handles `kubeconfig_sources` with `customPaths`, `watch_kubeconfig`, `unwatch_kubeconfig` and the dialog plugin command `plugin:dialog|open`; new case "adding a kubeconfig file lists it and reloads contexts"; existing "preferences list every kubeconfig file" keeps passing.
- Manual: add a second real kubeconfig, switch to one of its contexts; edit the file with `kubectl config set-context --current --namespace=x` and see the reload toast.

## 6. Delivery

Branch `feat/428-desktop-kubeconfig-files` from `main`. Two stacked PRs:

- **PR A** `feat(core,desktop): kubeconfig discovery, spec-aware context commands and file watcher` — §2, §3 (already visible: `~/.kube/*` contexts appear; no UI change).
- **PR B** `feat(desktop): manage kubeconfig files in Preferences` — §4, docs (`CHANGELOG`, `docs/guide/faq.md` wording "In Preferences you can add kubeconfig files"), e2e.

Out of scope: exec-in-pod and apply-manifest parity, the macOS CI skip bug (separate issue), Windows path edge cases beyond `env::join_paths`.
