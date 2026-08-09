import XCTest

@testable import cubelite

/// Scripted PodLogStreaming double: yields canned containers and lines,
/// records the query parameters of every call.
///
/// The protocol's async methods are nonisolated, so AggregatedLogStore's
/// 20-pod fan-out invokes them concurrently from the cooperative pool —
/// all mutable state is guarded by a lock (the unguarded version crashed
/// the CI test runner with a data race on `streamCalls`).
final class MockLogStreamer: PodLogStreaming, @unchecked Sendable {
    private let lock = NSLock()

    var containers: [ContainerInfo] = []
    var liveLines: [String] = []
    var previousLines: [String] = []
    /// The first N stream calls end right after yielding (dropped stream);
    /// later calls stay open like a healthy follow.
    var failFirstNStreams = 0
    /// Per-container override of `liveLines`; containers absent here fall
    /// back to the global `liveLines`. Used by merged-mode tests that need
    /// distinct lines per producer.
    var liveLinesByContainer: [String: [String]] = [:]
    /// Containers whose every stream call ends right after yielding
    /// (permanent drop), independent of `failFirstNStreams`. Used by
    /// merged-mode tests that need one producer down while others stay up.
    var failStreamsForContainers: Set<String> = []

    private var recordedStreamCalls: [(container: String?, tailLines: Int, sinceTime: String?)] =
        []
    private var recordedPreviousCalls: [(container: String?, tailLines: Int)] = []

    /// Synchronous critical section — callable from async contexts because
    /// the lock never spans a suspension point.
    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    var streamCalls: [(container: String?, tailLines: Int, sinceTime: String?)] {
        withLock { recordedStreamCalls }
    }

    var previousCalls: [(container: String?, tailLines: Int)] {
        withLock { recordedPreviousCalls }
    }

    func streamPodLogs(
        namespace: String, pod: String, container: String?, tailLines: Int,
        sinceTime: String?, inContext contextName: String?
    ) async throws -> AsyncThrowingStream<String, Error> {
        let (lines, shouldDrop) = withLock {
            recordedStreamCalls.append((container, tailLines, sinceTime))
            let containerLines = container.flatMap { liveLinesByContainer[$0] } ?? liveLines
            let isContainerDrop = container.map { failStreamsForContainers.contains($0) } ?? false
            return (containerLines, isContainerDrop || recordedStreamCalls.count <= failFirstNStreams)
        }
        return AsyncThrowingStream { continuation in
            for line in lines { continuation.yield(line) }
            if shouldDrop { continuation.finish() }
            // Otherwise leave the stream open like a real follow.
        }
    }

    func fetchPreviousPodLogs(
        namespace: String, pod: String, container: String?, tailLines: Int,
        inContext contextName: String?
    ) async throws -> [String] {
        withLock {
            recordedPreviousCalls.append((container, tailLines))
            return previousLines
        }
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

    // Async so the override inherits the class's MainActor isolation
    // (a sync setUp() override stays nonisolated and cannot touch the
    // actor-isolated fixtures on older toolchains).
    override func setUp() async throws {
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
        PodInfo(
            name: name, namespace: "default", phase: "Running", ready: true, restarts: 0,
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
        try await waitUntil { self.store.activeSession?.buffer.lines.count == 1 }
        XCTAssertEqual(store.activeSession?.containers.map(\.name), ["worker", "envoy"])
        XCTAssertEqual(store.activeSession?.selectedContainer, "worker")
        XCTAssertEqual(streamer.streamCalls.first?.container, "worker")
        XCTAssertEqual(streamer.streamCalls.first?.tailLines, 500)
        XCTAssertEqual(store.activeSession?.buffer.lines.first?.message, "hello")
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
        try await waitUntil { self.store.activeSession?.selectedContainer != nil }
        store.activeSession?.switchContainer(to: "envoy")
        try await waitUntil { self.streamer.streamCalls.count == 2 }
        store.closeAll()
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.selectedContainer != nil }
        XCTAssertEqual(store.activeSession?.selectedContainer, "envoy")
    }

    func testSwitchContainer_restartsStreamAndClearsBuffer() async throws {
        streamer.containers = [makeContainer("worker"), makeContainer("envoy")]
        streamer.liveLines = ["2026-07-15T10:00:00Z from-worker"]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.buffer.lines.count == 1 }
        store.activeSession?.switchContainer(to: "envoy")
        try await waitUntil { self.streamer.streamCalls.count == 2 }
        XCTAssertEqual(streamer.streamCalls.last?.container, "envoy")
    }

