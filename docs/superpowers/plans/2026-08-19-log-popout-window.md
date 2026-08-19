# Pop-out Log Window (macOS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detach a log session from the bottom panel into its own OS window (`⧉`), with move + re-attach semantics and full toolbar parity (issue #298).

**Architecture:** `LogSessionStore` (app-scoped, shared across windows) gains a `detachedSessionIDs` set; the panel renders only attached sessions while a new `WindowGroup(for: String.self)` scene renders detached ones, binding the **same** `LogSession` object — no new streams, no buffer copies. The session content (toolbar + banner + body) is extracted from `LogPanelView` into a shared `LogSessionContentView`.

**Tech Stack:** Swift 6, SwiftUI (macOS), XCTest.

**Spec:** `docs/superpowers/specs/2026-08-19-log-popout-window-design.md`

## Global Constraints

- Branch: `feat/log-popout-window` (already created; spec committed there).
- No `try!` or forced unwrap (`!`) outside test code (repo AGENTS.md).
- No Claude attribution footers in commits or PRs.
- Detached state is NOT persisted; windows do not survive relaunch.
- The stream is never stopped by detach/re-attach.
- Build: `xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build`
- Tests: `xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -skip-testing cubeliteUITests`
- Sonar duplication gate: reuse existing views/helpers, do not copy-paste view bodies.

---

### Task 1: `LogSessionStore` detach/re-attach state machine

