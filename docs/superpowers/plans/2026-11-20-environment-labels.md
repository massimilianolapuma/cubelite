# Environment labels Implementation Plan (#662, PR 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every kubeconfig context carries an environment label (Development, Test, Staging,
Production or not set), detected from its name or set by hand, held by the backend and shown on
the active cluster.

**Architecture:** detection is a pure function in `cubelite-core`. The Tauri crate owns a new
settings file `cluster-access.json` in the app config directory (shared with PR 2, which adds
access state), commands to read and change it, and one event on change. The desktop app gets a
store over those commands, the label on the top bar chip and the rail tooltip, an Environment
submenu, and a new Preferences section Clusters.

**Tech Stack:** Rust (serde, tempfile for tests), Tauri 2, Svelte 5 runes, bits-ui DropdownMenu,
Vitest, Playwright with the Tauri mock.

**Spec:** `docs/superpowers/specs/2026-11-20-read-only-clusters-design.md` — this PR covers §3,
§5.1 (tooltip only), §5.2 (environment chip and submenu only), §6.1–6.2 (environment column) and
§6.4, §7.1–7.2 for labels and variants, §8 for the same, §9 item 1. Nothing here locks a cluster.

## Global Constraints

- Environments: `development`, `test`, `staging`, `production`; shown Development, Test, Staging,
  Production; "Not set" when none.
- Words: split the context name on any char that is not an ASCII letter or digit; a word matches
  a variant when, ignoring case, it equals it or equals it followed only by digits. First matching
  word, left to right, wins. Only the context name is read.
- Default variants (verbatim, spec §3.2): Development `dev, develop, development, svil, sviluppo`;
  Test `test, tst, qa`; Staging `stg, stage, staging, coll, collaudo, uat, preprod`; Production
  `prod, prd, production, produzione`.
- A label set by hand is never overwritten by detection; "Detect from name" returns to detection.
- State lives in the backend file `cluster-access.json` in `app.path().app_config_dir()`, never in
  `localStorage`. Atomic writes (temp file + rename). Unreadable file → renamed
  `cluster-access.json.bad`, defaults used, one toast.
- Contexts are identified by name.
- Environment chip is neutral (`ui/Chip`, `surface-container-high`, `text-muted`, `type-micro`):
  no red/amber/green.
- UI copy in English, sentence case. Tonal tokens only (design lint must pass).
- No `unwrap()`/`expect()` outside tests. No new dependency except what the plan names.
- Branch `feat/662-environment-labels` (spec already committed there). Gates: `scripts/gates.sh
  --rust` green before each commit that touches Rust, `scripts/gates.sh --no-e2e` otherwise, full
  gates before the last commit. Never push.

## Review Focus

1. A context name full of separators or digits only (`prod`, `PROD-01`, `my.prod.cluster`,
   `prod01a`, `01`, empty string) — detection must not panic and must follow the word rule
   (`prod01a` is not Production).
2. The settings file missing, empty, truncated, or with an unknown environment string written by a
   newer version — the app starts, unknown values read as not set, the file is not lost silently.
3. Two contexts with names differing only by case (`Prod` vs `prod`) — two separate records.
4. Variants edited to something that collides (same word in two environments, with spaces,
   uppercase, a dash) — refused or normalised, never stored in a way detection cannot use.
5. A kubeconfig reload that removes the active context while the Clusters section is open — the
   section re-renders without the row, no stale menu acting on a vanished name.

Each item has its test in the task that owns the code (marked "Review Focus n").

---

## File map

