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
}
