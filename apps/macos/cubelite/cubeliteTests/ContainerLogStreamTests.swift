import XCTest

@testable import cubelite

@MainActor
final class ContainerLogStreamTests: XCTestCase {

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

    func testForwardsTaggedLines() async throws {
        let mock = MockLogStreamer()
        mock.liveLines = ["2026-08-09T00:00:00Z hello"]
        var got: [(String, String?)] = []
        let stream = ContainerLogStream(
            pod: makePod(), context: nil, container: "envoy",
            streamer: mock, backoffBase: 5,
            tailLines: { 500 },
            onLine: { raw, container in got.append((raw, container)) })
        stream.start()
        try await waitUntil { !got.isEmpty }
        XCTAssertEqual(got.first?.1, "envoy")
        stream.stop()
    }

    func testBackoffExposesRetrySeconds() async throws {
        let mock = MockLogStreamer()
        mock.failFirstNStreams = 1
        let stream = ContainerLogStream(
            pod: makePod(), context: nil, container: "worker",
            streamer: mock, backoffBase: 5, tailLines: { 500 }, onLine: { _, _ in })
        stream.start()
        try await waitUntil { stream.reconnectAttempt == 1 }
        XCTAssertTrue(stream.isInBackoff)
        XCTAssertGreaterThanOrEqual(stream.nextRetrySeconds, 1)
        stream.stop()
    }

    func testRetryNowShortcutsBackoff() async throws {
        let mock = MockLogStreamer()
        mock.failFirstNStreams = 1
        mock.liveLines = ["2026-08-09T00:00:00Z back"]
        var got = 0
        let stream = ContainerLogStream(
            pod: makePod(), context: nil, container: "worker",
            streamer: mock, backoffBase: 30, tailLines: { 500 },
            onLine: { _, _ in got += 1 })
        stream.start()
        try await waitUntil { stream.isInBackoff }
        stream.retryNow()
        try await waitUntil { got > 0 }
        stream.stop()
    }

    /// A TERMINATED container (init containers in merged mode): kubelet
    /// closes the follow stream right after replaying it, and `sinceTime`
    /// is inclusive, so every reconnect re-receives the exact same last
    /// line. That must not be appended again, and must not reset the
    /// backoff — otherwise a dead container reconnects forever at the base
    /// interval instead of backing off toward the cap.
    func testReconnectReplayedLastLine_noDuplicateAndAttemptKeepsGrowing() async throws {
        let mock = MockLogStreamer()
        mock.liveLines = ["2026-08-09T00:00:00Z last line"]
        mock.failStreamsForContainers = ["init"]
        var got: [String] = []
        let stream = ContainerLogStream(
            pod: makePod(), context: nil, container: "init",
            streamer: mock, backoffBase: 0.02, tailLines: { 500 },
            onLine: { raw, _ in got.append(raw) })
        stream.start()
        try await waitUntil { !got.isEmpty }
        XCTAssertEqual(got.count, 1)
        try await waitUntil { stream.reconnectAttempt >= 2 }
        let attemptAfterTwo = stream.reconnectAttempt
        try await waitUntil { stream.reconnectAttempt > attemptAfterTwo }
        XCTAssertEqual(got.count, 1, "the replayed last line must not be appended again")
        stream.stop()
    }

    /// Once a reconnect actually yields fresh content (not a replay of the
    /// last-seen line), it must be appended and the backoff must reset —
    /// otherwise a container that only ever glitched briefly would stay
    /// stuck reporting reconnecting.
    func testReconnectWithGenuinelyNewLine_appendsAndResetsAttempt() async throws {
        let mock = MockLogStreamer()
        mock.failFirstNStreams = 1
        mock.linesForCall = [2: ["2026-08-09T00:00:01Z fresh line"]]
        var got: [String] = []
        let stream = ContainerLogStream(
            pod: makePod(), context: nil, container: "worker",
            streamer: mock, backoffBase: 0.02, tailLines: { 500 },
            onLine: { raw, _ in got.append(raw) })
        stream.start()
        try await waitUntil { stream.reconnectAttempt >= 1 }
        try await waitUntil { !got.isEmpty }
        XCTAssertEqual(got, ["2026-08-09T00:00:01Z fresh line"])
        try await waitUntil { stream.reconnectAttempt == 0 }
        stream.stop()
    }
}