| File | Responsibility |
|---|---|
| `crates/cubelite-core/src/environment.rs` (new) | `Environment`, `Variants`, `detect`, `validate_variants` |
| `crates/cubelite-core/src/lib.rs` | `pub mod environment;` |
| `apps/desktop/src-tauri/src/commands/cluster_access.rs` (new) | settings file model, load/save, state, commands, event |
| `apps/desktop/src-tauri/src/commands/mod.rs`, `src/lib.rs` | register module, managed state, commands |
| `apps/desktop/src/lib/tauri.ts` | types + wrappers + event name |
| `apps/desktop/src/lib/stores/cluster-settings.svelte.ts` (new) | store over the commands, event listener |
| `apps/desktop/src/lib/components/shell/TopBar.svelte` | chip + Environment submenu |
| `apps/desktop/src/lib/components/shell/ClusterRail.svelte` | tooltip with label |
| `apps/desktop/src/lib/components/ClustersPreferences.svelte` (new) | Clusters section |
| `apps/desktop/src/lib/components/PreferencesModal.svelte`, `stores/app.svelte.ts` | mount section after Connection, scroll target `clusters` |
| `apps/desktop/tests/e2e/tauri-mock.ts`, `tests/e2e/environment-labels.spec.ts` (new) | mock + e2e |
| `CHANGELOG.md` | `### Added` under Unreleased |

---

### Task 1: Detection in the core

**Files:**
- Create: `crates/cubelite-core/src/environment.rs` (tests in-module)
- Modify: `crates/cubelite-core/src/lib.rs`

**Interfaces:**
- Produces:
  - `#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)] #[serde(rename_all = "lowercase")] pub enum Environment { Development, Test, Staging, Production }` with `Environment::ALL: [Environment; 4]` in that order.
  - `#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)] pub struct Variants(pub BTreeMap<Environment, Vec<String>>)` (derive `Ord` on `Environment` for the map) with `impl Default` = the Global Constraints list.
  - `pub fn detect(context_name: &str, variants: &Variants) -> Option<Environment>`
  - `pub fn validate_variants(input: &Variants) -> Result<Variants, VariantsError>` — trims, lowercases, drops empty words; rejects a word with a char outside `[a-z0-9]` (`VariantsError::InvalidWord { environment, word }`) and a word in two environments (`VariantsError::Duplicate { word, first, second }`); missing environments get an empty list. `VariantsError` is a `thiserror` enum with `Display` text "\"<word>\" is not a single word" and "\"<word>\" is already in <First>" (environment shown capitalised).

- [ ] **Step 1: Write the failing tests** in `environment.rs`:
  - `detects_user_contexts`: `aks-prod-01-emm`→Production, `aks-test-01-emm`→Test, `aks-svil-01-emm`→Development, `kub3-dev`→Development, `dol-lab-aks`→None, `minikube`→None.
  - `every_default_variant_detects_its_environment` (loop over `Variants::default()`, name `x-<variant>-y`).
  - `case_and_digits`: `PROD`, `Prod01`, `svil2`→match; `prod01a`, `prodx`, `production2b`→None (Review Focus 1).
  - `whole_words_only`: `preprod-eu`→Staging; `devops-tools`→None; `my.prod.cluster`, `user@prd`, `a:qa/b c`→match.
  - `first_word_wins`: `dev-to-prod`→Development.
  - `degenerate_names`: `""`, `"01"`, `"---"`→None, no panic (Review Focus 1).
  - `validate_normalises_and_rejects` (Review Focus 4): `" Prod "`→`prod`; `"pre-prod"`→InvalidWord; `prod` in Test and Production→Duplicate; empty words dropped.
- [ ] **Step 2: Run** `cargo test -p cubelite-core environment` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the interfaces above. Matching: split with `char::is_ascii_alphanumeric` as the word test; for each word, lowercase, strip trailing ASCII digits, compare the stripped word to each variant; a word that is only digits never matches.
- [ ] **Step 4: Run** `cargo test -p cubelite-core environment` and `cargo clippy -p cubelite-core --all-targets -- --deny warnings` — Expected: PASS, no warnings.
- [ ] **Step 5: Commit** `feat(core): detect a context's environment from its name (#662)`.

---