> **Deviation (2026-08-19):** the close() fallback formula below proved defective (wrong neighbor when detached sessions precede the active tab) and was corrected in commit 7f2c4f8 to mirror detach()'s attached-relative indexing, with a regression test. See the shipped code, not this snippet.

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Models/LogSessionStore.swift` (class `LogSessionStore`, lines ~227–323)
- Test: `apps/macos/cubelite/cubeliteTests/LogSessionStoreTests.swift`

**Interfaces:**
- Consumes: existing `LogSessionStore.open(pod:context:)`, `close(sessionID:)`, `closeAll()`, `sessions`, `activeSessionID`.
- Produces (used by Tasks 3–4):
  - `private(set) var detachedSessionIDs: Set<String>`
  - `var attachedSessions: [LogSession]` — sessions minus detached
  - `func isDetached(_ sessionID: String) -> Bool`
  - `func detach(sessionID: String)` — no-op on unknown/already-detached IDs
  - `func reattach(sessionID: String)` — no-op if not detached; makes session the active tab and expands the panel
- Invariant produced: `activeSessionID` always names an **attached** session or is nil.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `@MainActor final class LogSessionStoreTests` (it already provides `store`, `streamer`, `defaults` via `setUp`, and `makePod(_:)`). Use `store.sessions[i].pod.id` rather than hardcoding ID formats.

```swift
    // MARK: - Detach / re-attach (#298)

    func testDetach_removesFromAttachedButKeepsSession() async throws {
        store.open(pod: makePod("web-1"), context: nil)
        let id = store.sessions[0].pod.id

        store.detach(sessionID: id)

        XCTAssertTrue(store.isDetached(id))
        XCTAssertEqual(store.sessions.count, 1, "session must survive detach")
        XCTAssertTrue(store.attachedSessions.isEmpty)
    }

    func testDetach_activeTab_movesActiveToNeighbor() async throws {
        store.open(pod: makePod("web-1"), context: nil)
        store.open(pod: makePod("web-2"), context: nil)
        let first = store.sessions[0].pod.id
        let second = store.sessions[1].pod.id
        store.activeSessionID = first

        store.detach(sessionID: first)

        XCTAssertEqual(store.activeSessionID, second)
    }

    func testDetach_lastAttached_clearsActive() async throws {
        store.open(pod: makePod("web-1"), context: nil)
        let id = store.sessions[0].pod.id

        store.detach(sessionID: id)

        XCTAssertNil(store.activeSessionID)
    }

    func testDetach_inactiveTab_keepsActive() async throws {
        store.open(pod: makePod("web-1"), context: nil)
        store.open(pod: makePod("web-2"), context: nil)
        let first = store.sessions[0].pod.id
        let second = store.sessions[1].pod.id
        store.activeSessionID = second

        store.detach(sessionID: first)

        XCTAssertEqual(store.activeSessionID, second)
    }

    func testDetach_unknownOrDetachedID_isNoOp() async throws {
        store.open(pod: makePod("web-1"), context: nil)
        let id = store.sessions[0].pod.id

        store.detach(sessionID: "nope/nope")
        XCTAssertTrue(store.detachedSessionIDs.isEmpty)

        store.detach(sessionID: id)
        store.detach(sessionID: id)
        XCTAssertEqual(store.detachedSessionIDs, [id])
    }

    func testReattach_restoresTabAndActivates() async throws {
        store.open(pod: makePod("web-1"), context: nil)
        store.open(pod: makePod("web-2"), context: nil)
        let first = store.sessions[0].pod.id
        store.detach(sessionID: first)
        store.isCollapsed = true

        store.reattach(sessionID: first)

        XCTAssertFalse(store.isDetached(first))
        XCTAssertEqual(store.activeSessionID, first)
        XCTAssertFalse(store.isCollapsed, "re-attach must surface the panel")
        XCTAssertEqual(store.attachedSessions.count, 2)
    }

    func testReattach_notDetached_isNoOp() async throws {
        store.open(pod: makePod("web-1"), context: nil)
        store.open(pod: makePod("web-2"), context: nil)
        let first = store.sessions[0].pod.id
        let second = store.sessions[1].pod.id
        store.activeSessionID = second

        store.reattach(sessionID: first)

        XCTAssertEqual(store.activeSessionID, second, "no-op must not steal focus")
    }

    func testClose_whileDetached_clearsDetachedSet() async throws {
        store.open(pod: makePod("web-1"), context: nil)
        let id = store.sessions[0].pod.id
        store.detach(sessionID: id)

        store.close(sessionID: id)

        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertFalse(store.isDetached(id))
    }

    func testClose_activeTab_fallbackSkipsDetachedSessions() async throws {
        store.open(pod: makePod("web-1"), context: nil)
        store.open(pod: makePod("web-2"), context: nil)
        store.open(pod: makePod("web-3"), context: nil)
        let first = store.sessions[0].pod.id
        let second = store.sessions[1].pod.id
        let third = store.sessions[2].pod.id
        store.detach(sessionID: third)
        store.activeSessionID = second

        store.close(sessionID: second)

        XCTAssertEqual(store.activeSessionID, first, "fallback must not pick a detached session")
    }

    func testCloseAll_clearsDetachedSet() async throws {
        store.open(pod: makePod("web-1"), context: nil)
        let id = store.sessions[0].pod.id
        store.detach(sessionID: id)

        store.closeAll()

        XCTAssertTrue(store.detachedSessionIDs.isEmpty)
    }

    func testOpen_detachedPod_doesNotReattachOrActivate() async throws {
        store.open(pod: makePod("web-1"), context: nil)
        store.open(pod: makePod("web-2"), context: nil)
        let first = store.sessions[0].pod.id
        let second = store.sessions[1].pod.id
        store.detach(sessionID: first)

        store.open(pod: makePod("web-1"), context: nil)

        XCTAssertTrue(store.isDetached(first), "open must not silently re-attach")
        XCTAssertEqual(store.activeSessionID, second)
        XCTAssertEqual(store.sessions.count, 2, "open must not duplicate the session")
    }
```

- [ ] **Step 2: Build for testing, run only this suite, verify the new tests fail**

```bash
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
```

Expected: **build failure** — `detach`, `reattach`, `isDetached`, `attachedSessions`, `detachedSessionIDs` don't exist yet. (Compile error is this cycle's "red"; note it and move on.)

- [ ] **Step 3: Implement the store changes**

In `LogSessionStore` (`Models/LogSessionStore.swift`):

Add stored/computed state after `var isCollapsed = false`:

```swift
    /// Sessions currently popped out into their own OS windows. Not
    /// persisted: windows do not survive relaunch (#298).
    private(set) var detachedSessionIDs: Set<String> = []

    /// Sessions shown as panel tabs — everything not popped out. The
    /// invariant `activeSessionID` ∈ attached (or nil) is maintained by
    /// `detach`/`reattach`/`close`/`open`.
    var attachedSessions: [LogSession] {
        sessions.filter { !detachedSessionIDs.contains($0.pod.id) }
    }

    func isDetached(_ sessionID: String) -> Bool {
        detachedSessionIDs.contains(sessionID)
    }
