# Desktop: pod shell (exec) and manifest edit/apply — design

Date: 2026-11-02 · Owner: desktop-agent (+ core-agent) · Status: approved 2026-11-02 (A: line-based, B: first container, C: all six kinds)

## 1. Intent

The native macOS app can open a shell in a pod and edit/apply a manifest;
the desktop app cannot. This closes the last functional parity gap
(see the parity memory: "desktop manca exec-in-pod e apply-manifest").
Reference behaviour: `apps/macos/.../Views/PodExecView.swift` and
`Views/Shell/ManifestSheetView.swift`.

## 2. Goals, non-goals, anti-goals

Goals
- **Shell**: from the pod drawer, open a shell session in the pod and run
  commands, with stdout/stderr streamed back.
- **Edit & apply**: from the YAML modal, switch to an edit mode, change the
  manifest and apply it to the cluster, with errors (conflicts, validation)
  shown inline.

Non-goals
- No `kubectl apply -f` of arbitrary new manifests (create); only editing an
  existing resource, like the native app.
- No multi-container picker in the first version (first container, like
  native) — see §6 decision B.
- No YAML schema validation or autocompletion in the editor.

Anti-goals
- Never apply without an explicit Apply click; Cancel discards the draft.
- No silent overwrite of someone else's change: the resourceVersion in the
  draft is sent, so a concurrent edit fails with a conflict message.
- No new colours or font sizes outside the design tokens (design-lint at 0).

## 3. Shell (exec)

### 3.1 Core (`crates/cubelite-core`)
- New `exec.rs`: `start_exec(client, namespace, pod, container: Option<String>,
  command: Vec<String>, tty: bool) -> ExecSession` on kube's `Api::<Pod>::exec`
  (`ws` feature already enabled). `ExecSession` exposes a stdin writer, an
  output stream of `ExecChunk { channel: Stdout | Stderr | Status, text }`
  and a terminate handle; the status channel's final `Status` is mapped to an
  exit message.
- Default command: `["/bin/sh"]`, like native.

### 3.2 Tauri (`apps/desktop/src-tauri`)
- `start_exec(kubeconfig_path, namespace, pod, container?, context?) -> id`,
  emitting `exec-output:{id}` (`{ channel, text }`) and `exec-end:{id}`;
  `exec_send(id, data)` writes stdin; `stop_exec(id)` aborts. Sessions are
  held in an `ExecState` map like `LogState` / port-forward.

### 3.3 UI
- Pod drawer footer: new **Shell** button (lucide `Terminal`), between Logs and
  YAML.
- Opens a `ShellModal` (the existing `Modal`, 720px): header
  `{pod} — shell`, scrollback on `bg-surface-sunken` in `type-log` (input
  echo in accent, stdout `text-text-log`, stderr `status-err`, status lines
  `text-text-tertiary`), scrollback capped at 1000 lines, autoscroll to the
  bottom; input row `$ [command]`, Enter sends the line + `\n`.
- First line: `connected — line-based shell (/bin/sh, no TTY)`; on end:
  `session closed`; on failure: the error inline, input disabled.
- Closing the modal stops the session.

## 4. Edit & apply

### 4.1 Core
- `apply_resource_yaml(resource_type, namespace, name, yaml) -> Result<(), _>`:
  parse the YAML into the typed object (`Pod`, `Deployment`, `Service`,
  `ConfigMap`, `Secret`, `Ingress`), reject when kind/name/namespace do not
  match the target, then `Api::replace` (PUT, `kubectl replace` semantics,
  like native). The resourceVersion in the draft gives optimistic
  concurrency; a 409 maps to "The resource changed since you opened it.
  Reload and edit again."

### 4.2 Tauri
- `apply_resource_yaml(kubeconfig_path, resource_type, namespace, name, yaml,
  context?)`.

### 4.3 UI (`YamlModal.svelte`)
- Header actions: **Edit** next to Copy (all six kinds the modal supports;
  today the modal opens from the pod and deployment drawers).
- Edit mode: the `<pre>` becomes a monospace `<textarea>` (same chrome,
  `type-log`, tab inserts two spaces), buttons **Cancel** / **Apply**
  (`Applying…` while in flight).
- No local YAML parse: the desktop has no YAML package, so the core
  validates (mapping, kind/name/namespace) and the reason is shown inline.
- On success: close the modal; the resource watch refreshes the drawer. On error:
  message inline above the editor in `status-err`, draft kept.

## 5. Tests

- Rust: YAML→object validation (kind/name/namespace mismatch, invalid YAML),
  conflict error mapping; exec chunk decoding (channel routing, status →
  exit message) on fixtures.
- vitest: `ShellModal` (connect line, output routing/colours, Enter sends,
  close stops), `YamlModal` edit mode (Edit/Cancel, Apply calls the command,
  inline error keeps the draft, success closes).
- Playwright: open Shell from the pod drawer against the mocked Tauri layer;
  YAML edit → apply round trip.

## 6. Decisions for the user

A. **Shell model.** Line-based without TTY (parity with native, simple, no
   new dependency; no `vi`/`top`/tab completion) **or** a real terminal
   (`xterm.js` + TTY, resize, colours; one new frontend dependency, more
   work, and it would then exceed the native app).
   Recommendation: line-based now (parity), real terminal as a later issue
   for both apps.

B. **Container picker.** Native uses the first container. Recommendation:
   same now; picker later for both apps.

C. **Editable kinds.** Native edits pods and deployments only. The desktop
   YAML modal shows six kinds. Recommendation: all six (same code path).

## 7. Delivery

Two issues and two PRs, in this order: edit & apply (smaller, reuses the
YAML modal), then shell.