### Task 2: Settings file, commands and event (Tauri)

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/cluster_access.rs` (tests in-module, `tempfile`)
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`, `apps/desktop/src-tauri/src/lib.rs` (manage state, register commands)

**Interfaces:**
- Consumes: Task 1 (`Environment`, `Variants`, `detect`, `validate_variants`).
- Produces:
  - File model (serde, every field `#[serde(default)]` so PR 2 can add `access`, `confirm_unlock`, `read_only_from_start` without a migration):
    ```rust
    struct SettingsFile { version: u32 /* 1 */, contexts: BTreeMap<String, ContextRecord>, variants: Variants }
    struct ContextRecord { environment: EnvironmentSetting }
    #[serde(tag = "source", rename_all = "lowercase")]
    enum EnvironmentSetting { Detected, Manual { value: Option<Environment> } }   // default Detected
    ```
    An unknown environment string in `Manual.value` deserialises to `None` (custom deserialiser or `Option<String>` mapped through `Environment` parse), never an error (Review Focus 2).
  - `pub struct ClusterAccessState` (managed): `Mutex<SettingsFile>` + the file path. `ClusterAccessState::load(path: PathBuf) -> (Self, LoadOutcome)` where `LoadOutcome` is `Fresh | Loaded | Recovered` (Recovered = file unreadable, renamed to `cluster-access.json.bad`, defaults used). Saving: write `cluster-access.json.tmp` in the same dir, `rename` over the file.
  - View sent to the webview, snake_case fields as `ContextInfo`:
    ```rust
    pub struct ClusterSettingsView {
        contexts: Vec<ContextEnvironmentView>,   // in the order of the names asked for
        variants: Variants,
        recovered: bool,                          // true once, on the first call after a Recovered load
    }
    pub struct ContextEnvironmentView { name: String, environment: Option<Environment>, source: &'static str /* "detected" | "manual" */ }
    ```
  - Commands (all `Result<_, String>`):
    - `cluster_settings(contexts: Vec<String>) -> ClusterSettingsView` — records every name not yet in the file (as `Detected`), saves if anything was added, answers with the view.
    - `set_cluster_environment(context: String, setting: EnvironmentSetting) -> ClusterSettingsView` — answers with the view for that one context plus variants; emits the event.
    - `set_environment_variants(variants: Variants) -> Variants` — runs `validate_variants`, error text = `VariantsError` Display; saves; emits the event.
  - Event `CLUSTER_SETTINGS_CHANGED = "cluster-settings-changed"`, payload `()`.
  - In `lib.rs` setup: resolve `app.path().app_config_dir()`, `create_dir_all`, `ClusterAccessState::load`, `app.manage(...)`. If the dir cannot be resolved, use an in-memory state that never saves and log one error; never panic.

- [ ] **Step 1: Write the failing tests** in `cluster_access.rs` (pure functions over a temp dir; commands tested through the inner functions they call):
  - `fresh_dir_starts_with_defaults_and_writes_nothing_until_needed`.
  - `first_sight_records_detected` (`aks-prod-01-emm` → Production/detected, saved to disk, reload sees it).
  - `manual_survives_variant_change`: set `minikube` Manual Some(Development); set variants without `dev`; `minikube` still Development, `kub3-dev` now None.
  - `detect_from_name_returns_to_detection`.
  - `manual_none_is_not_set` (Manual { value: None } → environment None, source "manual").
  - `case_differing_names_are_separate` (`Prod`, `prod`) (Review Focus 3).
  - `round_trip_and_atomic_write`: after save, no `.tmp` left, file parses.
  - `unreadable_file_is_set_aside` (Review Focus 2): file `{"contexts": ` → `.bad` exists with the old bytes, state = defaults, first view has `recovered: true`, second `false`; empty file → same.
  - `unknown_environment_reads_as_not_set` (Review Focus 2): `{"version":1,"contexts":{"a":{"environment":{"source":"manual","value":"qa-env"}}}}` → `a` Manual None, load is `Loaded` not `Recovered`.
  - `unknown_fields_are_ignored` (PR 2 forward/backward compatibility): extra `"access":"read_only"` loads.
  - `variants_validation_error_text`: duplicate → `"\"prod\" is already in Production"`.
