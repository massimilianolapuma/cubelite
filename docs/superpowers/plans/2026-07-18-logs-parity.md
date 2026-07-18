# Logs Parity & Performance Implementation Plan (#316)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the desktop Logs UI freeze, add label filtering to desktop logs, and build the aggregated multi-pod Logs screen on macOS native.

**Architecture:** Desktop: batch `log-line` events through a non-reactive queue flushed on an interval; filter the streamed pod set by a parsed equality label selector (client-side, labels already present). Native: new `AggregatedLogStore` fanning out `PodLogStreaming.streamPodLogs` per pod into one global-ID ring buffer, surfaced by a new `Logs` sidebar entry and `AggregatedLogsView`.

**Tech Stack:** Svelte 5 runes + vitest; Swift 5 / SwiftUI + XCTest.

## Global Constraints

- Two branches off `main`: `feat/desktop-logs-filters-316` (Tasks D1–D2, includes docs), `feat/macos-aggregated-logs-316` (Tasks M1–M4). Two PRs, both referencing #316.
- macOS working tree carries uncommitted #309 wiretap hunks in `Services/KubeAPIService.swift` + ATS `Info.plist` — never stage them (no task touches those files in batch C).
- Desktop tests: `pnpm --dir apps/desktop test` (vitest), typecheck `pnpm --dir apps/desktop typecheck`, lint `pnpm --dir apps/desktop lint`.
- macOS build/test: same xcodebuild commands as prior batches (`-derivedDataPath /tmp/cubelite-build`, `-skip-testing cubeliteUITests`).
- Commits: Conventional Commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task D1: Batched log store (freeze fix)

**Files:**
- Modify: `apps/desktop/src/lib/stores/logs.svelte.ts`
- Test: `apps/desktop/src/lib/stores/logs.svelte.test.ts` (create)

**Interfaces:**
- `LogsStore.push(line)` becomes enqueue-only; new private `#flush()` on a ~120 ms interval performs the single `$state` reassignment. Timer only runs while the queue is non-empty and `following` is true.
- Lines gain a store-assigned monotonic `id: number` (type `KeyedLogLine = LogLine & { id: number }`; `lines` becomes `KeyedLogLine[]`).
- Paused: queue accumulates bounded at `BUFFER_CAP`, `bufferedWhilePaused` mirrors queue length, no flush; `toggleFollow()` back to following flushes immediately.
- `filtered` unchanged in semantics.

- [ ] Step 1: failing vitest specs — with `vi.useFakeTimers()`: (a) 50 pushes → `lines` updates only after advancing the flush interval, single batch; (b) paused: pushes don't change `lines`, `bufferedWhilePaused` grows; resume flushes; (c) cap respected; (d) ids monotonic.
- [ ] Step 2: implement queue + interval flush.
- [ ] Step 3: `pnpm --dir apps/desktop test` green; `LogsView.svelte` keyed each `(line.id)`.
- [ ] Step 4: commit `fix(desktop): batch log-line events — no more UI freeze under flood (#316)`.

### Task D2: Label filter for desktop logs

**Files:**
- Modify: `apps/desktop/src/lib/k8s-match.ts` (+ `parseLabelSelector`)
- Modify: `apps/desktop/src/lib/components/views/LogsView.svelte` (selector input + pod-set filtering + debounce)
- Test: `apps/desktop/src/lib/k8s-match.test.ts` (extend)

**Interfaces:**
- `parseLabelSelector(text: string): Record<string, string>` — splits on commas, trims, keeps only `k=v` tokens (first `=`), ignores malformed; empty text → `{}`.
- LogsView: `let labelSelector = $state("")`; debounced (300 ms) `$effect` recomputes `pods = resources.pods.filter(p => sel none || matchesSelector(p.labels, sel))` and restarts `logs.start(pods)`. Header shows `streaming N/20 pods` when trimmed.

- [ ] Step 1: failing tests for `parseLabelSelector` (equality list, whitespace, malformed tokens ignored, empty → `{}`).
- [ ] Step 2: implement helper + UI input + debounce restart.
- [ ] Step 3: tests + typecheck + lint green.
- [ ] Step 4: commit `feat(desktop): label-selector filter for aggregated logs (#316)`; push; PR.

---

