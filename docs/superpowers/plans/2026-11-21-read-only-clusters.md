# Read-only clusters Implementation Plan (#662, PR 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a cluster (kubeconfig context) can be read-only, held and enforced by the backend:
Production starts read-only, it can be made writable for 5 min / 15 min / 1 h or always after an
optional confirmation, and every write control shows why it is off.

**Architecture:** the access state joins the environment label in `cluster-access.json`
(`commands/cluster_access.rs`, from PR 1). A new `commands/write_guard.rs` wraps the handler built
by `generate_handler!`: it reads each invoke's command name and `context` argument, classifies the
command from one table, and rejects a write to a read-only context before the command runs. Timed
unlocks live in memory with wall-clock ends; one 1 s ticker ends them and notices file changes made
by another instance, emitting the existing `cluster-settings-changed` event. The desktop store
from PR 1 gains access, the unlock flow and a lock reason that every write control reads.

**Tech Stack:** Rust, Tauri 2.12 (`Invoke`, `InvokeMessage::command/payload/webview`,
`InvokeResolver::reject`), Svelte 5 runes, bits-ui DropdownMenu, `@lucide/svelte` (`Lock`,
`LockOpen`, `Timer`), Vitest, Playwright with the Tauri mock.

**Spec:** `docs/superpowers/specs/2026-11-20-read-only-clusters-design.md` — this PR covers §3.3
(lock offer), §4, §5 (all but the environment parts done in PR 1), §6.1–6.3 (Access column and
switches), §7 for access, §8 for the same, §9 item 2. PR 1 (#681, merged) is the base: read its
`cluster_access.rs`, `stores/cluster-settings.svelte.ts`, `TopBar.svelte`, `ClusterRail.svelte`,
`ClustersPreferences.svelte` before starting.

## Global Constraints

- Blocked when read-only (spec §4.1, verbatim): `apply_resource_yaml`, `delete_pod`,
  `restart_deployment`, `scale_deployment`, `apply_resources` (dry run included),
  `clear_resources_override`, `start_exec`, `exec_send` (by its session's context). Everything
  else passes: `stop_exec`, the three port-forwards, every read/list/watch/log, Secret and
  ConfigMap reveal/copy/export, integrations, `set_context`, the cluster-settings commands.
- A write with no context, or a `context` that is not a string, is refused.
- Refusal payload: `{ "kind": "read_only", "context": "<name>", "message": "<name> is read-only. Make it writable from the cluster menu." }`;
  no context: `{ "kind": "no_context", "message": "No cluster was named for this change." }`.
  The frontend matches `kind`, never the text.
- States: read-only · writable until T (memory only, ends at T by the wall clock or when the app
  quits) · writable. Read-only and writable are saved; a timed unlock never is.
- First sight (a record missing, or a PR 1 record with no `access`): read-only when the context's
  current label is in `read_only_from_start` (default `["production"]`), writable otherwise;
  recorded at once. The guard does first sight itself. A label change never changes access.
- Durations: 5, 15, 60 minutes, or always. Choosing a duration again restarts it from now.
- Confirmation (spec §5.3 copy, verbatim): title "Make <name> writable?"; "<Label> · for <15 minutes>"
  (no label → just "for 15 minutes"); "Actions in CubeLite will change this cluster: apply, delete, restart, scale, resources, shell.";
  timed: "It goes back to read-only after <15 minutes> or when CubeLite quits."; always: "It stays writable until you make it read-only.";
  checkbox "Don't ask again"; buttons Cancel and "Make writable" (`tonal`); focus starts on Cancel;
  Esc cancels. Making read-only never asks. Duration words: "5 minutes", "15 minutes", "1 hour".
- Disabled write control: stays in place, `aria-disabled="true"` (never native `disabled`), a
  press does nothing and calls no backend command, `title` and accessible description
  "<name> is read-only".
- Colours: Tonal roles only; environment chip stays neutral; "Writable · 12 min" is
  `on-warning-container` on `warning-container`; read-only marks are `text-muted`. Design lint
  must pass.
- Shell at the end of an unlock: stays open, one terminal line "<name> is read-only again. Input is off.",
  input disabled with the reason, closing works.
- No `unwrap()`/`expect()` outside tests. No new crate or npm dependency.
- Branch `feat/662-read-only-clusters` (from `main` after #681). Before each commit: `scripts/gates.sh --rust --no-e2e`
  for Rust tasks, `scripts/gates.sh --no-e2e` for desktop tasks; full `scripts/gates.sh --rust` before
  the last commit. Never push.

## Review Focus

1. A write invoke whose `context` is missing, `null`, a number or an object, or whose payload is
   not JSON — refused with `no_context`, never a panic, never passed through. (Task 2)
2. The settings file deleted, or made unreadable, by hand or by another instance while the app
   runs — a read-only context stays read-only at the next write (memory is kept). (Task 2)
3. A duration that is not 5, 15 or 60 (`0`, `7`, `-5`, `"forever"`) — refused with an error, no
   unlock. (Task 1)
4. A scale held in the 800 ms debounce when the unlock ends — the refusal shows as readable text
   (not JSON) and the stepper goes back to the replicas the cluster has. (Task 5)
5. A shell that ends by itself (exit, pod gone) — its context entry is removed; an `exec_send`
   for an unknown session passes the guard and gets the command's own "The shell session has
   ended." (Task 2)

Each item has its test in the task named, marked "Review Focus n".

---

## File map

| File | Responsibility |
|---|---|
| `apps/desktop/src-tauri/src/commands/cluster_access.rs` | access field, preferences, first sight, timed unlocks, clock, `tick`, new commands, view |
| `apps/desktop/src-tauri/src/commands/write_guard.rs` (new) | command table, payload reading, guard, wrapped handler, exec session contexts |
| `apps/desktop/src-tauri/src/commands/kubernetes.rs` | `start_exec`/`stop_exec`/session end keep the exec context map |
| `apps/desktop/src-tauri/src/commands/mod.rs`, `src/lib.rs` | module, managed state, wrapped handler, ticker, new commands |
| `apps/desktop/src/lib/tauri.ts`, `src/lib/errors.ts` | types, wrappers, refusal object |
| `apps/desktop/src/lib/stores/cluster-settings.svelte.ts`, `stores/clock.svelte.ts` (new), `stores/toasts.svelte.ts` | access state, unlock flow, lock reason, one app clock, toast action |
| `apps/desktop/src/lib/components/ui/Button.svelte`, `ui/Toaster.svelte` | `blockedReason`, toast action |
| `apps/desktop/src/lib/components/shell/{TopBar,ClusterRail}.svelte`, `shell/AccessMenuItems.svelte` (new), `UnlockDialog.svelte` (new), `ClustersPreferences.svelte` | chip, badge, menu, confirmation, Preferences |
| `apps/desktop/src/lib/components/ReadOnlyNotice.svelte` (new) + the controls of spec §5.4 | drawer line, disabled controls |
| `apps/desktop/tests/e2e/tauri-mock.ts`, `tests/e2e/read-only-clusters.spec.ts` (new), `CHANGELOG.md` | mock, e2e, changelog |

---

### Task 1: Access state in the settings file (Tauri)

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/cluster_access.rs` (tests in-module)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register the new commands; start the ticker)

**Interfaces:**
- Consumes: PR 1's `SettingsFile`, `ContextRecord`, `Inner::refresh/save/view`, `with_fresh`.
- Produces:
  - `#[serde(rename_all = "snake_case")] pub enum Access { ReadOnly, Writable }`.
  - `ContextRecord` gains `access: Option<Access>` (lenient: unknown/bad value → `None`, i.e. first
    sight again; moved out of `extra`).
  - `SettingsFile` gains `confirm_unlock: bool` (default `true`) and
    `read_only_from_start: BTreeSet<Environment>` (default `{Production}`), both lenient (bad value →
    default, unknown environment strings skipped).
  - `#[serde(untagged)] pub enum UnlockFor { Minutes(u32), Always }` parsed from JSON `5 | 15 | 60 | "always"`;
    any other value is an error `"5, 15 or 60 minutes, or always"` (Review Focus 3).
  - `ContextEnvironmentView` gains `access: &'static str` (`"read_only" | "writable"`, the effective
    one) and `writable_until: Option<u64>` (Unix ms, only while a timed unlock runs).
    `ClusterSettingsView` gains `confirm_unlock: bool`, `read_only_from_start: Vec<Environment>`.
  - Clock: `ClusterAccessState` holds `clock: Arc<dyn Fn() -> SystemTime + Send + Sync>`; `load`/`in_memory`
    use `SystemTime::now`; `#[cfg(test)] fn with_clock(self, clock) -> Self`.
  - `Inner` gains `unlocks: HashMap<String, SystemTime>` (never saved).
  - Methods on `ClusterAccessState`:
    - `fn first_sight(inner: &mut Inner, name: &str) -> bool` (private; sets `access` from the
      current label and `read_only_from_start`; returns whether it changed the file). `settings()`
      runs it for every name before answering (one save).
    - `pub fn write_allowed(&self, context: &str) -> bool` — refresh from disk, first sight (saving),
      then: saved `Writable` → true; saved `ReadOnly` → true only while `unlocks[context] > now`;
      an ended unlock is removed here.
    - `pub fn make_writable(&self, context: &str, how: UnlockFor) -> Result<ClusterSettingsView, String>` —
      `Always`: save `Writable`, drop the unlock. `Minutes(m)`: save `ReadOnly`, unlock until now + m.
    - `pub fn make_read_only(&self, context: &str) -> Result<ClusterSettingsView, String>` — save `ReadOnly`, drop the unlock.
    - `pub fn set_access_preferences(&self, confirm_unlock: Option<bool>, read_only_from_start: Option<Vec<Environment>>) -> Result<ClusterSettingsView, String>`
      (answers the view with no contexts).
    - `pub fn tick(&self) -> bool` — removes ended unlocks and reads the file again if its stamp
      changed; true when either happened.
  - Commands (`Result<_, String>`, each emits `CLUSTER_SETTINGS_CHANGED` on success):
    `make_cluster_writable(context: String, duration: UnlockFor)`, `make_cluster_read_only(context: String)`,
    `set_cluster_access_preferences(confirm_unlock: Option<bool>, read_only_from_start: Option<Vec<Environment>>)`.
  - Ticker in `lib.rs` setup: `tauri::async_runtime::spawn` a loop, `tokio::time::interval(1 s)`;
    when `tick()` is true, emit `CLUSTER_SETTINGS_CHANGED`. The end is compared by wall clock in
    `tick`, so a late tick after sleep still ends the unlock at once.

- [ ] **Step 1: Write the failing tests** in `cluster_access.rs`:
  - `first_sight_production_read_only_others_writable`: `settings(["aks-prod-01-emm","aks-test-01-emm","minikube"])` → read_only, writable, writable; saved to disk.
  - `pr1_record_without_access_is_first_sight`: file from PR 1 (`{"version":1,"contexts":{"aks-prod-01-emm":{"environment":{"source":"detected"}}}}`) → read_only after `settings`.
  - `vanished_context_keeps_its_record`: make `minikube` read-only, `settings(["aks-test-01-emm"])`, then `settings(["minikube"])` → still read_only.
  - `label_change_never_changes_access`: `aks-prod-01-emm` read-only; set it Manual Test → still read_only; `kub3-dev` writable, set Manual Production → still writable.
  - `read_only_from_start_applies_to_new_contexts_only`: set `{Test}`; existing `aks-test-01-emm` stays writable; new `qa-02` becomes read_only.
  - `timed_unlock_ends_by_clock`: clock at t; `make_writable(prod, Minutes(5))` → view `writable` with `writable_until` = t+5 min; `write_allowed` true at t+4m59s, false at t+5m; `tick` at t+5m returns true and the view is read_only again.
  - `duration_again_restarts`: 15 min at t, 5 min at t+10m → ends at t+15m.
  - `timed_unlock_is_not_saved`: after `make_writable(Minutes(15))`, a fresh `load` of the same path → read_only.
  - `always_is_saved`: `make_writable(Always)`, fresh load → writable.
  - `make_read_only_drops_unlock`.
  - `bad_duration_refused` (Review Focus 3): `serde_json::from_value::<UnlockFor>` of `0`, `7`, `-5`, `"forever"`, `null` → Err; `5`, `15`, `60`, `"always"` → Ok.
  - `preferences_round_trip_and_lenient`: defaults `confirm_unlock: true`, `[production]`; set and reload; `"read_only_from_start": ["production","nope"]` → `{Production}`; `"confirm_unlock": "yes"` → `true`.
  - `other_instance_change_seen_at_next_write`: two states on one path; A writable `x`; B `make_read_only(x)`; A `write_allowed(x)` → false; A `tick()` → true.
- [ ] **Step 2: Run** `cargo test -p cubelite-desktop cluster_access` — Expected: FAIL (new items missing).
- [ ] **Step 3: Implement** the interfaces; register the three commands in `generate_handler!`; start the ticker.
- [ ] **Step 4: Run** `scripts/gates.sh --rust --no-e2e` — Expected: every gate PASS.
- [ ] **Step 5: Commit** `feat(desktop): read-only state and timed unlocks for each cluster (#662)`.

---

### Task 2: The write guard (Tauri)

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/write_guard.rs` (tests in-module)
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/src/commands/kubernetes.rs` (`start_exec`, `stop_exec`, the forward task's removal)

**Interfaces:**
- Consumes: Task 1 `ClusterAccessState::write_allowed`.
- Produces:
  - `pub enum Kind { Read, Write, WriteBySession }`; `pub const COMMANDS: &[(&str, Kind)]` — every
    command in `generate_handler!`, the writes as in Global Constraints, `exec_send` as `WriteBySession`.
  - `#[derive(Default)] pub struct ExecContexts(std::sync::Mutex<HashMap<String, String>>)` (session id → context), managed;
    `insert(id, context)`, `remove(id)`, `get(id) -> Option<String>`. `start_exec` inserts after the
    session is in `ExecState` (its `context` is `Some`: the guard refused `None`); `stop_exec` and the
    forward task's end remove it (Review Focus 5).
  - `#[derive(Serialize)] #[serde(tag = "kind", rename_all = "snake_case")] pub enum Refusal { ReadOnly { context: String, message: String }, NoContext { message: String } }`.
  - `pub fn check(command: &str, args: Option<&serde_json::Value>, access: &ClusterAccessState, exec: &ExecContexts) -> Result<(), Refusal>` —
    pure over its inputs. A command not in `COMMANDS` is treated as `Write` with no context (refused)
    so an unclassified command fails closed. `Write`: `args["context"]` must be a string, else
    `NoContext`. `WriteBySession`: `args["sessionId"]` → `exec.get`; unknown id → `Ok` (the command
    answers "The shell session has ended."). Then `access.write_allowed(ctx)` or `ReadOnly`.
  - `pub fn guarded<R: Runtime>(inner: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static` —
    reads `invoke.message.command()`, `payload()` (`InvokeBody::Json(v)` → `Some(&v)`, `Raw` → `None`),
    the two states via `invoke.message.webview().state::<…>()`; on `Err(r)` calls
    `invoke.resolver.reject(r)` and returns `true`; otherwise `inner(invoke)`.
  - `lib.rs`: `.manage(ExecContexts::default())`, `.invoke_handler(write_guard::guarded(tauri::generate_handler![…]))`.

- [ ] **Step 1: Write the failing tests** in `write_guard.rs` (state over a temp dir, clock injected as in Task 1):
  - `each_write_refused_when_read_only`: for each of the 7 `Write` commands, args `{"context":"aks-prod-01-emm"}` → `Refusal::ReadOnly`, serialised exactly as the Global Constraints JSON.
  - `each_write_allowed_when_writable` (same commands, `minikube`).
  - `reads_and_forwards_pass_on_read_only`: `list_pods`, `start_port_forward`, `kibana_port_forward`, `grafana_port_forward`, `reveal_secret_value`, `stop_exec`, `set_context` with a read-only context → Ok.
  - `bad_context_refused` (Review Focus 1): for `scale_deployment`, args `{}`, `{"context":null}`, `{"context":5}`, `{"context":{}}`, and `None` (raw body) → `NoContext`.
  - `unseen_context_goes_through_first_sight`: `aks-prod-02` never loaded → refused, and the file now records it read_only.
  - `exec_send_follows_its_session`: insert `s1 → minikube` (writable) → Ok; make `minikube` read-only → Refusal; `stop_exec` with `s1` → Ok.
  - `exec_send_unknown_session_passes` (Review Focus 5).
  - `file_removed_or_broken_keeps_read_only` (Review Focus 2): prod read-only; delete the file → still refused; write garbage to it → still refused.
  - `unclassified_command_fails_closed`: `check("no_such_command", Some(&json!({"context":"minikube"})), …)` → `NoContext`.
  - `table_matches_generate_handler`: read `include_str!("../lib.rs")`, take the identifiers between `generate_handler![` and the closing `]`, assert the set equals the names in `COMMANDS` (both directions, message names the missing one).
  - In `kubernetes.rs` tests or here: `exec_context_removed_when_session_ends` — drive the removal helper the forward task calls (extract `fn end_session(app, id)` if needed) and assert `ExecContexts::get` is `None` (Review Focus 5).
- [ ] **Step 2: Run** `cargo test -p cubelite-desktop write_guard` — Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces and wire `lib.rs`.
- [ ] **Step 4: Run** `scripts/gates.sh --rust --no-e2e` — Expected: every gate PASS.
- [ ] **Step 5: Commit** `feat(desktop): refuse writes to a read-only cluster in the backend (#662)`.

---

### Task 3: Desktop data: wrappers, errors, store, clock, toast action

**Files:**
- Modify: `apps/desktop/src/lib/tauri.ts`, `apps/desktop/src/lib/errors.ts` (+ its test), `apps/desktop/src/lib/stores/cluster-settings.svelte.ts` (+ test), `apps/desktop/src/lib/stores/toasts.svelte.ts` (+ test), `apps/desktop/src/lib/components/ui/Toaster.svelte`
- Create: `apps/desktop/src/lib/stores/clock.svelte.ts` (+ test)

**Interfaces:**
- Consumes: Task 1 commands and view; Task 2 refusal object.
- Produces:
  - `tauri.ts`: `ContextEnvironment` gains `access: "read_only" | "writable"`, `writable_until: number | null`;
    `ClusterSettings` gains `confirm_unlock: boolean`, `read_only_from_start: Environment[]`;
    `type UnlockFor = 5 | 15 | 60 | "always"`; `makeClusterWritable(context: string, duration: UnlockFor)`,
    `makeClusterReadOnly(context: string)`, `setClusterAccessPreferences(p: { confirmUnlock?: boolean; readOnlyFromStart?: Environment[] })`, each `Promise<ClusterSettings>`.
  - `errors.ts`: `errorMessage` returns `e.message` for an object with a string `message`;
    `export function isReadOnlyError(e: unknown): e is { kind: "read_only"; context: string; message: string }`.
  - `clock.svelte.ts`: `export const clock` with `now = $state(Date.now())`, `run(on: boolean)`
    (one 1 s interval for the app, started or stopped; idempotent). It imports nothing from the
    store: the store calls `clock.run(<any writable_until in byName>)` after every answer it applies.
  - Store additions: `confirmUnlock`, `readOnlyFromStart`; `accessOf(name): "read_only" | "writable" | "timed"`
    (timed while `writable_until > clock.now`, read_only once passed even before the backend event);
    `writableUntil(name): number | null`; `lockReason(name: string | null): string | null` →
    `"<name> is read-only"` when read-only, `null` otherwise (a null name → null);
    `pendingUnlock = $state<{ name: string; duration: UnlockFor } | null>(null)`;
    `requestUnlock(name, duration)` — sets `pendingUnlock` when `confirmUnlock`, else `confirmPendingUnlock` directly;
    `confirmPendingUnlock(dontAskAgain: boolean)`, `cancelPendingUnlock()`, `makeReadOnly(name)`,
    `setAccessPreferences(p)`. Every change applies the answer as `setEnvironment` does (seq rule).
  - `toasts.push(message, tone, action?: { label: string; run: () => void })`; `Toaster` renders the
    action as a `Button variant="text" size="inline"`, which runs it and dismisses the toast.
  - `setEnvironment(name, { source: "manual", value: "production" })` on a writable context returns
    `true` and the caller decides on the lock offer (Task 4); the store adds nothing.

- [ ] **Step 1: Write the failing tests:**
  - errors: `errorMessage({kind:"read_only",context:"p",message:"p is read-only. Make it writable from the cluster menu."})` → that text; `isReadOnlyError` true for it, false for `"text"`, `{kind:"no_context"}`, `null`.
  - store: `accessOf` per state; `timed becomes read_only when clock passes writable_until`; `lockReason` text and null; `requestUnlock with confirm on sets pendingUnlock and calls nothing`; `confirmPendingUnlock(true) sends makeClusterWritable then setClusterAccessPreferences({confirmUnlock:false})`; `requestUnlock with confirm off calls makeClusterWritable at once`; `cancelPendingUnlock clears`; `makeReadOnly calls makeClusterReadOnly`; refused change → error toast with readable text.
  - clock: ticks only while an unlock runs (fake timers; no interval with none).
  - toasts: action rendered, click runs it and dismisses.
- [ ] **Step 2: Run** `pnpm --filter desktop test -- errors cluster-settings clock toasts` — Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces.
- [ ] **Step 4: Run** `scripts/gates.sh --no-e2e` — Expected: every gate PASS.
- [ ] **Step 5: Commit** `feat(desktop): cluster access in the settings store (#662)`.

---

### Task 4: Chip, badge, menu, confirmation, Preferences

**Files:**
- Modify: `apps/desktop/src/lib/components/ui/Button.svelte` (+ `primitives.test.ts`)
- Modify: `apps/desktop/src/lib/components/shell/TopBar.svelte`, `.../shell/ClusterRail.svelte` (+ `shell.test.ts`)
- Create: `apps/desktop/src/lib/components/shell/AccessMenuItems.svelte` (the "Make writable for ▸ / Make read-only" items, reused by Task 5's notice), `apps/desktop/src/lib/components/UnlockDialog.svelte` (+ `unlock-dialog.test.ts`), mounted once next to the other app-level modals in `src/routes/+page.svelte`
- Modify: `apps/desktop/src/lib/components/ClustersPreferences.svelte` (+ `clusters-preferences.test.ts`)

**Interfaces:**
- Consumes: Task 3 store and toast action.
- Produces: `Button` prop `blockedReason?: string | null` — when set: `aria-disabled="true"`, `title={blockedReason}`,
  `aria-describedby` to a visually hidden span with the text, clicks ignored, drawn as disabled
  (same opacity as `disabled`), focusable. `AccessMenuItems` props `{ name: string }`, rendering
  bits-ui items for its parent `DropdownMenu.Content`.

**Behaviour (spec §5.1–5.3, §6.1–6.3, §3.3):**
- Rail: `Lock` badge (bottom right, `surface-container-top`, icon `text-muted`) when read-only; `Timer`
  badge in `warning` when timed; none when writable. Tooltip `"<name> · <Label> · Read-only"` /
  `"… · Writable for <n> min"`; label part omitted when not set.
- Chip: after the environment chip, read-only → `Lock` + "Read-only" `text-muted`; timed →
  `Timer` + "Writable · 12 min" (`on-warning-container` on `warning-container`), last minute in
  seconds ("Writable · 42 s"), driven by `clock.now`; writable → nothing.
- Menu: after the Environment submenu, a separator and `AccessMenuItems`: read-only or timed →
  submenu "Make writable for" with 5 minutes, 15 minutes, 1 hour, Always (each → `requestUnlock`);
  writable → item "Make read-only". Timed also shows "Make read-only" under the submenu.
- `UnlockDialog`: on `ui/Modal`, open while `pendingUnlock` is set, copy and focus as Global Constraints.
- Production by hand from the chip menu on a writable context: `toasts.push("Production clusters are usually read-only", "warn", { label: "Make read-only", run: () => clusterSettings.makeReadOnly(name) })`.
- Preferences: Access column (state text as the chip, with `Lock`; writable shows "Writable") and
  button ("Make writable ▾" as a small DropdownMenu with the four durations, or "Make read-only");
  under a row whose environment is Production by hand and access writable, the line
  "Production clusters are usually read-only · Make read-only" with the button. Below the table:
  `ui/Switch` "Ask before making a cluster writable" (`confirmUnlock`); "Read-only from the start"
  with four checkboxes (`readOnlyFromStart`).

- [ ] **Step 1: Write the failing tests:**
  - Button: with `blockedReason` → `aria-disabled="true"`, not `disabled`, `title`, description text reachable via `aria-describedby`, `onclick` not called, focusable with Tab.
  - Rail/chip: each of the three states (badge, text, tooltip); countdown "Writable · 12 min" then "Writable · 42 s" with fake timers.
  - Menu: read-only shows the four durations and no "Make read-only"; writable shows "Make read-only" only; choosing 15 minutes calls `requestUnlock(name, 15)`.
  - UnlockDialog: copy for timed and Always, focus on Cancel, Esc cancels, "Don't ask again" passes `true`.
  - Production by hand on writable → toast with "Make read-only"; its action calls `makeClusterReadOnly`; on read-only → no toast.
  - Preferences: Access column per state; durations button; Production-by-hand line; switch and checkboxes call `setAccessPreferences`.
- [ ] **Step 2: Run** `pnpm --filter desktop test -- primitives shell unlock-dialog clusters-preferences` — Expected: FAIL.
- [ ] **Step 3: Implement** the behaviour.
- [ ] **Step 4: Run** `scripts/gates.sh --no-e2e` — Expected: every gate PASS (design lint included).
- [ ] **Step 5: Commit** `feat(desktop): show and change a cluster's access (#662)`.

---

### Task 5: Disabled write controls, drawer notice, end of an unlock

**Files:**
- Create: `apps/desktop/src/lib/components/ReadOnlyNotice.svelte` (+ test)
- Modify: `pods/PodDrawer.svelte`, `deployments/DeploymentDrawer.svelte`, `DeploymentTable.svelte`, `deployments/ReplicaStepper.svelte`, `YamlModal.svelte`, `deployments/ResourceEditor.svelte`, `deployments/OverrideBanner.svelte`, `pods/ShellModal.svelte`, `views/PodsView.svelte`, `stores/mutations.svelte.ts` (and the tests next to each)

**Interfaces:**
- Consumes: Task 3 `lockReason`, `accessOf`; Task 4 `Button.blockedReason`, `AccessMenuItems`.
- Produces: `ReadOnlyNotice` props `{ name: string }` — renders nothing unless read-only; else
  `Lock` + "<name> is read-only" (`type-body-sm`, `text-muted`) and a "Make writable ▾" DropdownMenu with `AccessMenuItems`.

**Behaviour (spec §4.4, §5.4):** every control that calls a blocked command reads
`clusterSettings.lockReason(app.activeCluster)` (shell: the context captured at start) and passes it
as `blockedReason` (custom controls such as `ReplicaStepper` take the same prop and apply the same
four rules). The list: Delete, Restart, Shell, "Adjust on deployment" in `PodDrawer`; Restart in
the `DeploymentTable` row; Rollout Restart, Adjust and the stepper in `DeploymentDrawer`; the
stepper in the table; Edit and Apply in `YamlModal`; Review and Apply in `ResourceEditor`; Keep
these values / Remove mark / Restore in `OverrideBanner`; the delete from `PodsView`. `mutations`
returns `false` without calling the backend when `lockReason` is set. `ReadOnlyNotice` sits above
the actions of `PodDrawer` and `DeploymentDrawer`. Forward and YAML (read) stay enabled. When the
shell's context turns read-only, `ShellModal` writes the line once and disables input with the reason.
YamlModal keeps the draft text when Apply becomes disabled.

- [ ] **Step 1: Write the failing tests:**
  - For each control in the list: on a read-only context it has `aria-disabled="true"`, the description "<name> is read-only", and a click calls no `#lib/tauri.ts` write wrapper; on writable it calls it.
  - Forward and YAML (read) enabled on read-only.
  - ReadOnlyNotice: shown on read-only only; its menu offers the four durations.
  - ShellModal: open on a timed context; move the clock past the end → the line "minikube is read-only again. Input is off." appears once, input `aria-disabled`, Close works.
  - YamlModal: editing, unlock ends → draft kept, Apply disabled.
  - mutations (Review Focus 4): a scale pending in the debounce whose backend call rejects with the `read_only` object → toast text is the message, not JSON, and the stepper shows the cluster's replicas again.
- [ ] **Step 2: Run** `pnpm --filter desktop test -- PodDrawer DeploymentTable yaml-modal resource-editor shell-modal mutations ReadOnlyNotice` — Expected: FAIL.
- [ ] **Step 3: Implement** the behaviour.
- [ ] **Step 4: Run** `scripts/gates.sh --no-e2e` — Expected: every gate PASS.
- [ ] **Step 5: Commit** `feat(desktop): write controls of a read-only cluster stay visible and say why (#662)`.

---

### Task 6: Mock, end-to-end, changelog

**Files:**
- Modify: `apps/desktop/tests/e2e/tauri-mock.ts`
- Create: `apps/desktop/tests/e2e/read-only-clusters.spec.ts` (import `test, expect` from `./fixtures`)
- Modify: `CHANGELOG.md`

**Behaviour:** the mock keeps access per context (first sight as Task 1), the three new commands,
the view fields, and rejects the 8 blocked commands on a read-only context with the refusal object;
it emits `cluster-settings-changed` after each change.

- [ ] **Step 1: Write the e2e tests:** `aks-prod-01-emm` starts read-only, chip "Read-only", rail badge; the Deployment drawer's stepper is `aria-disabled` with its reason and the notice is shown; unlock 5 minutes from the chip menu → confirmation → Make writable → chip "Writable · 5 min", scale works; Make read-only → stepper disabled again; "Don't ask again" then a second unlock opens no dialog; keyboard: Tab to the disabled Restart, its accessible description is the reason; Preferences → Clusters shows the Access column and the switches; both themes, forced colours and `prefers-contrast: more` for chip, badge and notice (as `environment-labels.spec.ts` does).
- [ ] **Step 2: Run** `pnpm --filter desktop exec playwright test read-only-clusters` — Expected: FAIL, then implement the mock until PASS.
- [ ] **Step 3: CHANGELOG** under Unreleased `### Added`: "Read-only clusters: production clusters start read-only, enforced by the backend; make one writable for 5 minutes, 15 minutes, an hour or always from the cluster menu or Preferences → Clusters, with a confirmation you can turn off. Write controls stay visible and say why they are off (#662)."
- [ ] **Step 4: Run** full `scripts/gates.sh --rust` — Expected: every gate PASS.
- [ ] **Step 5: Commit** `test(desktop): read-only clusters end to end (#662)`.