```

Add after `closeAll()`:

```swift
    /// Pops the session out of the panel. The caller opens the OS window
    /// (`openWindow` is a SwiftUI Environment action, unavailable here).
    /// If the session was the active tab, the next attached tab takes
    /// over — same neighbor rule as `close`.
    func detach(sessionID: String) {
        guard sessions.contains(where: { $0.pod.id == sessionID }),
            !detachedSessionIDs.contains(sessionID)
        else { return }
        let attachedBefore = attachedSessions
        detachedSessionIDs.insert(sessionID)
        if activeSessionID == sessionID {
            let index = attachedBefore.firstIndex { $0.pod.id == sessionID } ?? 0
            let remaining = attachedSessions
            activeSessionID =
                remaining.indices.contains(index)
                ? remaining[index].pod.id : remaining.last?.pod.id
        }
    }

    /// Returns a popped-out session to the panel as the active tab.
    /// Called by the window's `⏷` button and by window close.
    func reattach(sessionID: String) {
        guard detachedSessionIDs.remove(sessionID) != nil else { return }
        activeSessionID = sessionID
        isCollapsed = false
    }
```

Modify `open(pod:context:)` — the existing-session branch must not activate a detached session (the view layer focuses its window instead):

```swift
    func open(pod: PodInfo, context: String?) {
        if let existing = sessions.first(where: { $0.pod.id == pod.id }) {
            guard !detachedSessionIDs.contains(existing.pod.id) else { return }
            isCollapsed = false
            activeSessionID = existing.pod.id
            return
        }
        isCollapsed = false
        let new = LogSession(
            pod: pod, context: context, streamer: streamer, defaults: defaults,
            backoffBase: backoffBase)
        sessions.append(new)
        activeSessionID = new.pod.id
        new.start()
    }
```

Modify `close(sessionID:)` — clear the detached set and pick the fallback among **attached** sessions:

```swift
    func close(sessionID: String) {
        guard let index = sessions.firstIndex(where: { $0.pod.id == sessionID }) else { return }
        sessions[index].stop()
        let wasActive = activeSessionID == sessionID
        sessions.remove(at: index)
        detachedSessionIDs.remove(sessionID)
        if wasActive {
            let remaining = attachedSessions
            let attachedIndex = min(index, max(0, remaining.count - 1))
            activeSessionID =
                remaining.indices.contains(attachedIndex)
                ? remaining[attachedIndex].pod.id : remaining.last?.pod.id
        }
    }
```

Modify `closeAll()` — add `detachedSessionIDs = []` before/after resetting sessions:

```swift
    func closeAll() {
        sessions.forEach { $0.stop() }
        sessions = []
        detachedSessionIDs = []
        activeSessionID = nil
    }
```

- [ ] **Step 4: Build + run the store suite, verify green (new and pre-existing tests)**

```bash
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -only-testing cubeliteTests/LogSessionStoreTests
```

Expected: PASS. Note: `testClose_activeTab_fallbackSkipsDetachedSessions` closes the tab at attached-index 1 of [web-1, web-2] (web-3 detached); the fallback formula yields web-1 — if it yields nil or web-3's ID, the fallback still consults the raw `sessions` array: fix the implementation, not the test.

- [ ] **Step 5: Commit**

```bash
git add apps/macos/cubelite/cubelite/Models/LogSessionStore.swift apps/macos/cubelite/cubeliteTests/LogSessionStoreTests.swift
git commit -m "feat(macos): LogSessionStore detach/re-attach state for pop-out windows (#298)"
```

---

### Task 2: Extract `LogSessionContentView` from `LogPanelView`

Pure refactor — no behavior change. Both the panel (now) and the detached window (Task 3) compose this view.

**Files:**
- Create: `apps/macos/cubelite/cubelite/Views/LogPanel/LogSessionContentView.swift`
- Modify: `apps/macos/cubelite/cubelite/Views/LogPanel/LogPanelView.swift`

**Interfaces:**
- Consumes: `LogToolbar(session:)`, `LogBodyView(session:)`, `LogSession.isReconnecting/reconnectAttempt/nextRetrySeconds/retryNow()`, `DesignTokens`.
- Produces: `LogSessionContentView(session: LogSession, bodyHeight: Double?)` — toolbar + dividers + reconnect banner + body. `bodyHeight == nil` lets the body fill the container (window mode); a value pins it (panel mode).

- [ ] **Step 1: Create `LogSessionContentView.swift`**

Move the toolbar/banner/body composition, `reconnectBanner`, and `PulseEffect` out of `LogPanelView` verbatim:

```swift
import SwiftUI

