# Read-only clusters and environment labels — design (#662)

Status: approved by the user, 2026-11-20.

## 1. Intent

The user keeps production and test clusters open side by side. One click in the wrong window
(Scale, Rollout Restart, an Apply) changes the wrong cluster. After this change:

- each cluster (kubeconfig context) carries an **environment label**: Development, Test, Staging,
  Production or not set, read from its name or chosen by hand;
- each cluster can be **read-only**: nothing done in CubeLite can change it. Production clusters
  start read-only;
- a read-only cluster can be made **writable for a while** (5 min, 15 min, 1 h) or **always**,
  after a confirmation the user can turn off.

The block is enforced by the backend, not only by the interface: one check that every write
command passes through, whatever the frontend does.

This is the user's own opt-in, so it blocks. It does not replace the warnings of the single actions
(the delete dialog, the resources review), which stay as they are.

## 2. Goals, non-goals, anti-goals

**Goals**

- An environment label per context, detected from the context name, settable by hand, visible on
  the active cluster.
- A read-only state per context, held and enforced by the backend, surviving a restart.
- Production contexts start read-only the first time CubeLite sees them.
- Timed unlock (5 min, 15 min, 1 h) and permanent unlock ("Always").
- A confirmation before unlocking, which the user can turn off in Preferences.
- Write controls of a read-only cluster stay visible, disabled, with the reason, reachable by
  keyboard and screen reader.
- A test that fails when a command is registered without saying whether it writes.

**Non-goals**

- Protecting against a malicious webview. The guard stops a bug or a forgotten check in the
  frontend, and the user's own mistakes; a compromised webview could still call the unlock command.
