# Pod Log Viewer — PR E (Entry Points + Export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export (visible/full buffer → `~/Downloads`, toast confirm), `logs ⏎` chip on the selected pod row, command-palette "Open pod logs" action, and the pod detail card's containers list + prominent Logs action per handoff §2.

**Architecture:** `LogExporter` is a pure, tested helper (filename + content + write-to-directory). Toast state lives on `LogSessionStore` (`toast: String?`, auto-clear). Entry points call `logSessionStore.open(pod:context:)` — chip in `PodListView`, palette item in `CommandPaletteView` (new callback), containers list loads async in `ResourceDetailView` via `fetchPodContainers`.

## Global Constraints

- Handoff §2 (pod detail card), §3 (row chip), export + toast per §Interactions. Scope fence: no reconnect banner (PR F).
- Export filename `<pod>_<container>[_full].log`; visible = filtered lines as rendered (search filter applied), full = whole ring buffer; raw text = timestamp + space + message per line when the line has a timestamp.
- Base branch: `feat/294-log-session-tabs` (stacked on PR D #302).
- Test command as in PR B plan.

---

### Task 1: `LogExporter` (pure + file write) — TDD

**Files:** Create `apps/macos/cubelite/cubelite/Models/LogExporter.swift`, test `apps/macos/cubelite/cubeliteTests/LogExporterTests.swift`.

**Interfaces:**
```swift
enum LogExporter {
    static func filename(pod: String, container: String?, full: Bool) -> String
    static func content(_ lines: [LogLine]) -> String        // "time message\n"… (time omitted when nil)
    @discardableResult
    static func write(_ lines: [LogLine], pod: String, container: String?, full: Bool,
                      directory: URL) throws -> URL
}
```

Tests: filename with/without container + full suffix; content joins time+message and bare message; write creates the file in a temp directory with the expected content and returns its URL.

### Task 2: Export menu items + toast

**Files:** Modify `LogSessionStore.swift` (add `var toast: String?` + `func showToast(_:)` auto-clearing after 3 s), `LogToolbar.swift` (overflow menu gains "Export visible…" / "Export full buffer…" wired to `LogExporter.write` with `FileManager.default.urls(for: .downloadsDirectory…)`), `LogPanelView.swift` (toast overlay bottom-trailing, mono 11.5, `surfaceOverlay` bg, strong border, radius 10).

Export visible uses `session.search.visibleLines(from: session.buffer.lines)`; full uses `session.buffer.lines`. Success → `store.showToast("saved \(url.lastPathComponent) to Downloads")`; failure → toast with the error.

### Task 3: Entry points — row chip, palette action, detail card

**Files:**
- `PodListView.swift`: Name column gains, when `pod.id == selectedPodID`, a trailing chip `logs ⏎` (mono 10, accent fg, accent 12% bg, accent 30% border, radius 4) with `.onTapGesture` → new closure `var onOpenLogs: ((PodInfo) -> Void)?`.
- `MainView+DetailArea.swift`: pass `onOpenLogs: { logSessionStore.open(pod: $0, context: selectedContext) }` (add `@Environment(LogSessionStore.self)` access in `MainView`).
- `CommandPaletteView.swift`: new `case podLogs(PodInfo)` item (label "Pod logs: <name>", listed when a pod is selected), new `let selectedPod: PodInfo?` + `let onOpenPodLogs: (PodInfo) -> Void`; `run` dispatches it. `MainView` passes the currently selected pod (lookup `selectedPodID` in `clusterState.pods`).
- `ResourceDetailView.swift` (§2 approximation, additive): under `podDetail`, async-loaded containers section (dot colored by state · name mono · status text) via `fetchPodContainers` on task; Logs button becomes `.borderedProminent`-style secondary emphasis (keep Shell/YAML as-is).

Full unit suite → commit → push → PR base `feat/294-log-session-tabs`.
