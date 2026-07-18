# Desktop Window Drag & Port-Forward Implementation Plan (#317, #318)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop window draggable again and bring port-forwarding to desktop (macOS parity).

**Architecture:** W: explicit `startDragging()` mousedown fallback in the Titlebar guarded by a pure `isDragSurface` helper, plus explicit window capabilities. P: kube-rs native portforward — per-connection forwarder behind a local `TcpListener` (0 = auto-assign) in `cubelite-core`, Tauri start/stop commands with a session registry, Svelte store + PodDrawer section with shared port validation.

**Tech Stack:** Svelte 5 + vitest; Rust (kube 0.97 + `ws` feature, tokio); Tauri v2.

## Global Constraints

- Branch `fix/desktop-window-drag-317` (Task W, includes docs), then `feat/desktop-port-forward-318` (Tasks P1–P3) off `main`.
- macOS wiretap files (#309) untouched — no macOS files in this batch.
- Verify: `pnpm --dir apps/desktop test` / `typecheck` / `lint`; Rust: `cargo test -p cubelite-core` and `cargo check -p desktop` (src-tauri package name per its Cargo.toml).
- Commits: Conventional Commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task W: Window drag fallback (#317)

**Files:**
- Create: `apps/desktop/src/lib/window-drag.ts` (+ test `window-drag.test.ts`)
- Modify: `apps/desktop/src/lib/components/shell/Titlebar.svelte` (mousedown handler)
- Modify: `apps/desktop/src-tauri/capabilities/default.json` (explicit permissions)

**Interfaces:**
- `isDragSurface(target: Element | null): boolean` — false when the element or an ancestor matches `button, input, select, textarea, a, [role="menu"], [data-no-drag]`.
- Titlebar `onmousedown`: primary button + `isDragSurface` → `event.detail === 2 ? toggleMaximize() : startDragging()` on `getCurrentWindow()`.
- Capabilities gain `core:window:allow-start-dragging`, `core:window:allow-toggle-maximize`.

- [ ] TDD on the helper; wire handler; tests+typecheck+lint green; commit `fix(desktop): explicit startDragging fallback — window draggable again (#317)`; push; PR.

### Task P1: Rust port-forward core

**Files:**
- Modify: `Cargo.toml` (workspace `kube` features += `"ws"`)
- Create: `crates/cubelite-core/src/portforward.rs`; register in `lib.rs`

**Interfaces:**
- `pub fn bind_local(local_port: u16) -> impl Future<Output = std::io::Result<tokio::net::TcpListener>>` — binds `127.0.0.1:local_port` (0 = ephemeral).
- `pub async fn forward_pod_port(client: kube::Client, namespace: String, pod: String, local_port: u16, remote_port: u16) -> Result<(u16, tokio::task::JoinHandle<()>), std::io::Error>` — binds first (errors propagate synchronously), returns actual port + the accept-loop handle; each accepted connection opens its own `Api::<Pod>::portforward` and `copy_bidirectional`s.

- [ ] Unit tests: `bind_local(0)` → nonzero port; double bind of the same port → `Err(AddrInUse)`. `cargo test -p cubelite-core` green. Commit `feat(core): kube-rs port-forward with local listener and auto-assign (#318)`.

### Task P2: Tauri commands + frontend store

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/kubernetes.rs` (`PortForwardState`, `start_port_forward`, `stop_port_forward`), `apps/desktop/src-tauri/src/lib.rs` (manage + handler)
- Create: `apps/desktop/src/lib/ports.ts` + `ports.test.ts`
- Create: `apps/desktop/src/lib/stores/portforward.svelte.ts` + test
- Modify: `apps/desktop/src/lib/tauri.ts` (wrappers + `ForwardStart` type)

**Interfaces:**
- Command `start_port_forward(kubeconfig_path, context: Option<String>, namespace, pod, local_port: u16, remote_port: u16) -> Result<ForwardStartResult { id: String, local_port: u16 }, String>`; `stop_port_forward(id: String)` aborts the handle.
- `parsePort(text): number | null` (1–65535); `resolveLocalPort(text, remote): number | null` — `""` → remote, `"0"`/`"auto"` → 0, else parsePort.
- Store: `sessions`, `start({namespace, pod, localPort, remotePort})` (toasts backend errors), `stop(id)`, `stopAll()`, `sessionsFor(namespace, pod)`.

- [ ] TDD on ports helper + store (mock invoke); `cargo check`; commit `feat(desktop): port-forward commands and session store (#318)`.

### Task P3: PodDrawer UI + wiring

**Files:**
- Modify: `apps/desktop/src/lib/components/pods/PodDrawer.svelte` (Port forward section)
- Modify: cluster-switch reset site (`stores/clusters.svelte.ts` `switchCluster`) → `portforward.stopAll()`

**Interfaces:** remote input (default "80"), local input (placeholder "auto"), Forward button (disabled invalid, inline error), session rows `localhost:N → M` (plain text) + Stop.

- [ ] Implement; tests+typecheck+lint green; commit `feat(desktop): port-forward UI in the pod drawer (#318)`; push; PR.