    func testTogglePrevious_fetchesStaticLines() async throws {
        streamer.containers = [makeContainer("worker", restarts: 3)]
        streamer.previousLines = ["2026-07-15T09:00:00Z old line"]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.selectedContainer != nil }
        store.activeSession?.setPrevious(true)
        try await waitUntil { self.store.activeSession?.buffer.lines.count == 1 }
        XCTAssertEqual(streamer.previousCalls.count, 1)
        XCTAssertEqual(store.activeSession?.buffer.lines.first?.message, "old line")
        XCTAssertEqual(store.activeSession?.isFollowing, false)
    }

    func testSetTail_restartsStreamWithNewTail() async throws {
        streamer.containers = [makeContainer("worker")]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { !self.streamer.streamCalls.isEmpty }
        store.activeSession?.setTail(1000)
        try await waitUntil { self.streamer.streamCalls.count == 2 }
        XCTAssertEqual(streamer.streamCalls.last?.tailLines, 1000)
    }

    func testClear_emptiesBufferKeepsStreaming() async throws {
        streamer.containers = [makeContainer("worker")]
        streamer.liveLines = ["2026-07-15T10:00:00Z hello"]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.buffer.lines.count == 1 }
        store.activeSession?.clear()
        XCTAssertEqual(store.activeSession?.buffer.lines.count, 0)
        XCTAssertEqual(store.activeSession?.hasCleared, true)
    }

    func testClose_cancelsSession() async throws {
        streamer.containers = [makeContainer("worker")]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession != nil }
        store.closeAll()
        XCTAssertNil(store.activeSession)
        XCTAssertTrue(store.sessions.isEmpty)
    }

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

    // MARK: - Reconnect

    func testStreamDrop_entersReconnectingAndRecovers() async throws {
        streamer.containers = [makeContainer("worker")]
        streamer.liveLines = ["2026-07-15T10:00:00Z hello"]
        streamer.failFirstNStreams = 1
        store = LogSessionStore(streamer: streamer, defaults: defaults, backoffBase: 0.02)
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.streamer.streamCalls.count >= 2 }
        let session = try XCTUnwrap(store.activeSession)
        // Second stream yields a line → the attempt counter resets.
        try await waitUntil { session.reconnectAttempt == 0 }
        XCTAssertNil(session.streamError)
    }

    func testReconnect_passesSinceTimeOfLastLine() async throws {
        streamer.containers = [makeContainer("worker")]
        streamer.liveLines = ["2026-07-15T10:00:00Z hello"]
        streamer.failFirstNStreams = 1
        store = LogSessionStore(streamer: streamer, defaults: defaults, backoffBase: 0.02)
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.streamer.streamCalls.count >= 2 }
        XCTAssertNil(streamer.streamCalls[0].sinceTime)
        XCTAssertEqual(streamer.streamCalls[1].sinceTime, "2026-07-15T10:00:00Z")
    }

    func testRetryNow_shortcutsBackoff() async throws {
        streamer.containers = [makeContainer("worker")]
        streamer.failFirstNStreams = 1
        // 5s base backoff: without retryNow the second call would not arrive
        // within the polling window.
        store = LogSessionStore(streamer: streamer, defaults: defaults, backoffBase: 5)
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.isReconnecting == true }
        store.activeSession?.retryNow()
        try await waitUntil { self.streamer.streamCalls.count >= 2 }
        XCTAssertEqual(streamer.streamCalls.count, 2)
    }

    // MARK: - Merged all-containers mode

    private func mergedContainerKey(pod name: String = "web-1") -> String {
        "logPanel.container.default/\(name)"
    }

    func testMergedMode_opensOneStreamPerContainer_initIncluded() async throws {
        streamer.containers = [
            makeContainer("worker"), makeContainer("envoy"),
            makeContainer("init-migrate", isInit: true),
        ]
        defaults.set(LogSession.allContainers, forKey: mergedContainerKey())
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.streamer.streamCalls.count == 3 }
        XCTAssertEqual(store.activeSession?.selectedContainer, LogSession.allContainers)
        XCTAssertEqual(store.activeSession?.isMerged, true)
        XCTAssertEqual(
            Set(streamer.streamCalls.compactMap(\.container)),
            Set(["worker", "envoy", "init-migrate"]))
    }

    func testMergedMode_interleavesTaggedLinesIntoOneBuffer() async throws {
        streamer.containers = [
            makeContainer("worker"), makeContainer("envoy"),
            makeContainer("init-migrate", isInit: true),
        ]
        streamer.liveLinesByContainer = [
            "worker": ["2026-07-15T10:00:00Z from-worker"],
            "envoy": ["2026-07-15T10:00:01Z from-envoy"],
            "init-migrate": ["2026-07-15T10:00:02Z from-init"],
        ]
        defaults.set(LogSession.allContainers, forKey: mergedContainerKey())
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.buffer.lines.count == 3 }
        let lines = try XCTUnwrap(store.activeSession?.buffer.lines)
        XCTAssertEqual(Set(lines.compactMap(\.container)), Set(["worker", "envoy", "init-migrate"]))
        for line in lines {
            switch line.message {
            case "from-worker": XCTAssertEqual(line.container, "worker")
            case "from-envoy": XCTAssertEqual(line.container, "envoy")
            case "from-init": XCTAssertEqual(line.container, "init-migrate")
            default: XCTFail("unexpected line \(line.message)")
            }
        }
        let ids = lines.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "ids must be unique")
        XCTAssertEqual(ids, ids.sorted(), "ids must be assigned in increasing append order")
    }

    func testMergedMode_isReconnectingOnlyWhenAllStreamsDown() async throws {
        streamer.containers = [
            makeContainer("worker"), makeContainer("envoy"),
            makeContainer("init-migrate", isInit: true),
        ]
        streamer.failStreamsForContainers = ["envoy"]
        defaults.set(LogSession.allContainers, forKey: mergedContainerKey())
        store = LogSessionStore(streamer: streamer, defaults: defaults, backoffBase: 0.02)
        store.open(pod: makePod(), context: nil)
        try await waitUntil {
            Set(self.streamer.streamCalls.compactMap(\.container))
                .isSuperset(of: ["worker", "envoy", "init-migrate"])
        }
        let session = try XCTUnwrap(store.activeSession)
        try await waitUntil { session.reconnectAttempt > 0 }
        XCTAssertFalse(session.isReconnecting)

        // Fresh session where every container's stream is doomed: now the
        // merged session as a whole must report reconnecting.
        let streamer2 = MockLogStreamer()
        streamer2.containers = streamer.containers
        streamer2.failStreamsForContainers = ["worker", "envoy", "init-migrate"]
        defaults.set(LogSession.allContainers, forKey: mergedContainerKey(pod: "web-2"))
        let store2 = LogSessionStore(streamer: streamer2, defaults: defaults, backoffBase: 0.02)
        store2.open(pod: makePod("web-2"), context: nil)
        try await waitUntil { store2.activeSession?.isReconnecting == true }
    }

    func testMergedMode_retryNowFansOut() async throws {
        streamer.containers = [
            makeContainer("worker"), makeContainer("envoy"),
            makeContainer("init-migrate", isInit: true),
        ]
        streamer.failStreamsForContainers = ["worker", "envoy", "init-migrate"]
        defaults.set(LogSession.allContainers, forKey: mergedContainerKey())
        // 5s base backoff: without retryNow the follow-up calls would not
        // arrive within the polling window.
        store = LogSessionStore(streamer: streamer, defaults: defaults, backoffBase: 5)
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.isReconnecting == true }
        XCTAssertEqual(streamer.streamCalls.count, 3)
        store.activeSession?.retryNow()
        try await waitUntil { self.streamer.streamCalls.count >= 6 }
        XCTAssertEqual(streamer.streamCalls.count, 6)
    }

    func testMergedMode_setPreviousIsNoOp() async throws {
        streamer.containers = [makeContainer("worker"), makeContainer("envoy")]
        defaults.set(LogSession.allContainers, forKey: mergedContainerKey())
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.isMerged == true }
        store.activeSession?.setPrevious(true)
        XCTAssertEqual(store.activeSession?.showingPrevious, false)
    }

    func testSwitchToMergedClearsPrevious() async throws {
        streamer.containers = [makeContainer("worker", restarts: 2), makeContainer("envoy")]
        streamer.previousLines = ["2026-07-15T09:00:00Z old"]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.selectedContainer != nil }
        store.activeSession?.setPrevious(true)
        try await waitUntil { self.store.activeSession?.showingPrevious == true }
        store.activeSession?.switchContainer(to: LogSession.allContainers)
        try await waitUntil { self.store.activeSession?.isMerged == true }
        XCTAssertEqual(store.activeSession?.showingPrevious, false)
    }

    func testMergedSelectionPersistsInDefaults() async throws {
        streamer.containers = [makeContainer("worker"), makeContainer("envoy")]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.selectedContainer != nil }
        store.activeSession?.switchContainer(to: LogSession.allContainers)
        try await waitUntil { self.store.activeSession?.isMerged == true }
        XCTAssertEqual(defaults.string(forKey: mergedContainerKey()), LogSession.allContainers)
        store.closeAll()
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.selectedContainer != nil }
        XCTAssertEqual(store.activeSession?.isMerged, true)
    }

    /// Populates the buffer directly rather than through 3 concurrent mock
    /// streams: driving 6000 lines through real streaming is unnecessarily
    /// slow/flaky for a test whose only concern is the shared ring buffer's
    /// cap and total-appended bookkeeping under merged mode's central
    /// `append`, which is exactly what every real producer funnels through.
    func testMergedMode_ringBoundUnderThreeProducers() async throws {
        streamer.containers = [
            makeContainer("worker"), makeContainer("envoy"),
            makeContainer("init-migrate", isInit: true),
        ]
        defaults.set(LogSession.allContainers, forKey: mergedContainerKey())
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.isMerged == true }
        let session = try XCTUnwrap(store.activeSession)
        for i in 0..<6000 {
            session.simulateAppendForTesting("2026-07-15T10:00:00Z line-\(i)")
        }
        XCTAssertEqual(session.buffer.lines.count, 5000)
        XCTAssertEqual(session.buffer.totalAppended, 6000)
    }

    func testSearchQuerySurvivesMergedSwitch() async throws {
        streamer.containers = [makeContainer("worker"), makeContainer("envoy")]
        streamer.liveLines = ["2026-07-15T10:00:00Z boring line"]
        store.open(pod: makePod(), context: nil)
        try await waitUntil { self.store.activeSession?.buffer.lines.count == 1 }
        let session = try XCTUnwrap(store.activeSession)
        session.search.query = "err"
        session.search.recompute(over: session.buffer.lines)
        XCTAssertEqual(session.search.matchingLineIDs.count, 0)

        session.switchContainer(to: LogSession.allContainers)
        try await waitUntil { session.isMerged == true }
        XCTAssertEqual(session.search.query, "err")
        session.search.recompute(over: session.buffer.lines)
        XCTAssertEqual(session.search.matchingLineIDs.count, 0)

        session.simulateAppendForTesting("2026-07-15T10:00:01Z error happened")
        session.search.recompute(over: session.buffer.lines)
        XCTAssertGreaterThan(session.search.matchingLineIDs.count, 0)
    }
}