### Task M1: Pod labels + label selector matcher (native)

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Models/ResourceModels.swift` (`PodInfo.labels`, copy in `toPodInfo`)
- Create: `apps/macos/cubelite/cubelite/Models/LabelSelectorMatcher.swift`
- Test: `apps/macos/cubelite/cubeliteTests/LabelSelectorMatcherTests.swift` (includes labels-mapping test)

**Interfaces:**
- `PodInfo.labels: [String: String]?` (post-construction `var`).
- `struct LabelSelectorMatcher { init(_ text: String); let requirements: [String: String]; func matches(_ labels: [String: String]?) -> Bool }` — empty requirements match all; nil labels match only when requirements empty.

- [ ] TDD cycle; commit `feat(macos): pod labels + equality label-selector matcher (#316)`.

### Task M2: AggregatedLogStore

**Files:**
- Create: `apps/macos/cubelite/cubelite/Models/AggregatedLogStore.swift`
- Test: `apps/macos/cubelite/cubeliteTests/AggregatedLogStoreTests.swift` (mock `PodLogStreaming` per `LogSessionStoreTests` pattern)

**Interfaces:**
- `struct AggregatedLogLine: Identifiable, Sendable { let id: Int; let pod: String; let namespace: String; let line: LogLine }`
- `@Observable @MainActor final class AggregatedLogStore`:
  - `init(streamer: any PodLogStreaming, backoffBase: Double = 2)`
  - `func start(pods: [PodInfo], context: String?)` — stops first; caps at `maxPods = 20`; one task per pod: `streamPodLogs(tail 50)` loop with backoff (cap 30 s) on end/error, cancellation-aware.
  - `private(set) var buffer: [AggregatedLogLine]` ring (cap 2000), `totalAppended: Int`
  - `var levelFilter: LogLine.Level?`, `var textFilter: String`, `var isFollowing: Bool`, `private(set) var pausedAtCount: Int?`
  - `var filtered: [AggregatedLogLine]` (level + case-insensitive text over pod+message)
  - `var newSincePause: Int`, `func clear()`, `func stop()`, `private(set) var streamedPodCount: Int`

- [ ] TDD cycle (merge with global IDs + pod attribution, cap 20 pods, filters, clear, stop cancels); commit `feat(macos): aggregated multi-pod log store (#316)`.

### Task M3: Sidebar entry + AggregatedLogsView

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Models/ClusterState.swift` (`ResourceType.logs = "Logs"`, `systemImage "text.alignleft"`)
- Modify: `apps/macos/cubelite/cubelite/Views/Shell/UnifiedSidebarView.swift` (Observe section)
- Modify: `apps/macos/cubelite/cubelite/Views/MainView+DetailArea.swift` (`case .logs` in both switches)
- Modify: `apps/macos/cubelite/cubelite/Views/MainView.swift` (`@State var aggregatedLogStore` init with `kubeAPIService`)
- Create: `apps/macos/cubelite/cubelite/Views/AggregatedLogsView.swift`

**Interfaces:**
- `AggregatedLogsView(store: AggregatedLogStore, pods: [PodInfo], context: String?)` — internally filters `pods` by its `@State labelSelector` (300 ms debounce via `.task(id:)`), calls `store.start` on appear/pod-set change, `store.stop()` on disappear.
- Toolbar: selector `TextField`, level chips (All/Info/Warn/Error), search field, follow toggle + "N new" pill, Clear, `streaming N/20 pods` caption.
- Body: `ScrollViewReader` + `LazyVStack` of rows (time, level, pod, message) keyed by `AggregatedLogLine.id`; autoscroll on `totalAppended` while following.

- [ ] Implement, build, run `MainViewStateTests`; commit `feat(macos): aggregated Logs screen under new Observe section (#316)`.

### Task M4: Verification + PR

- [ ] Full macOS unit suite green; no #309 hunks in commits; push; PR `feat(macos): aggregated log viewer with label filtering (#316)`.

## Self-review notes

- Desktop `LogLine` from backend has no `id`: the store assigns it at enqueue (`KeyedLogLine`), so the Rust payload is untouched.
- Native `LogLine.parse(raw, id:)` requires an id: `AggregatedLogStore` passes its global counter, so per-session collision never arises.
- `matchesSelector` (desktop) returns false for empty selector by design — the view must gate on `Object.keys(sel).length === 0` → match all, mirroring the native matcher's empty-matches-all.
