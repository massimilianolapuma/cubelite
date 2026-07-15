# Pod Log Viewer — Design Spec

**Issues:** #294 (macOS), #295 (desktop parity) · **Milestone:** v0.4.0 — UX iteration
**Design handoff:** `cubelite-design/design_handoff_pod_log_viewer` (hi-fi HTML prototypes + README; Design System v1 tokens, no new tokens). This spec is the implementation contract; the handoff README is the visual/interaction source of truth.

## Summary

Replace the 640×420 modal log sheet with a **persistent bottom log panel with session tabs** inside the app shell (IDE-console pattern), spanning the main content column above the statusbar. One design, implemented twice: macOS (Swift 6 + SwiftUI) first, then desktop (Tauri v2 + Svelte 5 + Tailwind v4) for parity.

**Placement rationale (from handoff):** identical on macOS/Windows/Linux, no OS window-management divergence, satisfies the hard acceptance criterion "logs remain accessible while navigating other resources". Rejected: per-pod OS windows, logs-as-detail-tab. The quick-peek sheet is retired. Pop-out to OS window is post-v1, additive only.

## Feature set

- **Session tabs**: one tab per open pod log session (status dot · pod name · container name · close). Opening logs creates or focuses the tab. Per-session state: container, previous toggle, follow/pausedAt, scroll, ring buffer (cap 5000).
- **Container picker**: grouped menu — containers (with status/restarts), init containers, separator, "all containers" (merged stream — separate follow-up issue). Last choice remembered per pod (`@AppStorage` / localStorage).
- **Previous instance**: `⟲` chip shown only when the selected container has restarts > 0; static fetch, no follow. Mirrored in the overflow menu.
- **Search** (⌘F/Ctrl+F): live case-insensitive substring, highlight (active match = solid warn bg), match count n/N, ↵/⇧↵ nav with wrap, filter chip hides non-matching lines, esc clears. Must stay fluid at 5k lines → precompute match indices off the render path, debounce.
- **Tail/history**: tail chip (100/500/1000/5000, default 500) + "load 500 earlier" link/menu item; loading history pauses follow.
- **Toggles** (overflow ⋯ menu): timestamps, wrap, previous instance; export visible…/full buffer…; clear buffer.
- **Follow/pause**: prominent button (● Following / ● Paused). Autoscroll only while following; wheel-up pauses; resuming scrolls to bottom; navigating to a match pauses. "↓ N new lines" pill when paused and stream advances (click → resume).
- **Export**: visible (filtered) or full buffer to `~/Downloads/<pod>_<container>[_full].log`, confirmation toast.
- **States**: reconnecting banner (attempt count, next retry, retry-now), empty, no-matches, cleared.
- **Panel chrome**: default height 280px, drag-resize 160–560px, collapse to 34px tab strip (⌘L or chevron).
- **Entry points**: `logs ⏎` chip on selected pod row, Logs button in redesigned pod detail card, command palette action.
- **Line anatomy**: timestamp col (94px, hidden by toggle) · severity tag (INFO/DEBUG/WARN/ERROR) · message; ERROR/WARN row tints; merged view adds an identity-colored source column (follow-up).

All visual values (colors, sizes, fonts, motion) come from the handoff README §"Screens / Views" and Design System v1 tokens. Glyphs: SF Symbols (macOS) / Lucide 1.5px (desktop).

## Architecture (macOS)

New components:

- **`LogSessionStore`** (`@Observable`, app-scoped): open sessions (key = `namespace/pod`), active session, panel height/collapsed, global toggles (timestamps, wrap, tail size). Persists per-pod container choice, panel height, toggles via `@AppStorage`.
- **`LogSession`**: per-tab state — pod, chosen container, previous, follow/pausedAt, ring buffer (cap 5000), scroll anchor, stream `Task`.
- **`LogPanelView`** + subviews (`LogTabStrip`, `LogToolbar`, `LogBodyView`, `LogLineRow`): mounted at the bottom of the main column in `MainView`, above the statusbar.
- **`LogSearchModel`**: query, precomputed match indices (debounced, off render path), match cursor, filter mode.

Service layer (`KubeAPIService`):

- Extend `streamPodLogs` with `container`, `previous`, `tailLines` (exists), `sinceTime`; keep `timestamps=true` always on the wire — the timestamps toggle is render-only (timestamp already parsed per line).
- New `fetchPodContainers(namespace:pod:)`: containers + initContainers from spec, statuses (state, restarts) from status — feeds picker and `⟲` chip.
- Previous logs: static (non-follow) fetch reusing the same query builder.
- Log query building is a pure, unit-testable function (Sonar duplication gate: extend `openLineStream`, do not duplicate).

The existing `PodLogsView` sheet (164 lines) is removed once the panel core lands; its severity parsing (`LogLine.parse`) moves to the new module.

## Delivery plan — stacked PRs under #294

| PR | Scope |
|----|-------|
| A — service | `streamPodLogs` params, `fetchPodContainers`, previous fetch, pure query builder + unit tests |
| B — panel core | `LogSessionStore` (single session), panel + toolbar + body + line anatomy, follow/pause/autoscroll, tail + load-more, empty/cleared states, retire sheet |
| C — search | ⌘F, highlight, n/N nav, filter mode, 5k-line performance |
| D — session tabs | multi-pod tabs, per-pod container memory, drag-resize/collapse ⌘L, new-lines pill |
| E — entry points + export | pod detail card redesign (handoff §2), `logs ⏎` row chip, palette action, export + toast |
| F — resilience | reconnecting banner, stream retry with backoff |

Follow-up issues (filed separately, not in #294):

- Merged "all containers" stream (identity colors, interleaving) — macOS + desktop.
- Pop-out to OS window (post-v1).

#295 (desktop) replays the same decomposition on Tauri/Svelte after #294, reusing this spec.

## Testing

- **Unit**: log query builder, ring buffer semantics, search matcher (indices, filter, wrap nav), `LogSessionStore` transitions (open/focus/close, follow/pause, container switch).
- **UI/E2E** (existing harness): open panel → navigate other resources → panel persists; container switch swaps stream; search narrows 5k buffer without stalls.
- **Acceptance criteria** (#294/#295): logs visible while navigating; picker covers init + sidecar with per-pod memory; live search with highlight/count/nav/filter fluid at 5k; previous/timestamps/wrap toggles; tail default 500 + load-more; export visible/full; autoscroll only while following, wheel-up pauses.
