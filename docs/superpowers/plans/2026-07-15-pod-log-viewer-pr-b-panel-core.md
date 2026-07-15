# Pod Log Viewer — PR B (Panel Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the modal log sheet with a persistent single-session bottom log panel (fixed 280pt) in the app shell: container picker, previous-instance toggle, tail control, follow/pause with autoscroll, severity-colored lines, empty/error/cleared states.

**Architecture:** `LogSessionStore` (`@Observable @MainActor`, injected via `.environment`) owns one `LogSession` (stream task + ring buffer cap 5000). Streaming goes through a `PodLogStreaming` protocol (conformed by `KubeAPIService`, mocked in tests). `LogPanelView` mounts at the bottom of the detail column in `MainView` (right of rail/sidebar, above `StatusBarView`). The `PodLogsView` sheet is deleted; its `LogLine.parse` moves to `Models/LogLine.swift`.

**Tech Stack:** Swift 6, SwiftUI, `@Observable`, XCTest. Tokens from `Helpers/DesignTokens.swift` (note: no `surfaceCard` token — tab strip uses `surfaceRaised`; fonts are system + `.monospaced`, not Geist).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-pod-log-viewer-design.md`; visual reference: handoff README §1.
- Scope fence: NO search (PR C), NO multi-pod tabs / drag-resize / new-lines pill (PR D), NO export/entry-point redesign (PR E), NO reconnect banner (PR F). Panel height fixed 280pt; collapse via chevron only.
- Buffer ring cap 5000; default tail 500. "Load earlier" = restart stream with tail +500 (K8s log API cannot page backwards; honest approximation, refined in PR D if needed).
- Per-pod container memory: `UserDefaults` key `logPanel.container.<namespace>/<pod>`.
- Base branch: `feat/294-pod-log-viewer` (stacked on PR A #299).
- Test command (from `apps/macos/cubelite`): `xcodebuild test -project cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -configuration Debug -skip-testing:cubeliteUITests CODE_SIGN_IDENTITY="-" CODE_SIGNING_ALLOWED=NO`
- Xcode project uses file-system-synchronized groups — new files need no pbxproj edits.

---

### Task 1: `LogLine` + `LogRingBuffer` (pure models)

**Files:**
- Create: `apps/macos/cubelite/cubelite/Models/LogLine.swift`
- Test: `apps/macos/cubelite/cubeliteTests/LogLineTests.swift`

**Interfaces:**
- Produces:
  - `struct LogLine: Identifiable, Equatable, Sendable { let id: Int; let time: String?; let level: Level; let message: String; enum Level { case debug, info, warn, error }; static func parse(_ raw: String, id: Int) -> LogLine }`
  - `struct LogRingBuffer: Sendable { init(cap: Int); mutating func append(_ line: LogLine); mutating func removeAll(); var lines: [LogLine] { get }; var totalAppended: Int { get } }`

- [ ] **Step 1: Write failing tests**

```swift
import XCTest

@testable import cubelite

final class LogLineTests: XCTestCase {

    func testParse_rfc3339Prefix_splitsTimeAndMessage() {
        let line = LogLine.parse("2026-07-15T10:00:01.123456789Z hello world", id: 1)
        XCTAssertEqual(line.time, "10:00:01.123456789Z")
        XCTAssertEqual(line.message, "hello world")
    }

    func testParse_noTimestamp_keepsWholeMessage() {
        let line = LogLine.parse("plain line", id: 1)
        XCTAssertNil(line.time)
        XCTAssertEqual(line.message, "plain line")
    }

    func testParse_severityDetection() {
        XCTAssertEqual(LogLine.parse("ERROR boom", id: 1).level, .error)
        XCTAssertEqual(LogLine.parse("fatal: crash", id: 2).level, .error)
        XCTAssertEqual(LogLine.parse("WARN disk", id: 3).level, .warn)
        XCTAssertEqual(LogLine.parse("DEBUG verbose", id: 4).level, .debug)
        XCTAssertEqual(LogLine.parse("hello", id: 5).level, .info)
    }

    func testRingBuffer_capsAtLimit_keepsNewest() {
        var buffer = LogRingBuffer(cap: 3)
        for i in 0..<5 { buffer.append(LogLine.parse("line \(i)", id: i)) }
        XCTAssertEqual(buffer.lines.map(\.id), [2, 3, 4])
        XCTAssertEqual(buffer.totalAppended, 5)
    }

