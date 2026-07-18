# Logs Parity & Performance — Design

**Date:** 2026-07-18
**Issue:** [#316](https://github.com/massimilianolapuma/cubelite/issues/316)
**Delivery:** two independent PRs — `feat/desktop-logs-filters-316` (desktop) and `feat/macos-aggregated-logs-316` (native), both off `main`.

## Context

Batch C of the parity effort. Desktop has an aggregated Logs view that freezes the UI under log flood and offers no namespace/label filtering; native has no aggregated view at all (only the per-pod docked panel).

## Part D — Desktop

### D1. Freeze fix (`src/lib/stores/logs.svelte.ts`)

Root causes found: `push()` reallocates the whole `$state` array per incoming line; the auto-scroll `$effect` forces a filtered recompute + layout read per line; the buffer churns even while paused.

Design:
- Incoming `log-line` events append to a **non-reactive pending queue** (plain array, bounded at `BUFFER_CAP`).
- A **flush interval (~120 ms)** moves the queue into `lines` with a single reassignment (`[...lines, ...queue].slice(-BUFFER_CAP)`). No timer runs while the queue is empty.
- While paused (`following === false`) the queue still accumulates (bounded) but **no flush happens** — zero reactive churn; `bufferedWhilePaused` mirrors the queue length. Resuming flushes immediately.
- Lines get a monotonic `id` at enqueue time; the `{#each}` keys by `line.id` instead of index.
- Auto-scroll effect now fires at most once per flush (unchanged code, batched trigger).

No virtualization: with a 180-line cap and batched updates the DOM cost is bounded; virtualization is YAGNI here (revisit only if cap grows).

### D2. Filters (`LogsView.svelte` + store)

- **Namespace:** already scoped by the global namespace dropdown (restarts the stream); documented, no new UI.
- **Label selector:** new text input in the Logs toolbar accepting equality selectors (`app=api,tier=web`). The pod set passed to `logs.start()` becomes `resources.pods` filtered by the selector (pods already carry `labels` on the frontend). Changing the selector restarts the stream **debounced 300 ms**. Invalid/partial input = no match restriction until it parses.
- Selector parsing/matching: pure helper `matchesLabelSelector(labels, selector)` in `$lib` (reuse `k8s-match.ts` if it already covers it), unit-tested.
- Existing level chips and text filter unchanged. Streamed-pod count shown next to the input ("streaming 8/20 pods") so the 20-pod backend cap is visible.

### D3. Rust: no changes (labels already serialized on `PodInfo`; `MAX_LOG_PODS=20` cap stays).

### Tests (vitest)
- Store batching: fake timers — N pushes → single `lines` update per flush; paused → no update, counter grows; resume → flush.
- Selector matcher: equality lists, whitespace, empty selector = match-all, unparseable tokens ignored.

## Part M — macOS native

### M1. Pod labels

`PodInfo` gains `var labels: [String: String]?` (post-construction, like nodeName); `K8sPod.toPodInfo()` copies `metadata?.labels`. Needed for label filtering.

### M2. Label selector matcher

`Models/LabelSelectorMatcher.swift`: parses `"k=v, k2=v2"` → requirements; `matches(_ labels:)` = subset test. Empty/whitespace selector matches all; malformed tokens (no `=`) are ignored. Unit-tested.

### M3. Aggregated log store

`Models/AggregatedLogStore.swift` — `@Observable @MainActor final class`, injected `streamer: any PodLogStreaming` (same seam as `LogSession`):
- `start(pods: [PodInfo], context: String?)`: caps at **20 pods** (desktop parity), spawns one task per pod running `streamPodLogs` (tail 50, `timestamps` on) with a simple retry-on-end loop (exponential backoff, 30 s cap, cancellation-aware — same shape as `LogSession.followWithReconnect`).
- Merged ring buffer (cap **2000**) of `AggregatedLogLine { id: Int (store-global), pod: String, namespace: String, line: LogLine }` — global IDs avoid the per-session collision.
- UI state: `levelFilter` (all/info/warn/error), `textFilter`, `isFollowing` + `pausedAtCount` marker (buffer keeps appending; the view stops auto-scrolling), `filtered` computed, `clear()`, `stop()` cancels all tasks.
- Restart semantics: `start` is idempotent per (pods set, context) — callers stop first.

### M4. Aggregated Logs screen

- `ResourceType.logs = "Logs"`, `systemImage: "text.alignleft"`; new sidebar section **Observe** (`DesignTokens.accentAltTeal` dot) with `[.logs]`.
- `Views/AggregatedLogsView.swift`, wired as `case .logs` in the `resourceBrowserView` switch (keeps the context/namespace breadcrumb):
  - Toolbar: label-selector field, level chips, text search, follow/pause with "N new" pill, clear.
  - Pod set = `clusterState.pods` filtered by `LabelSelectorMatcher`; stream restarts on namespace change (via `sidebarSelection`) and on debounced selector edits (300 ms).
  - Body: `ScrollViewReader` + `LazyVStack` rows (time, level chip, pod name, message) reusing `LogLine.parse` level inference; autoscroll while following; "waiting for log lines…" empty state.
- Owned by `MainView` as `@State`, stopped in `.onDisappear` of the view and when leaving the `.logs` selection.

### Tests (XCTest)
- `LabelSelectorMatcherTests`: parse/match matrix.
- `AggregatedLogStoreTests` with a mock `PodLogStreaming` (pattern from `LogSessionStoreTests`): lines from two pods merge with global IDs and pod attribution; 20-pod cap; level/text filtering; clear; stop cancels.
- `PodInfo` labels mapping test.

## Non-goals

Reconnect banners/tabs/export in the aggregated native view (per-pod panel already has them); pod metrics; desktop per-pod viewer (#295); merged all-containers stream (#297); pop-out window (#298); set-based label selectors (`in`, `!=`).
