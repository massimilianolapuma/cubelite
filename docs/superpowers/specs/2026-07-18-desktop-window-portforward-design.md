# Desktop Window Drag & Port-Forward — Design

**Date:** 2026-07-18
**Issues:** [#317](https://github.com/massimilianolapuma/cubelite/issues/317) (window not movable), [#318](https://github.com/massimilianolapuma/cubelite/issues/318) (port-forward parity)
**Delivery:** two PRs off `main` — `fix/desktop-window-drag-317`, `feat/desktop-port-forward-318`.

## Part W — Window drag (#317)

### Findings
`Titlebar.svelte` already carries `data-tauri-drag-region` on the header, the cluster block, and a `flex-1` filler — layout is correct. The capability file grants only `core:default`. Tauri's injected drag-region handler is known-unreliable with `titleBarStyle: "Overlay"` on macOS, and the user reports the window cannot be dragged at all.

### Design
Belt-and-braces, independent of the injected handler:
- **Explicit `onmousedown` fallback** on the header calling `getCurrentWindow().startDragging()`; double-click (`event.detail === 2`) calls `toggleMaximize()` to preserve native titlebar behavior.
- Guard: primary button only, and never when the press lands on an interactive element — pure helper `isDragSurface(target: Element | null): boolean` in `src/lib/window-drag.ts` returning false for `closest('button, input, select, textarea, a, [role="menu"], [data-no-drag]')`. Unit-tested (jsdom).
- **Capabilities**: add `core:window:allow-start-dragging` and `core:window:allow-toggle-maximize` explicitly so the fallback cannot be denied regardless of what `core:default` bundles.
- Keep the `data-tauri-drag-region` attributes.

## Part P — Port-forward (#318)

Desktop has none. macOS has per-connection relays over the port-forward WebSocket. Desktop uses kube-rs, which ships a native portforward API — no hand-rolled WS protocol.

### Rust (`crates/cubelite-core/src/portforward.rs` + commands)
- Add the `ws` feature to the workspace `kube` dependency (required for `Api::portforward`).
- `pub async fn forward_pod_port(client, namespace, pod, local_port, remote_port) -> Result<(u16, JoinHandle<()>), PortForwardError>`:
  1. Bind `tokio::net::TcpListener` on `127.0.0.1:local_port` — **`local_port == 0` auto-assigns**; the actual bound port is returned. Bind errors (port in use) surface synchronously to the caller.
  2. Spawn an accept loop: each TCP connection opens its own `Api::<Pod>::portforward(pod, &[remote_port])`, takes the stream for `remote_port`, and `tokio::io::copy_bidirectional`s until either side closes (per-connection forwarder, macOS parity).
- Tauri commands (`commands/kubernetes.rs`, registered in `lib.rs`): `start_port_forward(kubeconfig_path, context, namespace, pod, local_port, remote_port) -> { id, local_port }` and `stop_port_forward(id)` (aborts the accept-loop task). Session registry `PortForwardState(Mutex<HashMap<String, JoinHandle>>)`, managed like `LogState`. Stale sessions die with the process; the frontend store is the source of truth for the UI.
- Testable without a cluster: binding is separated into `bind_local(local_port)` — unit tests cover auto-assign (port 0 → nonzero) and port-in-use (double bind → error).

### Frontend
- `src/lib/ports.ts`: `parsePort(text): number | null` (trimmed integer 1–65535) and `resolveLocalPort(text, remote): number | null` — empty → mirror remote, `"0"` or `"auto"` → 0 (backend auto-assigns), else `parsePort`. Unit-tested. Semantics mirror the macOS `PortForwardInput` helper plus the auto option.
- `src/lib/stores/portforward.svelte.ts`: `sessions = $state<ForwardSession[]>([])` (`{ id, namespace, pod, localPort, remotePort }`), `start(...)` (invokes backend, records returned port, toasts errors — e.g. "address already in use"), `stop(id)`, `stopAll()` on cluster switch, `sessionsFor(namespace, pod)`.
- UI: new "Port forward" section in `PodDrawer.svelte` — remote input (default 80), local input (placeholder `auto`), Forward button disabled while invalid with inline error, session rows `localhost:N → M` + Stop. Ports rendered as plain text (no locale grouping — the macOS "6.789" lesson).
- Cluster switch calls `portforward.stopAll()` (wired where the logs stream is reset).

## Non-goals
Service/deployment port-forward targets, persistence of sessions across restarts, UDP, per-session traffic stats, macOS-side changes.