    func testRingBuffer_removeAll_resetsLinesNotTotal() {
        var buffer = LogRingBuffer(cap: 3)
        buffer.append(LogLine.parse("a", id: 0))
        buffer.removeAll()
        XCTAssertTrue(buffer.lines.isEmpty)
        XCTAssertEqual(buffer.totalAppended, 1)
    }
}
```

- [ ] **Step 2: Run** `-only-testing:cubeliteTests/LogLineTests` — expect build FAILURE (`LogLine` not in scope; the old one is `PodLogsView.LogLine`, fileprivate to that view).

- [ ] **Step 3: Implement**

```swift
import Foundation

/// One parsed pod-log line: kubelet RFC 3339 prefix split off, severity
/// detected from the message body.
struct LogLine: Identifiable, Equatable, Sendable {
    let id: Int
    let time: String?
    let level: Level
    let message: String

    enum Level: Equatable, Sendable {
        case debug, info, warn, error
    }

    /// Splits the kubelet RFC 3339 prefix and detects the severity.
    static func parse(_ raw: String, id: Int) -> LogLine {
        var time: String?
        var message = raw
        if let space = raw.firstIndex(of: " "),
            raw[raw.startIndex..<space].contains("T"),
            raw.hasPrefix("2")
        {
            time = String(raw[raw.startIndex..<space]).components(separatedBy: "T").last
            message = String(raw[raw.index(after: space)...])
        }
        let upper = message.uppercased()
        let level: Level =
            upper.contains("ERROR") || upper.contains("FATAL") || upper.contains("PANIC")
            ? .error
            : upper.contains("WARN")
                ? .warn
                : upper.contains("DEBUG") || upper.contains("TRACE") ? .debug : .info
        return LogLine(id: id, time: time, level: level, message: message)
    }
}

/// Fixed-capacity append-only window over a log stream: keeps the newest
/// `cap` lines and counts everything ever appended.
struct LogRingBuffer: Sendable {
    private(set) var lines: [LogLine] = []
    private(set) var totalAppended = 0
    let cap: Int

    init(cap: Int = 5000) {
        self.cap = cap
    }

    mutating func append(_ line: LogLine) {
        lines.append(line)
        totalAppended += 1
        if lines.count > cap {
            lines.removeFirst(lines.count - cap)
        }
    }

    mutating func removeAll() {
        lines.removeAll()
    }
}
```

- [ ] **Step 4: Run same tests** — expect PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/macos/cubelite/cubelite/Models/LogLine.swift \
        apps/macos/cubelite/cubeliteTests/LogLineTests.swift
git commit -m "feat(macos): LogLine + LogRingBuffer models for the log panel"
```

---

### Task 2: `PodLogStreaming` protocol + `LogSession`/`LogSessionStore`

**Files:**
- Create: `apps/macos/cubelite/cubelite/Services/PodLogStreaming.swift`
- Create: `apps/macos/cubelite/cubelite/Models/LogSessionStore.swift`
- Test: `apps/macos/cubelite/cubeliteTests/LogSessionStoreTests.swift`

**Interfaces:**
- Consumes: `ContainerInfo`, `LogLine`, `LogRingBuffer`, `KubeAPIService.streamPodLogs/fetchPreviousPodLogs/fetchPodContainers` (PR A).
- Produces (for Task 3 UI and PRs C–F):

```swift
protocol PodLogStreaming: Sendable {
    func streamPodLogs(
        namespace: String, pod: String, container: String?, tailLines: Int,
        sinceTime: String?, inContext contextName: String?
    ) async throws -> AsyncThrowingStream<String, Error>
    func fetchPreviousPodLogs(
        namespace: String, pod: String, container: String?, tailLines: Int,
        inContext contextName: String?
    ) async throws -> [String]
    func fetchPodContainers(
        namespace: String, pod: String, inContext contextName: String?
    ) async throws -> [ContainerInfo]
}
extension KubeAPIService: PodLogStreaming {}
```

```swift
@Observable @MainActor final class LogSession { /* see Step 3 */ }
@Observable @MainActor final class LogSessionStore {
    var session: LogSession?
    var isCollapsed: Bool
    var showTimestamps: Bool   // persisted, default true
    var wrapLines: Bool        // persisted, default false
    func open(pod: PodInfo, context: String?)      // create or refocus
    func close()
}
```