/// Everything a log session shows below the tab strip: toolbar, reconnect
/// banner, log body. Shared verbatim between the bottom panel and the
/// detached pop-out window (#298) — panel-only chrome (resize handle, tab
/// strip, collapse) stays in `LogPanelView`.
struct LogSessionContentView: View {

    let session: LogSession
    /// Panel mode pins the body to the store's panel height; window mode
    /// passes nil and the body fills the window.
    let bodyHeight: Double?

    var body: some View {
        VStack(spacing: 0) {
            LogToolbar(session: session)
            Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
            if session.isReconnecting {
                reconnectBanner(session)
            }
            if let bodyHeight {
                LogBodyView(session: session)
                    .frame(height: bodyHeight)
            } else {
                LogBodyView(session: session)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func reconnectBanner(_ session: LogSession) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(DesignTokens.statusWarn)
                .frame(width: 7, height: 7)
                .modifier(PulseEffect())
                .accessibilityHidden(true)
            Text(
                "stream lost — reconnecting (attempt \(session.reconnectAttempt), "
                    + "next retry \(session.nextRetrySeconds)s)"
            )
            .scaledFont(size: 11, design: .monospaced)
            .foregroundStyle(DesignTokens.statusWarn)
            Spacer()
            Button("retry now") { session.retryNow() }
                .buttonStyle(.plain)
                .scaledFont(size: 11, weight: .medium)
                .foregroundStyle(DesignTokens.statusWarn)
                .underline()
                .accessibilityLabel("Retry connection now")
                .accessibilityIdentifier("logpanel.reconnect-retry")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(DesignTokens.statusWarn.opacity(0.08))
        .overlay(alignment: .bottom) {
            Rectangle().fill(DesignTokens.statusWarn.opacity(0.25)).frame(height: 1)
        }
    }
}

/// Slow opacity pulse for the reconnect banner's status dot.
private struct PulseEffect: ViewModifier {
    @State private var dimmed = false

    func body(content: Content) -> some View {
        content
            .opacity(dimmed ? 0.35 : 1)
            .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: dimmed)
            .onAppear { dimmed = true }
    }
}
```

- [ ] **Step 2: Rewrite `LogPanelView` to compose it**

Replace the whole file body (keep the header comment, imports, `resizeHandle`, toast overlay; delete the moved `reconnectBanner` and `PulseEffect`):

```swift
import AppKit
import SwiftUI

/// Persistent bottom log panel: resize handle, session tab strip, toolbar,
/// log body. Collapses to the 34pt strip (⌘L). Hidden when no session is
/// open.
struct LogPanelView: View {

    @Environment(LogSessionStore.self) private var store

    @State private var dragStartHeight: Double?

    var body: some View {
        if let session = store.activeSession {
            VStack(spacing: 0) {
                resizeHandle
                LogTabStrip()
                if !store.isCollapsed {
                    Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
                    LogSessionContentView(session: session, bodyHeight: store.panelHeight)
                }
            }
            .background(DesignTokens.surfacePanel)
            .overlay(alignment: .bottomTrailing) {
                if let toast = store.toast {
                    Text(toast)
                        .scaledFont(size: 11.5, design: .monospaced)
                        .foregroundStyle(DesignTokens.textLog)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(DesignTokens.surfaceOverlay)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(DesignTokens.borderStrong, lineWidth: 1))
                        .padding(12)
                        .transition(.opacity)
                }
            }
        }
    }