- [ ] **Step 2: Run** `cargo test -p cubelite-desktop cluster_access` — Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces; register the three commands in `generate_handler!` and the state in `lib.rs`.
- [ ] **Step 4: Run** `scripts/gates.sh --rust --only rust`, then `cargo clippy --workspace --all-targets -- --deny warnings` and `cargo fmt --check` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(desktop): keep each context's environment in a backend settings file (#662)`.

---

### Task 3: Desktop store

**Files:**
- Modify: `apps/desktop/src/lib/tauri.ts` (types, wrappers, `CLUSTER_SETTINGS_CHANGED`)
- Create: `apps/desktop/src/lib/stores/cluster-settings.svelte.ts`, `apps/desktop/src/lib/stores/cluster-settings.svelte.test.ts`
- Modify: `apps/desktop/src/lib/stores/clusters.svelte.ts` (call the store after `refresh` loads contexts)

**Interfaces:**
- Consumes: Task 2 commands and event.
- Produces:
  - `tauri.ts`: `type Environment = "development" | "test" | "staging" | "production"`; `type EnvironmentSetting = { source: "detected" } | { source: "manual"; value: Environment | null }`; `interface ContextEnvironment { name: string; environment: Environment | null; source: "detected" | "manual" }`; `interface ClusterSettings { contexts: ContextEnvironment[]; variants: Record<Environment, string[]>; recovered: boolean }`; `clusterSettings(contexts: string[]): Promise<ClusterSettings>`; `setClusterEnvironment(context: string, setting: EnvironmentSetting): Promise<ClusterSettings>`; `setEnvironmentVariants(variants: Record<Environment, string[]>): Promise<Record<Environment, string[]>>`.
  - `lib/environment.ts` (or inside the store file): `ENVIRONMENT_LABEL: Record<Environment, string>` = Development/Test/Staging/Production; `environmentLabel(e: Environment | null): string` → "Not set" for null.
  - Store `clusterSettings` (class instance, runes): `byName: Record<string, ContextEnvironment>`, `variants`, `environmentOf(name: string): Environment | null`, `sourceOf(name): "detected" | "manual" | null`, `load(names: string[]): Promise<void>`, `setEnvironment(name, setting): Promise<void>`, `setVariants(v): Promise<string | null>` (returns the backend's error text or null), `start(): Promise<void>` (listens to the event and reloads with the last names). A `load` answer older than a newer `load` is dropped (seq counter). `recovered: true` → `toasts.push("Cluster settings could not be read and were reset", "err")` once.
  - The toast action of spec §3.3 (Production by hand → "Make read-only") belongs to PR 2: nothing to lock yet.

- [ ] **Step 1: Write the failing tests** (`vi.mock` of `#lib/tauri.js`, as the other store tests):
  - `load maps contexts by name`, `environmentOf unknown name is null`.
  - `stale load is dropped` (two loads, first resolves last).
  - `event triggers reload with the last names`.
  - `recovered shows one error toast`.
  - `setVariants returns backend error text` and leaves `variants` unchanged.
  - `clusters.refresh calls clusterSettings.load with context names`.
- [ ] **Step 2: Run** `pnpm --filter desktop test -- cluster-settings clusters` — Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces.
- [ ] **Step 4: Run** `scripts/gates.sh --no-e2e` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(desktop): store for cluster environments (#662)`.

---

### Task 4: Label in the shell, Environment submenu, Preferences Clusters

**Files:**
- Modify: `apps/desktop/src/lib/components/shell/TopBar.svelte`, `.../shell/ClusterRail.svelte`
- Create: `apps/desktop/src/lib/components/ClustersPreferences.svelte` + `clusters-preferences.test.ts` (next to `NavigationPreferences.svelte`)
- Modify: `apps/desktop/src/lib/components/PreferencesModal.svelte` (section after Connection), `apps/desktop/src/lib/stores/app.svelte.ts` (`PreferencesSection` gains `"clusters"`)
- Modify: `apps/desktop/tests/e2e/tauri-mock.ts`; Create: `apps/desktop/tests/e2e/environment-labels.spec.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 3 store, `environmentLabel`, toast action.

**Behaviour (spec §5.1, §5.2, §3.3, §6):**
- Top bar chip: after the version, `ui/Chip` neutral with the label when set; nothing when not set.
- Chip menu: after "Reconnect", a separator and a submenu "Environment" (bits-ui `DropdownMenu.Sub`) with radio items: "Detect from name (<detected label or Not set>)", Development, Test, Staging, Production, Not set. The checked item is the current setting (detected → the first item). Choosing calls `setEnvironment`.
- Choosing Production by hand offers no lock in this PR (read-only does not exist yet); PR 2 adds the toast and the Preferences line of spec §3.3.
- Rail tooltip: `"<name> · <Label>"` when set (keep the existing `source` suffix rule).
- Preferences → Clusters: heading "Clusters"; table with columns Context, Environment; one row per context in rail order; Environment is a native `<select>` styled as the other Preferences selects, options as the submenu, the detected option reading "<Label> (detected)" or "Not set (detected)". Below, a collapsed disclosure "Environment names" with one labelled text field per environment (comma-separated), saved on blur through `setVariants`; the error text shown under the field (`role="alert"` not needed, use `aria-describedby`); "Reset to defaults" restores spec §3.2 values. The Access column and the switches of §6.3 come in PR 2.
- The section re-renders from `clusters.contexts`; a vanished context's row disappears (Review Focus 5).

- [ ] **Step 1: Write the failing tests:**
  - TopBar: chip shows "Production" for a production context, nothing for not set; the submenu lists the six items with the right one checked; choosing Test calls `setClusterEnvironment("<ctx>", { source: "manual", value: "test" })`; "Detect from name" sends `{ source: "detected" }`.
  - ClusterRail: tooltip `"aks-prod-01-emm · Production"`.
  - ClustersPreferences: rows for each context; detected option text; changing the select calls the store; variants blur saves; duplicate error shown under the Production field and the field keeps the user's text; Reset to defaults sends the defaults; removing a context from `clusters.contexts` removes its row (Review Focus 5).
  - E2E `environment-labels.spec.ts` (import `test, expect` from `./fixtures`): mock contexts `aks-prod-01-emm`, `minikube`; chip reads Production; set `minikube` to Development from the menu → chip updates; Preferences → Clusters shows both rows; keyboard: open the chip menu, reach Environment, choose with Enter. Run in both themes (the existing theme toggle helper if any, else `emulateMedia({ colorScheme })`), plus forced colours for the chip.
  - Mock: `tauri-mock.ts` handles the three commands with an in-memory copy of the Rust behaviour (detection can call a small TS port or a fixed table for the mock contexts) and emits `cluster-settings-changed`.
- [ ] **Step 2: Run** `pnpm --filter desktop test -- TopBar ClusterRail ClustersPreferences` — Expected: FAIL.
- [ ] **Step 3: Implement** the behaviour above. CHANGELOG under Unreleased `### Added`: "Environment labels for clusters: detected from the context name (dev, test, staging, prod and their variants) or set by hand, shown on the active cluster and in Preferences → Clusters (#662)."
- [ ] **Step 4: Run** full `scripts/gates.sh` — Expected: every gate PASS (design lint included).
- [ ] **Step 5: Commit** `feat(desktop): show and set a cluster's environment (#662)`.