- [ ] **Step 1: Write failing tests**

```swift
import XCTest

@testable import cubelite

/// Scripted PodLogStreaming double: yields canned containers and lines,
/// records the query parameters of every call.
final class MockLogStreamer: PodLogStreaming, @unchecked Sendable {
    var containers: [ContainerInfo] = []
    var liveLines: [String] = []
    var previousLines: [String] = []
    private(set) var streamCalls: [(container: String?, tailLines: Int)] = []
    private(set) var previousCalls: [(container: String?, tailLines: Int)] = []

    func streamPodLogs(
        namespace: String, pod: String, container: String?, tailLines: Int,
        sinceTime: String?, inContext contextName: String?
    ) async throws -> AsyncThrowingStream<String, Error> {
        streamCalls.append((container, tailLines))
        let lines = liveLines
        return AsyncThrowingStream { continuation in
            for line in lines { continuation.yield(line) }
            // Leave the stream open like a real follow — no finish().
        }
    }

    func fetchPreviousPodLogs(
        namespace: String, pod: String, container: String?, tailLines: Int,
        inContext contextName: String?
    ) async throws -> [String] {
        previousCalls.append((container, tailLines))
        return previousLines
    }

    func fetchPodContainers(
        namespace: String, pod: String, inContext contextName: String?
    ) async throws -> [ContainerInfo] {
        containers
    }
}

@MainActor
final class LogSessionStoreTests: XCTestCase {

    private var defaults: UserDefaults!
    private var streamer: MockLogStreamer!
    private var store: LogSessionStore!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "LogSessionStoreTests")!
        defaults.removePersistentDomain(forName: "LogSessionStoreTests")
        streamer = MockLogStreamer()
        store = LogSessionStore(streamer: streamer, defaults: defaults)
    }

    private func makeContainer(
        _ name: String, restarts: Int = 0, isInit: Bool = false
    ) -> ContainerInfo {
        ContainerInfo(
            name: name, isInit: isInit, isSidecar: false, restarts: restarts,
            ready: true, state: .running, lastTerminatedReason: nil, lastTerminatedAt: nil)
    }

    private func makePod(_ name: String = "web-1") -> PodInfo {
        PodInfo(name: name, namespace: "default", phase: "Running", ready: true, restarts: 0,
                creationTimestamp: nil)
    }

    /// Polls the main actor until `condition` holds or the timeout elapses.
    private func waitUntil(
        _ condition: @escaping () -> Bool, timeout: TimeInterval = 2
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("condition not met in \(timeout)s") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    func testOpen_fetchesContainersAndStreamsFirstContainer() async throws {
        streamer.containers = [makeContainer("worker"), makeContainer("envoy")]
        streamer.liveLines = ["2026-07-15T10:00:00Z hello"]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.session?.buffer.lines.count == 1 }
        XCTAssertEqual(store.session?.containers.map(\.name), ["worker", "envoy"])
        XCTAssertEqual(store.session?.selectedContainer, "worker")
        XCTAssertEqual(streamer.streamCalls.first?.container, "worker")
        XCTAssertEqual(streamer.streamCalls.first?.tailLines, 500)
        XCTAssertEqual(store.session?.buffer.lines.first?.message, "hello")
    }

    func testOpen_samePod_refocusesWithoutSecondStream() async throws {
        streamer.containers = [makeContainer("worker")]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { !self.streamer.streamCalls.isEmpty }
        store.open(pod: makePod(), context: nil)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(streamer.streamCalls.count, 1)
    }

    func testOpen_remembersContainerChoicePerPod() async throws {
        streamer.containers = [makeContainer("worker"), makeContainer("envoy")]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.session?.selectedContainer != nil }
        store.session?.switchContainer(to: "envoy")
        try await waitUntil { self.streamer.streamCalls.count == 2 }
        store.close()
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.session?.selectedContainer != nil }
        XCTAssertEqual(store.session?.selectedContainer, "envoy")
    }

    func testSwitchContainer_restartsStreamAndClearsBuffer() async throws {
        streamer.containers = [makeContainer("worker"), makeContainer("envoy")]
        streamer.liveLines = ["2026-07-15T10:00:00Z from-worker"]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.session?.buffer.lines.count == 1 }
        store.session?.switchContainer(to: "envoy")
        try await waitUntil { self.streamer.streamCalls.count == 2 }
        XCTAssertEqual(streamer.streamCalls.last?.container, "envoy")
    }

    func testTogglePrevious_fetchesStaticLines() async throws {
        streamer.containers = [makeContainer("worker", restarts: 3)]
        streamer.previousLines = ["2026-07-15T09:00:00Z old line"]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.session?.selectedContainer != nil }
        store.session?.setPrevious(true)
        try await waitUntil { self.store.session?.buffer.lines.count == 1 }
        XCTAssertEqual(streamer.previousCalls.count, 1)
        XCTAssertEqual(store.session?.buffer.lines.first?.message, "old line")
        XCTAssertEqual(store.session?.isFollowing, false)
    }

    func testSetTail_restartsStreamWithNewTail() async throws {
        streamer.containers = [makeContainer("worker")]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { !self.streamer.streamCalls.isEmpty }
        store.session?.setTail(1000)
        try await waitUntil { self.streamer.streamCalls.count == 2 }
        XCTAssertEqual(streamer.streamCalls.last?.tailLines, 1000)
    }

    func testClear_emptiesBufferKeepsStreaming() async throws {
        streamer.containers = [makeContainer("worker")]
        streamer.liveLines = ["2026-07-15T10:00:00Z hello"]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.session?.buffer.lines.count == 1 }
        store.session?.clear()
        XCTAssertEqual(store.session?.buffer.lines.count, 0)
        XCTAssertEqual(store.session?.hasCleared, true)
    }

    func testClose_cancelsSession() async throws {
        streamer.containers = [makeContainer("worker")]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.session != nil }
        store.close()
        XCTAssertNil(store.session)
    }
}
```