    /// 6pt grab zone on the top edge; dragging up grows the panel.
    private var resizeHandle: some View {
        Rectangle()
            .fill(DesignTokens.borderStrong)
            .frame(height: 1)
            .padding(.vertical, 2.5)
            .contentShape(Rectangle())
            .onHover { hovering in
                if hovering {
                    NSCursor.resizeUpDown.push()
                } else {
                    NSCursor.pop()
                }
            }
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        if dragStartHeight == nil { dragStartHeight = store.panelHeight }
                        store.panelHeight = (dragStartHeight ?? 280) - value.translation.height
                    }
                    .onEnded { _ in dragStartHeight = nil }
            )
    }
}
```

Layout-fidelity note vs the original: the original placed the toolbar's top divider *above* `LogToolbar` and none between banner and body; `LogSessionContentView` keeps the divider below the toolbar instead, so the panel's expanded branch adds the top divider itself (see the `Rectangle` before `LogSessionContentView` above). Net rendered result is identical: divider, toolbar, divider, [banner], body.

- [ ] **Step 3: Build + full unit test run (regression gate)**

```bash
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -skip-testing cubeliteUITests
```

Expected: PASS, zero behavior change.

- [ ] **Step 4: Commit**

```bash
git add apps/macos/cubelite/cubelite/Views/LogPanel/LogSessionContentView.swift apps/macos/cubelite/cubelite/Views/LogPanel/LogPanelView.swift
git commit -m "refactor(macos): extract LogSessionContentView from LogPanelView (#298)"
```

---

### Task 3: Detached window view + scene

**Files:**
- Create: `apps/macos/cubelite/cubelite/Views/LogPanel/DetachedLogWindowView.swift`
- Modify: `apps/macos/cubelite/cubelite/CubeliteApp.swift` (add scene after the main `WindowGroup`, before `MenuBarExtra`)

**Interfaces:**
- Consumes: `LogSessionStore.reattach(sessionID:)`, `sessions`, `LogSessionContentView(session:bodyHeight:)` (Task 2).
- Produces:
  - `DetachedLogWindowView(sessionID: String?)`
  - `EnvironmentValues.isDetachedLogContext: Bool` (default `false`) — Task 4's toolbar reads it to hide `⧉` inside the window.
  - App scene `WindowGroup("Pod Logs", for: String.self)` — opened via `openWindow(value: sessionID)`; same value focuses the existing window (one window per session for free).

- [ ] **Step 1: Create `DetachedLogWindowView.swift`**

```swift
import SwiftUI

/// True inside a detached pop-out log window; the toolbar uses it to swap
/// the detach button (`⧉`, panel-only) for the window's re-attach header.
private struct DetachedLogContextKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var isDetachedLogContext: Bool {
        get { self[DetachedLogContextKey.self] }
        set { self[DetachedLogContextKey.self] = newValue }
    }
}

/// Root view of a popped-out log session window (#298): minimal header
/// (pod/container + re-attach) above the shared session content. Binds the
/// same `LogSession` object as the panel — the stream never restarts.
/// Closing the window by any means re-attaches the tab to the panel; the
/// window dismisses itself if the session is closed elsewhere.
struct DetachedLogWindowView: View {

    @Environment(LogSessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let sessionID: String?

    var body: some View {
        if let sessionID,
            let session = store.sessions.first(where: { $0.pod.id == sessionID }) {
            VStack(spacing: 0) {
                header(session)
                Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
                LogSessionContentView(session: session, bodyHeight: nil)
            }
            .background(DesignTokens.surfacePanel)
            .environment(\.isDetachedLogContext, true)
            .navigationTitle("\(session.pod.name) — logs")
            .overlay(alignment: .bottomTrailing) {
                if let toast = store.toast {
                    Text(toast)
                        .scaledFont(size: 11.5, design: .monospaced)
                        .foregroundStyle(DesignTokens.textLog)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(DesignTokens.surfaceOverlay)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(DesignTokens.borderStrong, lineWidth: 1))
                        .padding(12)
                        .transition(.opacity)
                }
            }
            // Any close path (⌘W, traffic light, ⏷) lands here; reattach is
            // a no-op when the ⏷ button already did it or the session is gone.
            .onDisappear { store.reattach(sessionID: sessionID) }
        } else {
            // Session closed elsewhere (close-all, pod deleted) or nil
            // restoration value: the window has nothing to show.
            Color.clear.onAppear { dismiss() }
        }
    }