- Read-only per namespace or per resource kind.
- Labels other than the environment (team, region, owner).
- `set_context` writing `current-context` to the kubeconfig file: a local file, not the cluster,
  out of scope (see #662).
- A typed-name confirmation ("type the cluster name to unlock").

**Anti-goals** (would make this a failure even if it works)

- A write that reaches a read-only cluster through a path nobody remembered to check.
- Write controls that disappear: the user must see the action exists and why it is off.
- Guessing an environment from anything other than whole words of the name (`preprod` must not
  become Production, `devops` must not become Development).
- Unlocking that is so tedious the user turns read-only off for good.

## 3. Environment labels

### 3.1 Values

`development`, `test`, `staging`, `production`, or not set. Shown as Development, Test, Staging,
Production. Staging covers collaudo, UAT and pre-production.

### 3.2 Detection from the name

The context name is split into words on any character that is not a letter or a digit (`-`, `_`,
`.`, `:`, `/`, `@`, space). A word matches a variant when, ignoring case, it equals the variant or
the variant followed only by digits (`prod01`, `svil2`).

Default variants:

| Environment | Variants |
|---|---|
| Development | `dev`, `develop`, `development`, `svil`, `sviluppo` |
| Test | `test`, `tst`, `qa` |
| Staging | `stg`, `stage`, `staging`, `coll`, `collaudo`, `uat`, `preprod` |
| Production | `prod`, `prd`, `production`, `produzione` |

- The first word, left to right, that matches decides. A name with no matching word is not set.
- The variants are editable in Preferences (§6.4). Editing them re-detects every context whose
  label was detected, never one set by hand.
- Only the context name is read: not the cluster name, the server URL or the namespace.

With the user's kubeconfig of 2026-11-20:

| Context | Label | Read-only at first sight |
|---|---|---|
| `aks-prod-01-emm` | Production | yes |
| `aks-test-01-emm` | Test | no |
| `aks-svil-01-emm` | Development | no |
| `kub3-dev` | Development | no |
| `dol-lab-aks` | not set | no |
| `minikube` | not set | no |

### 3.3 Set by hand

From the active cluster's menu (§5.2) and from Preferences (§6.2): a choice of the four values, plus
"Detect from name" (back to detection) and "Not set". A label set by hand is kept until the user
changes it; detection never overwrites it.

Setting a context to Production by hand while it is writable offers to lock it. Nothing changes on
its own.

- In Preferences: one line under the choice, "Production clusters are usually read-only · Make
  read-only", with the button.
- From the top bar menu (which closes on the choice): a toast with the same text and a "Make
  read-only" action.

## 4. Read-only

### 4.1 What counts as a write

| Command | Blocked when read-only |
|---|---|
| `apply_resource_yaml` | yes |
| `delete_pod` (Delete and Restart pod) | yes |
| `restart_deployment` | yes |
| `scale_deployment` | yes |
| `apply_resources` (dry run included) | yes |
| `clear_resources_override` | yes |
| `start_exec` | yes |
| `exec_send` | yes (by the context of its session, §4.4) |
| `stop_exec` | no: closing a shell is always allowed |
| `start_port_forward`, `kibana_port_forward`, `grafana_port_forward` | no |
| every read, list, watch, log, Secret/ConfigMap reveal and copy | no |
| in-cluster Elasticsearch and Prometheus queries (implicit tunnels) | no |
| `set_context` (local kubeconfig file) | no |

A port-forward changes nothing in the cluster. A shell can change anything in a container, so it
is a write. `apply_resources` with `dry_run = true` is blocked too: it only serves the review step
of an edit that cannot be applied.

### 4.2 States

Per context, one of:

- **read-only**;
- **writable until T** (timed unlock): lasts until T or until the app quits, whichever first;
- **writable** (no block): the default for a context that is not protected, and the result of
  "Always".

A timed unlock is held in memory only: after a restart the context is read-only again. "Always"
and read-only are saved.

A timed unlock ends by the wall clock, not a monotonic clock: on macOS `Instant` stops while the
machine sleeps, and an unlock must not outlast a night's sleep.

### 4.3 First sight

The first time the backend sees a context name, it records it and sets it read-only if its label
is in the "read-only from the start" set (§6.3; default: Production only), writable otherwise.

The first launch after this ships sees every context for the first time: existing production
contexts become read-only then. A context that disappears from the kubeconfig keeps its record, so
it comes back with the same state.

The guard runs the first-sight check itself on a context it has not seen: a context added to the
kubeconfig while the app runs cannot be written before it has been recorded. A record written by
the first pull request (§9), with no access field, counts as first sight.

Changing the label later, by hand or by editing the variants, never changes read-only on its own
(§3.3).

### 4.4 When a timed unlock ends

The backend checks the time at every guarded command, so the block holds even if no one is told.
It also tells every window when an unlock ends, and the interface follows:

- **Open shell**: stays open, input is refused, one line is written in the terminal
  "aks-prod-01-emm is read-only again. Input is off." The input field is disabled with the same
  reason. Closing it works.
- **YAML being edited**: the text is kept (it can be copied), Apply is disabled with the reason.
- **Resources editor open**: Review and Apply are disabled with the reason.
- **Scale waiting on its 800 ms debounce**: the backend refuses it; the usual error appears.

### 4.5 The guard

- One place in the Tauri layer decides, for every invoked command, whether it writes. The
  preferred form wraps the handler built by `generate_handler!` in `lib.rs`: it reads the command
  name and its `context` argument from the invoke message and rejects a write to a read-only
  context before the command runs. If Tauri 2 makes that impractical, each write command calls the
  guard first, and the test of §8 checks it.
- A write command with no context (`context: None`, which today falls back to the kubeconfig's
  `current-context`) is refused. The frontend always sends one.
- Every registered command is in one table that says read or write. A command missing from the
  table fails a test.
- The refusal names the cause: `kind = "read_only"`, the context, and the message
  "aks-prod-01-emm is read-only. Make it writable from the cluster menu." The frontend recognises
  `kind`, not the text. Commands return `Result<_, String>` today, so `lib/errors.ts`
  (`errorMessage`) learns to read the message of this object instead of printing raw JSON.
- The context of each shell session is kept where the guard can read it synchronously (the
  invoke handler is synchronous, `ExecState` sits behind a tokio mutex): its own map behind a std
  mutex, filled at `start_exec`, emptied at `stop_exec`.
- **Two instances.** Nothing stops a second CubeLite process (no single-instance plugin; on
  Windows and Linux opening the app again starts one). So the guard reads the saved state from the
  file before every guarded command (cached by modification time), not only from memory: a cluster
  made read-only in one instance is read-only for the other at its next write. The file is
  watched so the other instance's interface follows. A timed unlock stays per process: it is in
  memory, so an unlock in one instance leaves the other read-only, the safe side. No
  single-instance plugin (my call: a visible behaviour change that this issue does not need).

## 5. What the user sees

All colours are Tonal roles (`design/README.md`); both themes follow from the roles. The
environment is a property of the cluster, not a state, so its chip is neutral: red, amber and green
stay for states. "Writable for a while" is a state the user should notice, so it uses `warning`.
Icons from `@lucide/svelte` (`Lock`, `LockOpen`, `Timer`).

### 5.1 Rail

```
 ┌────┐
 │ AP │  ← avatar of aks-prod-01-emm
 │  🔒│  ← lock badge, bottom right, on surface-container-top, icon text-muted
 └────┘
 ┌────┐
 │ AT │  ← aks-test-01-emm, writable: no badge
 └────┘
 ┌────┐
 │ AS │
 │  ⏱│  ← writable for a while: Timer badge, warning
 └────┘
```

- Read-only: `Lock` badge. Writable for a while: `Timer` badge in `warning`. Writable: nothing.
- The tooltip adds the label and the state: "aks-prod-01-emm · Production · Read-only".
- The rail gets no menu of its own (my call): the menu is on the top bar chip, for the active
  cluster, and every context is in Preferences.

### 5.2 Top bar chip and its menu

```
Read-only:
 ┌──────────────────────────────────────────────────────────────────┐
 │ ● aks-prod-01-emm  AKS  1.31   [Production]  🔒 Read-only      ▾ │
 └──────────────────────────────────────────────────────────────────┘

Writable for a while:
 ┌──────────────────────────────────────────────────────────────────┐
 │ ● aks-prod-01-emm  AKS  1.31   [Production]  ⏱ Writable · 12 min ▾│
 └──────────────────────────────────────────────────────────────────┘

Writable, label not set: nothing added
 ┌───────────────────────────────────┐
 │ ● minikube  1.33                ▾ │
 └───────────────────────────────────┘
```

- `[Production]`: `ui/Chip`, neutral (`surface-container-high`, `text-muted`), `type-micro`.
- "Read-only": `Lock` + text, `text-muted`. "Writable · 12 min": `Timer` + text, `on-warning-container`
  on `warning-container`; the minutes count down, last minute in seconds. "Writable" with "Always"
  shows nothing: it is the normal state of a writable cluster (my call).

The menu (bits-ui `DropdownMenu`, already there with Copy server address and Reconnect) gains:

```
 Copy server address
 Reconnect
 ─────────────────────────
 Environment            ▸   ● Detect from name (Production)
                              Development
                              Test
                              Staging
                              Production
                              Not set
 ─────────────────────────
 Make writable for      ▸     5 minutes
                              15 minutes
                              1 hour
                              Always
```

When writable: "Make read-only" in place of "Make writable for". When writable for a while also
"Extend" is not offered: "Make writable for" stays, and choosing a duration restarts the time from
now (my call: one control, no separate Extend).

### 5.3 Unlock confirmation

Shown after a duration is chosen, unless turned off in Preferences (§6.3). Built on `ui/Modal`.

```
 ┌────────────────────────────────────────────────────┐
 │ Make aks-prod-01-emm writable?                     │  type-headline
 │                                                    │
 │ Production · for 15 minutes                        │  type-body-sm
 │ Actions in CubeLite will change this cluster:      │
 │ apply, delete, restart, scale, resources, shell.   │
 │ It goes back to read-only after 15 minutes or      │
 │ when CubeLite quits.                               │
 │                                                    │
 │ ☐ Don't ask again                                  │
 │                                    [Cancel] [Make writable]
 └────────────────────────────────────────────────────┘
```

- With "Always" the last sentence is "It stays writable until you make it read-only."
- "Make writable" is `tonal`, not danger: the action is allowed, the user chose it. Focus starts on
  Cancel. Esc cancels.
- "Don't ask again" turns the confirmation off (the Preferences switch of §6.3).

Making a cluster read-only never asks.

### 5.4 Disabled write controls

Every control of §4.1's blocked commands, on a read-only cluster:

- stays where it is, drawn disabled, with `aria-disabled="true"` (not the native `disabled`, which
  removes it from the tab order and from hover);
- a press does nothing;
- its accessible description and its `title` are "aks-prod-01-emm is read-only";
- where the controls sit in a drawer (Pod, Deployment), one line above the actions says it once and
  offers the way out:

```
 ┌───────────────────────────────────────────────────────────────┐
 │ 🔒 aks-prod-01-emm is read-only            [Make writable ▾]  │  body-sm, text-muted
 ├───────────────────────────────────────────────────────────────┤
 │ [Logs] [YAML] [Shell] [Forward]  [Restart] [Delete]           │
 │                        ↑ shell, restart, delete: aria-disabled │
 └───────────────────────────────────────────────────────────────┘
```

  "Make writable ▾" opens the same durations as §5.2.

The controls: Delete and Restart in `PodDrawer`; Shell in `PodDrawer`; Restart in the
`DeploymentTable` row and Rollout Restart in `DeploymentDrawer`; `ReplicaStepper` (table and drawer);
Edit and Apply in `YamlModal`; Adjust in `DeploymentDrawer`, Adjust on deployment in `PodDrawer`,
Review and Apply in `ResourceEditor`, Keep these values / Remove mark / Restore in
`OverrideBanner`; the input of `ShellModal`; the delete from `PodsView` (through
`mutations.deletePod`). The rule holds for any control that calls a blocked command, listed here
or not. Forward and YAML (read) stay enabled.

`Button` gains the disabled-with-reason form (prop name left to the builder) so every control uses
one implementation.

## 6. Preferences

A new section **Clusters**, after Connection, reachable as a scroll target (`clusters`).

### 6.1 Layout

```
 Clusters
 ─────────────────────────────────────────────────────────────────────────
 CONTEXT              ENVIRONMENT                  ACCESS
 aks-prod-01-emm      [Production (detected)  ▾]   🔒 Read-only     [Make writable ▾]
 aks-svil-01-emm      [Development (detected) ▾]   Writable         [Make read-only]
 aks-test-01-emm      [Test (detected)        ▾]   Writable         [Make read-only]
 dol-lab-aks          [Not set                ▾]   Writable         [Make read-only]
 kub3-dev             [Development (detected) ▾]   Writable         [Make read-only]
 minikube             [Not set                ▾]   Writable         [Make read-only]

 Ask before making a cluster writable                               [ on  ]
 Read-only from the start   ☐ Development  ☐ Test  ☐ Staging  ☑ Production

 Environment names                                                  ▸ (collapsed)
   Development   dev, develop, development, svil, sviluppo
   Test          test, tst, qa
   Staging       stg, stage, staging, coll, collaudo, uat, preprod
   Production    prod, prd, production, produzione
                                                        [Reset to defaults]
```

### 6.2 Contexts table

One row per context of the loaded kubeconfig, sorted as the rail. The environment choice as §3.3.
Access as §4.2, with the same buttons as the top bar menu; the confirmation of §5.3 applies here
too.

### 6.3 Switches

- **Ask before making a cluster writable**: default on.
- **Read-only from the start**: which labels start read-only at first sight (§4.3). Default:
  Production. Changing it affects only contexts seen after the change.

### 6.4 Environment names

One text field per environment, comma-separated variants, letters and digits only. Saved on blur;
an empty or invalid word is dropped with a line under the field. A variant in two environments is
refused ("already in Staging"). Reset to defaults restores §3.2.

## 7. Backend

### 7.1 Where it lives

A new settings file written by the backend, `cluster-access.json` in the app config directory
(`app.path().app_config_dir()`), not `localStorage`: the guard must not depend on what the webview
says. Contents:

- per context name: `environment` (value or null), `environment_source` (`detected` | `manual`),
  `access` (`read_only` | `writable`);
- `confirm_unlock` (bool), `read_only_from_start` (set of environments), `variants` (map).

Timed unlocks are in memory (managed state), never in the file. Writes are atomic (temp file and
rename). An unreadable file is set aside (`cluster-access.json.bad`) and replaced by defaults,
with every context seen again for the first time, so production comes back read-only; the user is
told once with a toast.

Contexts are identified by name, as everywhere in the app (keychain, caches, identity colours).

### 7.2 Commands

Names left to the builder; what they do:

- **read the state**: per context of the current kubeconfig, label, its source, access (with the
  end time of a timed unlock), and the preferences of §6.3–6.4. Loading the contexts records the
  ones seen for the first time (§4.3) before answering.
- **set the environment** of a context (value, not set, or back to detection).
- **make writable** (duration or always) and **make read-only**.
- **set preferences** (confirm, read-only from the start, variants).
- Every change emits one event to all windows with the new state; the end of a timed unlock emits
  it too.

Detection (§3.2) is a pure function in the core crate (`crates/cubelite-core`), with its tests;
the settings file and the guard are in the Tauri crate.

### 7.3 Exec sessions

`ExecState` records the context of each session at `start_exec`; `exec_send` is checked against
it (§4.4).

## 8. Tests

- **Core**: detection: every default variant, case, digits after the variant, separators,
  `preprod` → Staging not Production, `devops` → not set, first matching word wins, the six names
  of §3.2.
- **Tauri**:
  - each blocked command of §4.1 refused on a read-only context with `kind = "read_only"`, and
    allowed when writable; port-forward and reads allowed on a read-only context;
  - a write with no context refused;
  - **every command registered in `generate_handler!` is in the read/write table** (fails when a
    new command is added without being classified);
  - timed unlock: allowed before the end, refused after (clock injected), event emitted;
  - a context made read-only by another process (file changed on disk) is refused at the next
    write;
  - a context never seen goes through first sight in the guard;
  - `exec_send` refused after the session's context becomes read-only, `stop_exec` allowed;
  - first sight: production read-only, others writable, a vanished context keeps its record;
  - settings file: round trip, atomic write, unreadable file set aside and defaults applied;
  - a label set by hand survives a change of variants.
- **Desktop unit**: the chip and badge in each state; the menu entries per state; the confirmation
  on and off ("Don't ask again" sets the preference); each control of §5.4 with
  `aria-disabled`, description, no call to the backend when pressed; the drawer line; shell input
  off after the unlock ends; the Preferences section (table, switches, variants validation).
- **E2E (Tauri mock)**: a production context starts read-only, Scale disabled with its reason;
  unlock for 5 minutes with confirmation, scale works; lock again; keyboard walk to a disabled
  control reads its reason; environment set by hand; both themes, forced colours and more
  contrast for the chip, badge and drawer line.

## 9. Delivery

Two pull requests to `main`:

1. **Environment labels** (`feat/662-environment-labels`): core detection, settings file and
   commands for labels and preferences of §6.4, top bar chip, rail tooltip, Preferences section
   with the environment column and names. No read-only yet.
2. **Read-only** (`feat/662-read-only-clusters`, closes #662): access state, first sight, guard and
   command table, timed unlock and events, confirmation, disabled controls, drawer line, badge,
   Preferences access column and switches.

The second depends on the first. Nothing in the first locks a cluster, so it can ship alone.

## 10. Calls made in this spec

Decided by the user on 2026-11-20:

- Turning read-only off asks for a confirmation, with a preference to turn the confirmation off.
- Timed unlock with a choice of duration, and "Always".
- Production starts read-only.
- An environment label per cluster, detected from the variants of the environment name in the
  context name; set by hand when the name has none.

Mine, to check:

1. **Four environments**: Development, Test, Staging (incl. collaudo, UAT, preprod), Production.
2. **Whole-word matching**, a variant optionally followed by digits; the context name only.
3. **Durations 5 min, 15 min, 1 h, Always**, chosen from a submenu each time; no default duration
   in Preferences (it replaces what I said in chat: with a submenu there is nothing to default).
4. **A timed unlock does not survive a restart**; "Always" does.
5. **Read-only from the start is a set of environments** in Preferences, default Production only.
6. **Changing a label never changes read-only on its own**; Production by hand offers to lock.
7. **Port-forward allowed, shell blocked**, dry-run of resources blocked.
8. **Open shell at the end of an unlock stays open with input off.**
9. **State in a backend settings file**, timed unlocks in memory; context identified by name.
10. **No rail menu**: the menu is on the top bar chip and in Preferences.
11. **Simple confirmation** (no typed name), "Make writable" tonal, focus on Cancel.
12. **Neutral environment chip**; `warning` only for "writable for a while"; nothing shown for
    writable-always.
13. **Choosing a duration again restarts the time**; no separate Extend.
14. **Two pull requests**, labels first.
15. **Two instances**: the guard reads the saved state from the file before every write; no
    single-instance plugin; a timed unlock is per process.
16. **Production by hand from the top bar**: a toast with "Make read-only".
17. **Wall-clock expiry** of timed unlocks.

## 11. Left to the builder

- Command names and the exact shape of the state answer.
- Whether the guard wraps the invoke handler or is called by each command (§4.5), and how the
  read/write table is checked against `generate_handler!`.
- The prop name of the disabled-with-reason `Button`.
- How the countdown in the chip is driven (one timer for the app, not one per control).