- [ ] **Step 2: Run** `-only-testing:cubeliteTests/LogSessionStoreTests` — expect build FAILURE (`PodLogStreaming`/`LogSessionStore` not in scope).

- [ ] **Step 3: Implement**

`Services/PodLogStreaming.swift` — the protocol + conformance exactly as in **Interfaces** above (KubeAPIService's methods already match; the extension body is empty).

`Models/LogSessionStore.swift`:

```swift
import Foundation
import Observation

/// One open log-viewing session: the streamed container of one pod.
@Observable @MainActor
final class LogSession {

    let pod: PodInfo
    let context: String?

    private(set) var containers: [ContainerInfo] = []
    private(set) var selectedContainer: String?
    private(set) var showingPrevious = false
    private(set) var buffer = LogRingBuffer(cap: 5000)
    private(set) var tailLines = 500
    private(set) var streamError: String?
    private(set) var hasCleared = false
    var isFollowing = true

    private let streamer: any PodLogStreaming
    private let defaults: UserDefaults
    private var streamTask: Task<Void, Never>?
    private var nextLineID = 0

    /// UserDefaults key remembering the last-picked container for this pod.
    private var containerMemoryKey: String { "logPanel.container.\(pod.namespace)/\(pod.name)" }

    init(pod: PodInfo, context: String?, streamer: any PodLogStreaming, defaults: UserDefaults) {
        self.pod = pod
        self.context = context
        self.streamer = streamer
        self.defaults = defaults
    }

    func start() {
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                let fetched = try await streamer.fetchPodContainers(
                    namespace: pod.namespace, pod: pod.name, inContext: context)
                self.containers = fetched
                let remembered = defaults.string(forKey: containerMemoryKey)
                let name =
                    fetched.first { $0.name == remembered }?.name ?? fetched.first?.name
                self.selectedContainer = name
                await self.stream(container: name)
            } catch is CancellationError {
            } catch {
                self.streamError = error.localizedDescription
            }
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    func switchContainer(to name: String) {
        guard name != selectedContainer else { return }
        selectedContainer = name
        defaults.set(name, forKey: containerMemoryKey)
        showingPrevious = false
        restart()
    }

    func setPrevious(_ previous: Bool) {
        guard previous != showingPrevious else { return }
        showingPrevious = previous
        if previous { isFollowing = false }
        restart()
    }

    func setTail(_ lines: Int) {
        guard lines != tailLines else { return }
        tailLines = lines
        restart()
    }

    /// Restarts the stream with a 500-line-larger tail ("load earlier").
    func loadEarlier() {
        isFollowing = false
        setTail(tailLines + 500)
    }

    func clear() {
        buffer.removeAll()
        hasCleared = true
    }

    private func restart() {
        stop()
        buffer.removeAll()
        hasCleared = false
        streamError = nil
        streamTask = Task { [weak self] in
            await self?.stream(container: self?.selectedContainer)
        }
    }

    private func stream(container: String?) async {
        do {
            if showingPrevious {
                let lines = try await streamer.fetchPreviousPodLogs(
                    namespace: pod.namespace, pod: pod.name, container: container,
                    tailLines: tailLines, inContext: context)
                for raw in lines { append(raw) }
            } else {
                let stream = try await streamer.streamPodLogs(
                    namespace: pod.namespace, pod: pod.name, container: container,
                    tailLines: tailLines, sinceTime: nil, inContext: context)
                for try await raw in stream {
                    append(raw)
                }
            }
        } catch is CancellationError {
        } catch {
            streamError = error.localizedDescription
        }
    }

    private func append(_ raw: String) {
        buffer.append(LogLine.parse(raw, id: nextLineID))
        nextLineID += 1
        if !buffer.lines.isEmpty { hasCleared = false }
    }
}

/// Shell-level owner of the log panel: the open session and panel chrome
/// state. Single-session for now; becomes multi-tab in the session-tabs PR.
@Observable @MainActor
final class LogSessionStore {

    private(set) var session: LogSession?
    var isCollapsed = false

    var showTimestamps: Bool {
        didSet { defaults.set(showTimestamps, forKey: "logPanel.showTimestamps") }
    }
    var wrapLines: Bool {
        didSet { defaults.set(wrapLines, forKey: "logPanel.wrapLines") }
    }

    private let streamer: any PodLogStreaming
    private let defaults: UserDefaults

    init(streamer: any PodLogStreaming, defaults: UserDefaults = .standard) {
        self.streamer = streamer
        self.defaults = defaults
        self.showTimestamps =
            defaults.object(forKey: "logPanel.showTimestamps") as? Bool ?? true
        self.wrapLines = defaults.bool(forKey: "logPanel.wrapLines")
    }

    /// Opens (or refocuses) the log session for `pod` and expands the panel.
    func open(pod: PodInfo, context: String?) {
        isCollapsed = false
        if let session, session.pod.id == pod.id { return }
        session?.stop()
        let new = LogSession(pod: pod, context: context, streamer: streamer, defaults: defaults)
        session = new
        new.start()
    }

    func close() {
        session?.stop()
        session = nil
    }
}
```

- [ ] **Step 4: Run** `-only-testing:cubeliteTests/LogSessionStoreTests` — expect PASS (8 tests). If a test hangs, check that `MockLogStreamer` yields before returning and that `waitUntil` polls on the main actor.

- [ ] **Step 5: Commit**

```bash
git add apps/macos/cubelite/cubelite/Services/PodLogStreaming.swift \
        apps/macos/cubelite/cubelite/Models/LogSessionStore.swift \
        apps/macos/cubelite/cubeliteTests/LogSessionStoreTests.swift
git commit -m "feat(macos): LogSessionStore — observable log session with container/previous/tail"
```

---

### Task 3: `LogPanelView` + shell integration, retire the sheet

**Files:**
- Create: `apps/macos/cubelite/cubelite/Views/LogPanel/LogPanelView.swift`
- Create: `apps/macos/cubelite/cubelite/Views/LogPanel/LogToolbar.swift`
- Create: `apps/macos/cubelite/cubelite/Views/LogPanel/LogBodyView.swift`
- Modify: `apps/macos/cubelite/cubelite/CubeliteApp.swift` (create `LogSessionStore`, inject via `.environment`)
- Modify: `apps/macos/cubelite/cubelite/Views/MainView.swift:176-229` (wrap `detailArea` in a `VStack(spacing: 0)` with `LogPanelView` under it)
- Modify: `apps/macos/cubelite/cubelite/Views/ResourceDetailView.swift:30,85,126` (Logs button → `logSessionStore.open`; delete the `.sheet(isPresented: $showLogs)` and `showLogs` state)
- Delete: `apps/macos/cubelite/cubelite/Views/PodLogsView.swift`

**Interfaces:**
- Consumes: `LogSessionStore` (Task 2), `LogLine` (Task 1), `DesignTokens`, `UnifiedErrorState`/`UnifiedLoadingState`.
- Produces: `struct LogPanelView: View` reading `LogSessionStore` from `@Environment` — renders nothing (`EmptyView`) when `session == nil`.

- [ ] **Step 1: Build the three views**

`Views/LogPanel/LogPanelView.swift`:

```swift
import SwiftUI

/// Persistent bottom log panel (single session): header strip, toolbar,
/// log body. Collapses to the 34pt strip. Hidden when no session is open.
struct LogPanelView: View {

    @Environment(LogSessionStore.self) private var store

    var body: some View {
        if let session = store.session {
            VStack(spacing: 0) {
                Rectangle().fill(DesignTokens.borderStrong).frame(height: 1)
                headerStrip(session)
                if !store.isCollapsed {
                    Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
                    LogToolbar(session: session)
                    Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
                    LogBodyView(session: session)
                        .frame(height: 280)
                }
            }
            .background(DesignTokens.surfacePanel)
        }
    }

    private func headerStrip(_ session: LogSession) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(session.pod.ready ? DesignTokens.statusOk : DesignTokens.statusWarn)
                .frame(width: 7, height: 7)
            Text(session.pod.name)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(DesignTokens.textDataBright)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: 190, alignment: .leading)
            if let container = session.selectedContainer {
                Text(container)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            Spacer()
            Text(lineCountLabel(session))
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(DesignTokens.textTertiary)
            Button {
                store.isCollapsed.toggle()
            } label: {
                Image(systemName: store.isCollapsed ? "chevron.up" : "chevron.down")
                    .font(.system(size: 10))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(store.isCollapsed ? "Expand log panel" : "Collapse log panel")
            Button {
                store.close()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close log panel")
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(DesignTokens.surfaceRaised)
    }

    private func lineCountLabel(_ session: LogSession) -> String {
        let visible = session.buffer.lines.count
        let total = session.buffer.totalAppended
        return total > visible ? "\(visible) lines · \(total) buffered" : "\(visible) lines"
    }
}
```

`Views/LogPanel/LogToolbar.swift`:

```swift
import SwiftUI

/// Log panel toolbar: stream context on the left (container, previous),
/// view controls on the right (tail, follow, overflow).
struct LogToolbar: View {

    @Environment(LogSessionStore.self) private var store
    let session: LogSession

    var body: some View {
        HStack(spacing: 8) {
            containerPicker
            if selectedContainerInfo?.restarts ?? 0 > 0 {
                previousChip
            }
            Spacer()
            tailMenu
            followButton
            overflowMenu
        }
        .padding(.horizontal, 8)
        .frame(height: 38)
    }

    private var selectedContainerInfo: ContainerInfo? {
        session.containers.first { $0.name == session.selectedContainer }
    }

    private var containerPicker: some View {
        Menu {
            let app = session.containers.filter { !$0.isInit }
            let inits = session.containers.filter(\.isInit)
            Section("Containers") {
                ForEach(app) { container in
                    containerItem(container)
                }
            }
            if !inits.isEmpty {
                Section("Init containers") {
                    ForEach(inits) { container in
                        containerItem(container)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Circle().fill(stateColor(selectedContainerInfo)).frame(width: 6, height: 6)
                Text(session.selectedContainer ?? "—")
                    .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(DesignTokens.textDataBright)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .padding(.horizontal, 8)
            .frame(height: 26)
            .background(DesignTokens.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(
                RoundedRectangle(cornerRadius: 6).stroke(DesignTokens.borderDefault, lineWidth: 1))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private func containerItem(_ container: ContainerInfo) -> some View {
        Button {
            session.switchContainer(to: container.name)
        } label: {
            if container.name == session.selectedContainer {
                Label(itemLabel(container), systemImage: "checkmark")
            } else {
                Text(itemLabel(container))
            }
        }
    }

    private func itemLabel(_ container: ContainerInfo) -> String {
        var parts = [container.name]
        if container.isSidecar { parts.append("(sidecar)") }
        if case .waiting(let reason?) = container.state { parts.append("· \(reason)") }
        if case .terminated(let reason?) = container.state { parts.append("· \(reason)") }
        if container.restarts > 0 { parts.append("· restarts \(container.restarts)") }
        return parts.joined(separator: " ")
    }

    private func stateColor(_ container: ContainerInfo?) -> Color {
        switch container?.state {
        case .running: DesignTokens.statusOk
        case .terminated: DesignTokens.textTertiary
        case .waiting, .none: DesignTokens.statusWarn
        }
    }

    private var previousChip: some View {
        Button {
            session.setPrevious(!session.showingPrevious)
        } label: {
            Label("previous", systemImage: "arrow.counterclockwise")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(
                    session.showingPrevious ? DesignTokens.accentDefault : DesignTokens.textSecondary)
                .padding(.horizontal, 8)
                .frame(height: 26)
                .background(
                    session.showingPrevious
                        ? DesignTokens.accentDefault.opacity(0.14) : DesignTokens.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(
                    RoundedRectangle(cornerRadius: 6).stroke(
                        session.showingPrevious
                            ? DesignTokens.accentDefault.opacity(0.4) : DesignTokens.borderDefault,
                        lineWidth: 1))
        }
        .buttonStyle(.plain)
        .help("Show logs from the previous container instance")
    }

    private var tailMenu: some View {
        Menu {
            ForEach([100, 500, 1000, 5000], id: \.self) { size in
                Button {
                    session.setTail(size)
                } label: {
                    if session.tailLines == size {
                        Label("last \(size)", systemImage: "checkmark")
                    } else {
                        Text("last \(size)")
                    }
                }
            }
            Divider()
            Button("load 500 earlier") { session.loadEarlier() }
        } label: {
            HStack(spacing: 4) {
                Text("tail")
                    .font(.system(size: 11))
                    .foregroundStyle(DesignTokens.textTertiary)
                Text("\(session.tailLines)")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(DesignTokens.textDataBright)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .padding(.horizontal, 8)
            .frame(height: 26)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private var followButton: some View {
        Button {
            session.isFollowing.toggle()
        } label: {
            HStack(spacing: 5) {
                Circle()
                    .fill(session.isFollowing ? DesignTokens.statusOk : DesignTokens.textTertiary)
                    .frame(width: 6, height: 6)
                Text(session.isFollowing ? "Following" : "Paused")
                    .font(.system(size: 11, weight: .medium))
            }
            .padding(.horizontal, 10)
            .frame(height: 28)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private var overflowMenu: some View {
        Menu {
            Toggle("Timestamps", isOn: Bindable(store).showTimestamps)
            Toggle("Wrap lines", isOn: Bindable(store).wrapLines)
            Divider()
            Button("Clear buffer") { session.clear() }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 11))
                .foregroundStyle(DesignTokens.textSecondary)
                .frame(width: 26, height: 28)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }
}
```

`Views/LogPanel/LogBodyView.swift`:

```swift
import SwiftUI

/// Scrollable log body: severity-colored monospaced lines with optional
/// timestamp column; autoscrolls while following; wheel-up pauses.
struct LogBodyView: View {

    @Environment(LogSessionStore.self) private var store
    let session: LogSession

    var body: some View {
        Group {
            if let error = session.streamError {
                UnifiedErrorState(title: "Log stream failed", message: error)
            } else if session.buffer.lines.isEmpty {
                emptyState
            } else {
                logList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DesignTokens.surfaceSunken)
    }

    private var emptyState: some View {
        VStack(spacing: 4) {
            Text(session.hasCleared ? "buffer cleared" : "no logs yet")
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(DesignTokens.textSecondary)
            Text(
                session.hasCleared
                    ? "stream is live — waiting for new lines"
                    : "waiting for the first line"
            )
            .font(.system(size: 11))
            .foregroundStyle(DesignTokens.textTertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var logList: some View {
        ScrollViewReader { proxy in
            ScrollView([.vertical, store.wrapLines ? [] : .horizontal].reduce([], { $0.union($1) })) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(session.buffer.lines) { line in
                        LogLineRow(
                            line: line, showTimestamp: store.showTimestamps,
                            wrap: store.wrapLines)
                    }
                }
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: session.buffer.totalAppended) {
                if session.isFollowing, let last = session.buffer.lines.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
            .onScrollPhaseChange { _, newPhase in
                // Manual scrolling while following pauses the follow.
                if newPhase == .interacting, session.isFollowing {
                    session.isFollowing = false
                }
            }
        }
    }
}

/// One rendered log line.
struct LogLineRow: View {
    let line: LogLine
    let showTimestamp: Bool
    let wrap: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            if showTimestamp {
                Text(line.time ?? "—")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
                    .frame(width: 94, alignment: .leading)
            }
            Text(levelLabel)
                .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                .foregroundStyle(levelColor)
                .frame(width: 42, alignment: .leading)
            Text(line.message)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(messageColor)
                .textSelection(.enabled)
                .lineLimit(wrap ? nil : 1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(rowTint)
        .id(line.id)
    }

    private var levelLabel: String {
        switch line.level {
        case .debug: "DEBUG"
        case .info: "INFO"
        case .warn: "WARN"
        case .error: "ERROR"
        }
    }

    private var levelColor: Color {
        switch line.level {
        case .debug: DesignTokens.textTertiary
        case .info: DesignTokens.textLog
        case .warn: DesignTokens.statusWarn
        case .error: DesignTokens.statusErr
        }
    }

    private var messageColor: Color {
        switch line.level {
        case .warn: DesignTokens.statusWarn
        case .error: DesignTokens.statusErr
        default: DesignTokens.textLog
        }
    }

    private var rowTint: Color {
        switch line.level {
        case .error: DesignTokens.statusErr.opacity(0.07)
        case .warn: DesignTokens.statusWarn.opacity(0.045)
        default: .clear
        }
    }
}
```

Adaptations allowed while building: exact `DesignTokens` member names (verify `accentDefault` vs `accent`), `onScrollPhaseChange` availability (macOS 15+ — the deployment target must support it; if not, fall back to `NSEvent` scroll-wheel monitor or drop wheel-pause with a `// TODO(PR D)` note and keep button-pause only). If `ScrollView` axes composition reads poorly, use `ScrollView(store.wrapLines ? .vertical : [.vertical, .horizontal])`.

- [ ] **Step 2: Inject the store and mount the panel**

In `CubeliteApp.swift`: create `@State private var logSessionStore = LogSessionStore(streamer: kubeAPIService)` next to the existing service creation and add `.environment(logSessionStore)` where `LogStore`/`AppSettings` are injected (match the existing pattern).

In `MainView.swift` body: wrap the existing `detailArea` (inside the HStack after rail + sidebar) as:

```swift
VStack(spacing: 0) {
    detailArea
    LogPanelView()
}
```

In `ResourceDetailView.swift`: add `@Environment(LogSessionStore.self) private var logSessionStore`; replace the Logs button action `showLogs = true` with `logSessionStore.open(pod: pod, context: context)` (keep label); delete the `@State private var showLogs` and the `.sheet(isPresented: $showLogs) { … }` block. Then delete `Views/PodLogsView.swift` (`git rm`).

- [ ] **Step 3: Full unit suite**

Run: full `xcodebuild test … -skip-testing:cubeliteUITests`
Expected: PASS, no references to `PodLogsView` remain (`grep -rn "PodLogsView" apps/macos` → empty).

- [ ] **Step 4: Manual smoke (verify skill)**

Launch the app against a live cluster if available; otherwise build-run and confirm the panel stays hidden with no session and the Logs button opens it. Confirm: navigate to another resource type — panel persists (acceptance criterion 1).

- [ ] **Step 5: Commit**

```bash
git add -A apps/macos/cubelite
git commit -m "feat(macos): persistent bottom log panel replaces the log sheet"
```

---

### Task 4: PR

- [ ] **Step 1: Push and open stacked PR**

```bash
git push -u origin feat/294-log-panel-core
gh pr create --base feat/294-pod-log-viewer \
  --title "feat(macos): persistent log panel — container picker, previous, tail, follow (#294 PR B)" \
  --body "Second stacked PR for #294 (base: PR A). Replaces the modal log sheet with the in-shell bottom panel from the design handoff.

- \`LogLine\` (+DEBUG severity) and \`LogRingBuffer\` (cap 5000) extracted as tested models
- \`LogSessionStore\`/\`LogSession\`: observable session — container switch (remembered per pod), previous-instance fetch, tail control, follow/pause, clear — behind a \`PodLogStreaming\` protocol with a scripted mock in tests
- \`LogPanelView\` + toolbar + body per Design System v1 tokens; collapse to strip; wheel-scroll pauses follow
- Logs stay open while navigating other resources (hard acceptance criterion)
- \`PodLogsView\` sheet deleted

Part of #294.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: PR URL; CI green before PR C stacks on this branch.