    private func header(_ session: LogSession) -> some View {
        HStack(spacing: 7) {
            Circle()
                .fill(session.pod.ready ? DesignTokens.statusOk : DesignTokens.statusWarn)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            Text(session.pod.name)
                .scaledFont(size: 11, weight: .medium, design: .monospaced)
                .foregroundStyle(DesignTokens.textDataBright)
                .lineLimit(1)
                .truncationMode(.middle)
            if let container = session.selectedContainer {
                Text(session.isMerged ? "all containers" : container)
                    .scaledFont(size: 10, design: .monospaced, relativeTo: .caption)
                    .foregroundStyle(DesignTokens.textTertiary)
                    .lineLimit(1)
            }
            Spacer()
            Button {
                store.reattach(sessionID: session.pod.id)
                dismiss()
            } label: {
                Image(systemName: "arrow.down.left.square")
                    .scaledFont(size: 11)
                    .foregroundStyle(DesignTokens.textSecondary)
                    .frame(width: 26)
                    .frame(minHeight: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Return this session to the log panel")
            .accessibilityLabel("Return to log panel")
            .accessibilityIdentifier("logwindow.reattach")
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 34)
        .background(DesignTokens.surfaceRaised)
    }
}
```

- [ ] **Step 2: Add the scene to `CubeliteApp`**

In `CubeliteApp.body`, after the main `WindowGroup`'s modifiers (`.defaultSize(...)`) and before `MenuBarExtra`:

```swift
        WindowGroup("Pod Logs", for: String.self) { $sessionID in
            DetachedLogWindowView(sessionID: sessionID)
                .environment(appSettings)
                .environment(logSessionStore)
                .preferredColorScheme(appSettings.colorScheme)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 900, height: 500)
```

(`$sessionID` binds `String?` — nil handled by the view's else branch.)

- [ ] **Step 3: Build + full unit test run**

```bash
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -skip-testing cubeliteUITests
```

Expected: PASS (no tests target the view; the gate is compile + regression).

- [ ] **Step 4: Commit**

```bash
git add apps/macos/cubelite/cubelite/Views/LogPanel/DetachedLogWindowView.swift apps/macos/cubelite/cubelite/CubeliteApp.swift
git commit -m "feat(macos): detached pop-out log window scene (#298)"
```

---

### Task 4: Detach entry points — toolbar `⧉`, tab strip filtering, open-logs call sites

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Views/LogPanel/LogToolbar.swift`
- Modify: `apps/macos/cubelite/cubelite/Views/LogPanel/LogTabStrip.swift` (line 13: `ForEach(store.sessions ...)`)
- Modify: `apps/macos/cubelite/cubelite/Views/ResourceDetailView.swift:120`
- Modify: `apps/macos/cubelite/cubelite/Views/MainView+DetailArea.swift:80`
- Modify: `apps/macos/cubelite/cubelite/Views/MainView.swift:255`

**Interfaces:**
- Consumes: `store.detach(sessionID:)`, `store.isDetached(_:)`, `store.attachedSessions` (Task 1); `\.isDetachedLogContext` (Task 3).
- Produces: user-visible `⧉` button (`logpanel.detach`); every "open logs" entry point focuses the existing window for detached pods.

- [ ] **Step 1: Add the detach button to `LogToolbar`**

Add the two environment properties next to the existing `@Environment(LogSessionStore.self)`:

```swift
    @Environment(\.isDetachedLogContext) private var isDetachedContext
    @Environment(\.openWindow) private var openWindow
```

In `body`'s `HStack`, insert between `followButton` and `overflowMenu`:

```swift
            if !isDetachedContext {
                detachButton
            }
```

Add the view builder alongside `followButton`:

```swift
    /// Pops the session out into its own OS window (#298). Hidden inside
    /// the detached window itself, where `⏷` in the header replaces it.
    private var detachButton: some View {
        Button {
            store.detach(sessionID: session.pod.id)
            openWindow(value: session.pod.id)
        } label: {
            Image(systemName: "arrow.up.forward.square")
                .scaledFont(size: 11)
                .foregroundStyle(DesignTokens.textSecondary)
                .frame(width: 26)
                .frame(minHeight: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open this session in a separate window")
        .accessibilityLabel("Pop out log session")
        .accessibilityIdentifier("logpanel.detach")
    }
```

- [ ] **Step 2: Tab strip renders attached sessions only**

`LogTabStrip.swift` line 13 — change:

```swift
                    ForEach(store.sessions, id: \.pod.id) { session in
```

to:

```swift
                    ForEach(store.attachedSessions, id: \.pod.id) { session in
```

- [ ] **Step 3: Route detached pods to their window at every open-logs call site**

Each of the three call sites currently calls `logSessionStore.open(pod:context:)` directly. Each hosting view gains `@Environment(\.openWindow) private var openWindow` (add it next to the view's existing `@Environment` properties), and the call becomes:

`ResourceDetailView.swift:120`:

```swift
                    if logSessionStore.isDetached(pod.id) {
                        openWindow(value: pod.id)
                    } else {
                        logSessionStore.open(pod: pod, context: context)
                    }
```

`MainView+DetailArea.swift:80` (closure form):

```swift
                        onOpenLogs: { pod in
                            if logSessionStore.isDetached(pod.id) {
                                openWindow(value: pod.id)
                            } else {
                                logSessionStore.open(pod: pod, context: selectedContext)
                            }
                        }
```

`MainView.swift:255`:

```swift
                        if logSessionStore.isDetached(pod.id) {
                            openWindow(value: pod.id)
                        } else {
                            logSessionStore.open(pod: pod, context: selectedContext)
                        }
```

Adjust to each site's exact local names (`pod`, `context`/`selectedContext`) — read the surrounding lines before editing. If `MainView+DetailArea.swift` is an extension of `MainView`, the `openWindow` property must live on the type that hosts the closure; if the extension cannot hold stored properties, declare `@Environment(\.openWindow) private var openWindow` in `MainView` itself and reference it from the extension.

- [ ] **Step 4: Build + full unit test run**

```bash
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -skip-testing cubeliteUITests
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/macos/cubelite/cubelite/Views/LogPanel/LogToolbar.swift apps/macos/cubelite/cubelite/Views/LogPanel/LogTabStrip.swift apps/macos/cubelite/cubelite/Views/ResourceDetailView.swift apps/macos/cubelite/cubelite/Views/MainView+DetailArea.swift apps/macos/cubelite/cubelite/Views/MainView.swift
git commit -m "feat(macos): pop out log session via toolbar detach button (#298)"
```

---

### Task 5: Verification pass + PR

**Files:**
- No new files. Manual verification + PR creation.

**Interfaces:**
- Consumes: everything above.
- Produces: PR from `feat/log-popout-window` to `main` referencing #298.

- [ ] **Step 1: Full unit suite, clean build**

```bash
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -skip-testing cubeliteUITests
```

Expected: PASS, zero warnings introduced in touched files.

- [ ] **Step 2: Manual smoke (needs a reachable cluster; ask the user to run the app if no cluster is available to the agent)**

Checklist to verify by hand in the running app:
1. Open logs for a pod → `⧉` in the toolbar → tab leaves the panel, window shows the live stream (no restart flicker, buffer intact).
2. Scroll/search state survives the detach (it is the same session object).
3. Close the window with ⌘W → tab returns to the panel as the active tab.
4. Detach again, click `⏷` → same result.
5. Detach two pods → two windows; `⧉` on an already-detached pod's row entry point (pod detail "Logs") focuses its window instead of opening a panel tab.
6. Detach the only tab → panel disappears, stream continues in the window.
7. Export from the window → toast appears in the window.
8. Close-all/quit paths: no crash, no orphan windows.

- [ ] **Step 3: Push and open PR (user gate first)**

Repo convention: pushes require the `massilp` GitHub account (dual-account setup — see memory). **Stop and confirm with the user before pushing.**

```bash
git push -u origin feat/log-popout-window
gh pr create --title "feat(macos): pop out log session to separate OS window (#298)" --body "Implements #298 (macOS half): detach a log session from the bottom panel into its own OS window via ⧉, with move + re-attach semantics.

- LogSessionStore: detachedSessionIDs / attachedSessions / detach / reattach; activeSessionID invariant kept among attached tabs
- LogSessionContentView extracted from LogPanelView; shared by panel and window
- New WindowGroup(for: String.self) scene; one window per session, same LogSession object — stream never restarts
- Window close (any path) re-attaches; window auto-dismisses if the session is closed elsewhere
- Entry points focus the existing window for detached pods

Spec: docs/superpowers/specs/2026-08-19-log-popout-window-design.md
Desktop (Tauri) half tracked separately per the spec.

Testing: LogSessionStoreTests detach/re-attach suite (11 new tests) + full unit suite green + manual window smoke."
```

No Claude attribution in the PR body or commits.
