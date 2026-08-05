# Desktop Pod Log Viewer — Design Addendum

**Issue:** #295 (desktop parity) · **Milestone:** v0.4.0 — UX iteration
**Parent spec:** `2026-07-15-pod-log-viewer-design.md` — the UX contract (feature set, line anatomy, states, acceptance criteria) applies unchanged. This addendum maps it onto Tauri v2 + Svelte 5 + Tailwind v4 and records desktop-only decisions.

## Context

The macOS panel shipped via the #294 stack. On desktop, the Rust side is already
complete and unused by any UI:

- `stream_pod_log` Tauri command (container, previous, tail_lines, since_time;
  emits `pod-log-line:{id}` per line and a final `pod-log-end:{id}`)
- `get_pod_containers` (containers + init containers with state and restarts)
- `stop_logs` teardown; TS bindings for all three exist in `src/lib/tauri.ts`

The aggregated `LogsView` (label/level filtering) is unrelated to this work and
stays as is. #295 is therefore frontend-only except for one new `export_log`
command.

## State layer

`src/lib/stores/`:

- **`logPanel.svelte.ts`** (`LogPanelStore`, app-scoped class, Svelte 5
  runes): sessions keyed `namespace/pod`, capped at 6 open sessions and
  LRU-evicted (oldest-focused first) beyond that, active session key, panel
  height / collapsed, global toggles (timestamps, wrap, tail size). Toggles,
  panel height, and per-pod container choice persist to `localStorage`.
- **`logSession.svelte.ts`** (`LogSession`): pod ref, container list, chosen
  container, previous flag, follow / pausedAt, ring buffer (`logRing.svelte.ts`,
  cap 5000, `totalAppended` counter for the new-lines pill), stream id,
  reconnect state, event unlisteners.
- **Stream lifecycle**: `streamPodLog()` → listen `pod-log-line:{id}` /
  `pod-log-end:{id}`. On end while following: reconnect with exponential
  backoff (1 s doubling to 30 s cap), `since_time` = timestamp of last received
  line so the resumed stream doesn't duplicate. `pod-log-end` after a
  previous-instance fetch does not reconnect (previous is a static fetch).
  Batched flush into the ring buffer reuses the 120 ms pattern from
  `logs.svelte.ts`.
- **`logSearch.svelte.ts`**: same contract as macOS `LogSearchModel` — query,
  match ids precomputed off the render path with 150 ms debounce, n/N cursor
  with wrap, filter mode.

## Components

`src/lib/components/logpanel/`:

- **`LogPanel.svelte`** — chrome: default height 280 px, drag-resize 160–560 px,
  collapse to 34 px tab strip (⌘L / Ctrl+L). Mounted in `routes/+page.svelte`
  at the bottom of the `<main>` column, above `StatusBar`.
- **`LogTabStrip.svelte`** — one tab per session: status dot · pod ·
  container · close.
- **`LogToolbar.svelte`** — grouped container picker (containers with
  status/restarts, init containers; no "all containers" entry — that is #297),
  search input, tail chip (100/500/1000/5000, default 500), `⟲` previous chip
  (visible only when selected container restarts > 0), ● Following/Paused
  button, overflow ⋯ (timestamps, wrap, export visible/full, clear).
  Deviation: the previous-instance toggle exists only as that toolbar chip —
  it is not mirrored in the overflow menu.
- **`LogBody.svelte`** — virtualized list via **`@tanstack/svelte-virtual`**
  (first virtualization dependency in the repo; `measureElement` handles
  variable row heights when wrap is on). Autoscroll only while following;
  wheel-up pauses; resume scrolls to bottom; "↓ N new lines" pill while paused.
- **`LogLineRow.svelte`** — 94 px timestamp column (toggle is render-only;
  timestamps always requested on the wire), severity tag, ERROR/WARN row tints
  per Design System v1 tokens, Lucide 1.5 px glyphs.

Entry points: `logs ⏎` chip on the selected `PodsView` row, Logs button in the
pod detail card, command palette action.

## Export

New `export_log` Tauri command mirroring macOS `LogExporter`: receives lines +
filename, writes `~/Downloads/<pod>_<container>[_full].log`, frontend shows a
confirmation toast. A dedicated command avoids adding the fs/dialog plugins and
broad filesystem permissions.

## Error handling

- Stream start failure → in-session error banner with retry.
- Server drop while following → reconnecting banner (attempt count, next retry
  countdown, retry-now), backoff as above.

## Delivery — stacked PRs

| PR | Branch | Scope |
|----|--------|-------|
| 1 | `feat/desktop-logpanel-core` | session store (single session), panel + toolbar + body + line anatomy, tanstack virtualization, follow/pause/autoscroll, tail + load-earlier, container picker, previous, empty/cleared states, start-failure banner, PodDrawer "Log panel" button (bootstrap entry) |
| 2 | `feat/desktop-logpanel-search` | ⌘F, highlight, n/N nav, filter mode, 5k-line performance validation |
| 3 | `feat/desktop-logpanel-tabs` | multi-pod tabs, per-pod container memory, drag-resize/collapse ⌘L, new-lines pill |
| 4 | `feat/desktop-logpanel-entry-export` | entry points (row chip, palette), `export_log` + toast, reconnecting banner |

## Testing

- **Unit (vitest)**: store transitions (open/focus/close, follow/pause,
  container switch), reconnect backoff with fake timers, ring buffer semantics,
  search matcher (indices, filter, wrap nav), `streamPodLog` parameter
  mapping.
- **Component**: panel render, follow/pause interaction, new-lines pill.
- **E2E (Playwright)**: open panel → navigate other resources → panel
  persists. Container switch and the 5k-line search performance check are
  covered instead by unit/component tests (`logSession.svelte.test.ts`,
  `logSearch.svelte.test.ts`), not e2e.
- **Acceptance**: criteria of the parent spec §Testing applied to the desktop
  app.
