# Desktop Pop-out Log Window — Design Spec

**Issue:** #298 (desktop half; macOS half shipped in PR #348)
**Parent spec:** `docs/superpowers/specs/2026-08-19-log-popout-window-design.md` — fixes the semantics this spec implements on Tauri: move + re-attach, full toolbar parity, one window per session, detached state not persisted.

## Summary

Detach a log session from the desktop bottom panel into its own OS window via `⧉` in the toolbar. Unlike macOS (shared in-process store), a Tauri `WebviewWindow` is a separate JS context: the pop-out window runs its **own** `LogSession` with its own streams, seeded by a one-shot state transfer from the main window. Re-attach reverses the transfer. No continuous data bridge — two handoff events plus coordination events.

Stream continuity comes free from the existing reconnect mechanism: the pop-out (and the panel on re-attach) opens streams with `sinceTime` = the last transferred line's timestamp, exactly as `ContainerStream` already does on reconnect — no duplicate lines, no gap.

## Decisions

| Question | Decision |
|----------|----------|
| Architecture | Autonomous window + one-shot handoff (own streams, seeded ring). Rejected: main-as-stream-proxy (continuous bridge, fragile lifecycles); Rust-side shared buffer (restructures the whole JS log layer). |
| Session cap | Detached sessions live outside the panel's `SESSION_CAP` (6, LRU). Detach frees a panel slot; re-attach into a full panel LRU-evicts like `openFor`. |
| Window close | = re-attach (any path: X button, ⌘W, `⏷`). |
| Cluster switch / quit | Main broadcasts close-all; windows close without re-attach. |
| Pop-out crash / kill | Session state lost (lines no longer in main) — accepted cost of the autonomous model; pod reopenable from the panel. |
| Toggles (timestamps/wrap) | `persisted()` reads shared localStorage at window load; runtime divergence between windows accepted. |

## Window bootstrap & routing

- Detach creates `new WebviewWindow("logs-<slug>", { url: "index.html?logWindow=<key>", title: "<pod> — logs", width: 900, height: 500 })` where `key = namespace/pod` and slug replaces `/` with `-` (Tauri labels disallow `/`).
- `+page.svelte`: when the `logWindow` query param is present, mount only `LogWindowShell` — no sidebar, no cluster fetching, no `LogPanel`.
- `src-tauri/capabilities/default.json`: `"windows": ["main", "logs-*"]` so log windows get the same permissions.

## Handoff protocol (Tauri events, JSON payloads)

| Event | Direction | Payload / purpose |
|-------|-----------|-------------------|
| `log-window-ready:<key>` | pop-out → main | Shell mounted; main may now seed. |
| `log-window-seed:<key>` | main → pop-out (`emitTo(label)`) | `SessionTransfer` (below). |
| `log-window-reattach` | pop-out → main | Same `SessionTransfer`; main recreates the panel tab, window closes. |
| `log-window-close-all` | main → all log windows | Close without re-attach (cluster switch, app quit). |

```ts
type SessionTransfer = {
  key: string;              // "namespace/pod"
  namespace: string;
  pod: string;
  container: string | null; // incl. ALL_CONTAINERS sentinel
  previous: boolean;
  tailLines: number;
  following: boolean;
  lines: KeyedLogLine[];    // full ring, ≤ 5000 lines (~1MB JSON, one shot)
  kubeconfigPath: string;
  activeCluster: string | null;
};
```

Detach ordering: spawn window → `ready` → `seed` → `logPanel.closeSession(key)` in main, immediately after the emit. The pop-out opens its streams in parallel with that close, so a millisecond-scale overlap of two live streams for the same pod can occur — harmless: the streams have distinct ids and the seeded `sinceTime` dedupes the lines.

## Store changes

- **`LogSession`** — accepts an optional seed (lines + settings): the ring is pre-populated before `open()`; `open()` skips the buffer reset when seeded and passes the initial `sinceTime` (last seeded line's timestamp) to its streams.
- **`logPanel`** (module singleton — which is *per-window*, each JS context gets its own) — new `openSeeded(transfer: SessionTransfer)`: creates a seeded session and focuses it. Used by the pop-out at bootstrap and by main on re-attach. Re-attach into a full panel LRU-evicts exactly like `openFor`.
- **`logWindows.svelte.ts`** (new, main window only) — registry of open log windows:
  - `detach(key)`: serialize session → spawn window → await ready → seed → close local session
  - `has(key)` / focus helper: `openFor` on an already-detached pod calls `getWebviewWindow(label).setFocus()` instead of opening a tab
  - listener for `log-window-reattach` → `logPanel.openSeeded(...)`
  - `closeAll()`: broadcast `log-window-close-all`
- **Pop-out app state** — `app.kubeconfigPath` / `app.activeCluster` are set from the seed payload; the pop-out never runs the full app boot.

## UI / reuse

- **`LogWindowShell.svelte`** (new): minimal header (status dot · pod · container · `⏷` re-attach) above the existing `LogToolbar` + `LogBody`. Those components stay untouched: they work against the window-local `logPanel` singleton, so search, toggles, container picker, export and toasts all work as-is.
- **`⧉` detach button** in `LogToolbar` (Lucide icon, macOS parity), new prop `detached: boolean` (default `false`); the shell passes `true`, hiding `⧉` (the header's `⏷` replaces it).
- Entry points need no changes beyond `openFor`'s focus-detached-window branch (they all route through `logPanel.openFor` / the store).

## Lifecycle & edge cases

- **Window closed by any path** (X, ⌘W): `onCloseRequested` → prevent default → serialize → emit `log-window-reattach` → destroy window. `⏷` runs the same flow.
- **Cluster switch** (`logPanel.closeAll` in main): `logWindows.closeAll()` broadcasts first; pop-outs close without re-attach.
- **Main window close**: main's `onCloseRequested` broadcasts close-all, then exits the app — no orphan log windows without a shell.
- **Pod dies while detached**: streams go error/reconnecting with the standard banner — same behavior as the panel; the window stays open.
- **Detach of an already-detached pod**: impossible by construction (`⧉` exists only on panel tabs; the tab is gone).
- **Re-attach race with close-all**: a window that already received close-all closes without emitting re-attach (flag checked in the close handler).

## Testing

- **Unit (vitest)**: `LogSession` seeding (ring pre-populated, initial `sinceTime`, no reset on seeded open); `logPanel.openSeeded` (create / focus / LRU-evict when full); `SessionTransfer` serialization round-trip; `logWindows.detach` orchestration with mocked Tauri window/event APIs (existing mock pattern in `tauri.test.ts`).
- **E2E**: Playwright harness does not drive multiple Tauri webviews — gate is unit tests plus a manual smoke checklist mirroring the macOS one (detach continuity, close = re-attach, multi-window, export toast, cluster switch closes windows, main close exits).
