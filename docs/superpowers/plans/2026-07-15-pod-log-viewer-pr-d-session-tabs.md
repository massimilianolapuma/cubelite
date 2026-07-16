# Pod Log Viewer — PR D (Session Tabs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-pod log sessions with a tab strip, drag-resizable panel (160–560 pt, persisted), ⌘L collapse, and the "↓ N new lines" pill while paused.

**Architecture:** `LogSessionStore` grows from one `session` to `sessions: [LogSession]` + `activeSessionID`; each session keeps its own stream/buffer/search state alive in background tabs. `LogPanelView`'s header strip becomes `LogTabStrip` (one tab per session). Panel height lives in the store, persisted to UserDefaults, adjusted by a 6 pt drag zone. Pause bookkeeping (`pausedAtCount`) lives in `LogSession.isFollowing.didSet`.

**Tech Stack:** Swift 6, SwiftUI, XCTest.

## Global Constraints

- Handoff §Session tab strip, §"↓ N new lines" pill, §Panel chrome. Scope fence: no export/entry points (PR E), no reconnect (PR F), no pop-out (#298).
- Tab: status dot · pod name (mono 11, max 190 pt, middle-truncated) · container name (mono 10, tertiary) · ✕. Active tab: `surfacePanel` bg + 2 pt accent top bar + bright name; inactive hover `surfaceRaised`.
- Height default 280, clamp 160–560, key `logPanel.height`; collapse ⌘L or chevron.
- Closing the active tab activates its right neighbor, else the left one; closing the last tab hides the panel.
- Base branch: `feat/294-log-search` (stacked on PR C #301).
- Test command as in PR B plan.

---

### Task 1: Store — multi-session + pause bookkeeping + height

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Models/LogSessionStore.swift`
- Test: `apps/macos/cubelite/cubeliteTests/LogSessionStoreTests.swift` (extend)

**Interfaces (produced for Task 2):**

```swift
// LogSession additions
var isFollowing = true { didSet { /* record pausedAtCount on pause, clear + scroll intent on resume */ } }
private(set) var pausedAtCount: Int?
var newLinesSincePause: Int { get }   // 0 while following

// LogSessionStore replaces `session` with:
private(set) var sessions: [LogSession]
var activeSessionID: String?          // PodInfo.id
var activeSession: LogSession? { get }
var panelHeight: Double               // clamped 160...560, persisted "logPanel.height"
func open(pod: PodInfo, context: String?)   // append or focus, expands panel
func close(sessionID: String)                // neighbor activation rule
func closeAll()
```

Compatibility: `LogPanelView`/`LogToolbar`/`LogBodyView` currently read `store.session` — Task 2 rewires them; keep a deprecated computed `var session: LogSession? { activeSession }` OUT (no dead API; fix call sites instead).

- [ ] **Step 1: Extend tests** (replace the single-session assumptions):

```swift
    func testOpen_secondPod_addsSessionAndActivates() async throws {
        streamer.containers = [makeContainer("worker")]
        store.open(pod: makePod("web-1"), context: nil)
        store.open(pod: makePod("web-2"), context: nil)
        try await waitUntil { self.store.sessions.count == 2 }
        XCTAssertEqual(store.activeSession?.pod.name, "web-2")
    }

    func testOpen_existingPod_focusesWithoutDuplicate() async throws {
        streamer.containers = [makeContainer("worker")]
        store.open(pod: makePod("web-1"), context: nil)
        store.open(pod: makePod("web-2"), context: nil)
        store.open(pod: makePod("web-1"), context: nil)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(store.sessions.count, 2)
        XCTAssertEqual(store.activeSession?.pod.name, "web-1")
    }

    func testClose_activeTab_activatesRightNeighborThenLeft() async throws {
        streamer.containers = [makeContainer("worker")]
        store.open(pod: makePod("a"), context: nil)
        store.open(pod: makePod("b"), context: nil)
        store.open(pod: makePod("c"), context: nil)
        store.activeSessionID = "default/b"
        store.close(sessionID: "default/b")
        XCTAssertEqual(store.activeSession?.pod.name, "c")
        store.close(sessionID: "default/c")
        XCTAssertEqual(store.activeSession?.pod.name, "a")
        store.close(sessionID: "default/a")
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertNil(store.activeSession)
    }

    func testPause_countsNewLines_resumeResets() async throws {
        streamer.containers = [makeContainer("worker")]
        streamer.liveLines = ["2026-07-15T10:00:00Z one", "2026-07-15T10:00:01Z two"]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.buffer.lines.count == 2 }
        let session = try XCTUnwrap(store.activeSession)
        session.isFollowing = false
        XCTAssertEqual(session.newLinesSincePause, 0)
        session.simulateAppendForTesting("2026-07-15T10:00:02Z three")
        XCTAssertEqual(session.newLinesSincePause, 1)
        session.isFollowing = true
        XCTAssertEqual(session.newLinesSincePause, 0)
    }

    func testPanelHeight_clampedAndPersisted() {
        store.panelHeight = 100
        XCTAssertEqual(store.panelHeight, 160)
        store.panelHeight = 900
        XCTAssertEqual(store.panelHeight, 560)
        store.panelHeight = 320
        XCTAssertEqual(defaults.double(forKey: "logPanel.height"), 320)
    }
```

Also update the two PR-B tests that referenced `store.session` (`testOpen_samePod…`, `testClose_cancelsSession`) to `store.activeSession`/`store.close(sessionID:)`. Add to `LogSession` a test hook `func simulateAppendForTesting(_ raw: String)` calling the private `append` (internal, `#if DEBUG` not required — test target uses `@testable`).

- [ ] **Step 2: Run** `LogSessionStoreTests` — expect build FAILURE (new API missing).

- [ ] **Step 3: Implement store changes**

`LogSession`:

```swift
    var isFollowing = true {
        didSet {
            guard oldValue != isFollowing else { return }
            pausedAtCount = isFollowing ? nil : buffer.totalAppended
        }
    }
    private(set) var pausedAtCount: Int?

    /// Lines appended since the user paused (drives the "new lines" pill).
    var newLinesSincePause: Int {
        guard let pausedAtCount else { return 0 }
        return buffer.totalAppended - pausedAtCount
    }

    func simulateAppendForTesting(_ raw: String) { append(raw) }
```

`LogSessionStore`:

```swift
    private(set) var sessions: [LogSession] = []
    var activeSessionID: String?
    var isCollapsed = false

    var activeSession: LogSession? {
        sessions.first { $0.pod.id == activeSessionID }
    }

    var panelHeight: Double {
        didSet {
            let clamped = min(560, max(160, panelHeight))
            if clamped != panelHeight { panelHeight = clamped; return }
            defaults.set(panelHeight, forKey: "logPanel.height")
        }
    }
    // init: panelHeight = defaults.double(forKey: "logPanel.height") is 0 when unset → default 280; clamp on load.

    func open(pod: PodInfo, context: String?) {
        isCollapsed = false
        if let existing = sessions.first(where: { $0.pod.id == pod.id }) {
            activeSessionID = existing.pod.id
            return
        }
        let new = LogSession(pod: pod, context: context, streamer: streamer, defaults: defaults)
        sessions.append(new)
        activeSessionID = new.pod.id
        new.start()
    }

    func close(sessionID: String) {
        guard let index = sessions.firstIndex(where: { $0.pod.id == sessionID }) else { return }
        sessions[index].stop()
        let wasActive = activeSessionID == sessionID
        sessions.remove(at: index)
        if wasActive {
            activeSessionID =
                sessions.indices.contains(index)
                ? sessions[index].pod.id : sessions.last?.pod.id
        }
    }

    func closeAll() {
        sessions.forEach { $0.stop() }
        sessions = []
        activeSessionID = nil
    }
```

- [ ] **Step 4: Fix view call sites minimally** (compile-only here; visual tab strip is Task 2): `LogPanelView` uses `store.activeSession`, close button calls `store.closeAll()`.

- [ ] **Step 5: Run full unit suite** — PASS. **Step 6: Commit** `feat(macos): multi-session LogSessionStore with pause bookkeeping and panel height`.

---

### Task 2: Tab strip, resize handle, ⌘L, new-lines pill

**Files:**
- Create: `apps/macos/cubelite/cubelite/Views/LogPanel/LogTabStrip.swift`
- Modify: `apps/macos/cubelite/cubelite/Views/LogPanel/LogPanelView.swift` (strip → `LogTabStrip`, resize handle above, height from store, ⌘L)
- Modify: `apps/macos/cubelite/cubelite/Views/LogPanel/LogBodyView.swift` (pill overlay)

**Interfaces:** consumes Task 1 store API only.

- [ ] **Step 1: `LogTabStrip`**

```swift
import SwiftUI

/// One tab per open log session; right side hosts line count + collapse.
struct LogTabStrip: View {

    @Environment(LogSessionStore.self) private var store

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(store.sessions, id: \.pod.id) { session in
                        tab(session)
                    }
                }
            }
            Spacer(minLength: 8)
            if let active = store.activeSession {
                Text(lineCountLabel(active))
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
                    .lineLimit(1)
            }
            Button {
                store.isCollapsed.toggle()
            } label: {
                Image(systemName: store.isCollapsed ? "chevron.up" : "chevron.down")
                    .font(.system(size: 10))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .buttonStyle(.plain)
            .keyboardShortcut("l", modifiers: .command)
            .accessibilityLabel(store.isCollapsed ? "Expand log panel" : "Collapse log panel")
            .padding(.leading, 8)
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(DesignTokens.surfaceRaised)
    }

    private func tab(_ session: LogSession) -> some View {
        let isActive = session.pod.id == store.activeSessionID
        return HStack(spacing: 7) {
            Circle()
                .fill(session.pod.ready ? DesignTokens.statusOk : DesignTokens.statusWarn)
                .frame(width: 7, height: 7)
            Text(session.pod.name)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(isActive ? DesignTokens.textDataBright : DesignTokens.textTertiary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: 190)
            if let container = session.selectedContainer {
                Text(container)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
                    .lineLimit(1)
            }
            Button {
                store.close(sessionID: session.pod.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 8))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close \(session.pod.name) logs")
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(isActive ? DesignTokens.surfacePanel : .clear)
        .overlay(alignment: .top) {
            if isActive {
                Rectangle().fill(DesignTokens.accentDefault).frame(height: 2)
            }
        }
        .overlay(alignment: .trailing) {
            Rectangle().fill(DesignTokens.borderFaint).frame(width: 1)
        }
        .contentShape(Rectangle())
        .onTapGesture { store.activeSessionID = session.pod.id }
    }

    private func lineCountLabel(_ session: LogSession) -> String {
        let visible = session.buffer.lines.count
        let total = session.buffer.totalAppended
        return total > visible ? "\(visible) lines · \(total) buffered" : "\(visible) lines"
    }
}
```

- [ ] **Step 2: Panel — resize + height + strip swap**

`LogPanelView.body` becomes (session → `store.activeSession`):

```swift
        if let session = store.activeSession {
            VStack(spacing: 0) {
                resizeHandle
                LogTabStrip()
                if !store.isCollapsed {
                    Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
                    LogToolbar(session: session)
                    Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
                    LogBodyView(session: session)
                        .frame(height: store.panelHeight)
                }
            }
            .background(DesignTokens.surfacePanel)
        }
```

```swift
    @State private var dragStartHeight: Double?

    private var resizeHandle: some View {
        Rectangle()
            .fill(DesignTokens.borderStrong)
            .frame(height: 1)
            .padding(.vertical, 2.5)   // 6pt grab zone
            .contentShape(Rectangle())
            .onHover { hovering in
                if hovering { NSCursor.resizeUpDown.push() } else { NSCursor.pop() }
            }
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        if dragStartHeight == nil { dragStartHeight = store.panelHeight }
                        // Dragging up grows the panel (negative translation).
                        store.panelHeight = (dragStartHeight ?? 280) - value.translation.height
                    }
                    .onEnded { _ in dragStartHeight = nil }
            )
    }
```

Remove the old `headerStrip`/`lineCountLabel` from `LogPanelView` (now in `LogTabStrip`).

- [ ] **Step 3: New-lines pill** — overlay on `LogBodyView.logList`:

```swift
            .overlay(alignment: .bottom) {
                if !session.isFollowing, session.newLinesSincePause > 0 {
                    Button {
                        session.isFollowing = true
                        if let last = session.buffer.lines.last {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    } label: {
                        Text("↓ \(session.newLinesSincePause) new lines")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(DesignTokens.accentDefault)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 5)
                            .background(DesignTokens.surfaceOverlay)
                            .clipShape(Capsule())
                            .overlay(Capsule().stroke(DesignTokens.borderStrong, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 10)
                }
            }
```

(place inside the `ScrollViewReader` closure so `proxy` is in scope).

- [ ] **Step 4: Full unit suite** — PASS. **Step 5: Commit + push + PR** (base `feat/294-log-search`), title `feat(macos): log session tabs — multi-pod, resize, ⌘L, new-lines pill (#294 PR D)`.
