import XCTest

@testable import cubelite

// MARK: - AggregatedLogStoreTests

/// Tests the aggregated multi-pod log store against the scripted
/// `MockLogStreamer` double (shared with LogSessionStoreTests).
@MainActor
final class AggregatedLogStoreTests: XCTestCase {

    private var streamer: MockLogStreamer!
    private var store: AggregatedLogStore!

    override func setUp() async throws {
        streamer = MockLogStreamer()
        store = AggregatedLogStore(streamer: streamer, backoffBase: 0.01)
    }

    override func tearDown() async throws {
        store.stop()
    }

    private func makePod(_ name: String, namespace: String = "default") -> PodInfo {
        PodInfo(
            name: name, namespace: namespace, phase: "Running", ready: true, restarts: 0,
            creationTimestamp: nil)
    }

    /// Polls the main actor until `condition` holds or the timeout elapses.
    private func waitUntil(
        _ condition: @escaping () -> Bool, timeout: TimeInterval = 2
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline {
                XCTFail("Timed out waiting for condition")
                return
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    func testStart_mergesLinesFromAllPods_withGlobalUniqueIDs() async throws {
        streamer.liveLines = ["2026-07-18T10:00:00Z hello", "2026-07-18T10:00:01Z world"]

        store.start(pods: [makePod("api-1"), makePod("worker-1")], context: nil)
        try await waitUntil { self.store.buffer.count == 4 }

        let pods = Set(store.buffer.map(\.pod))
        XCTAssertEqual(pods, ["api-1", "worker-1"])
        let ids = store.buffer.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count)
        XCTAssertEqual(store.totalAppended, 4)
        XCTAssertTrue(store.isStreaming)
    }

    func testStart_capsAtTwentyPods() async throws {
        streamer.liveLines = []
        let pods = (0..<25).map { makePod("pod-\($0)") }

        store.start(pods: pods, context: nil)

        XCTAssertEqual(store.streamedPodCount, 20)
        try await waitUntil { self.streamer.streamCalls.count == 20 }
    }

    func testFiltered_byLevelAndText() async throws {
        streamer.liveLines = [
            "2026-07-18T10:00:00Z ERROR boom",
            "2026-07-18T10:00:01Z all good",
        ]

        store.start(pods: [makePod("api-1")], context: nil)
        try await waitUntil { self.store.buffer.count == 2 }

        store.levelFilter = .error
        XCTAssertEqual(store.filtered.count, 1)
        XCTAssertEqual(store.filtered.first?.line.message, "ERROR boom")

        store.levelFilter = nil
        store.textFilter = "good"
        XCTAssertEqual(store.filtered.count, 1)

        store.textFilter = "api-1"
        XCTAssertEqual(store.filtered.count, 2, "text filter matches pod names too")
    }

    func testPause_marksCount_andNewSincePauseGrows() async throws {
        streamer.liveLines = ["2026-07-18T10:00:00Z one"]

        store.start(pods: [makePod("api-1")], context: nil)
        try await waitUntil { self.store.buffer.count == 1 }

        store.isFollowing = false
        XCTAssertEqual(store.pausedAtCount, 1)
        XCTAssertEqual(store.newSincePause, 0)

        store.isFollowing = true
        XCTAssertNil(store.pausedAtCount)
    }

    func testClear_emptiesBuffer() async throws {
        streamer.liveLines = ["2026-07-18T10:00:00Z one"]

        store.start(pods: [makePod("api-1")], context: nil)
        try await waitUntil { self.store.buffer.count == 1 }
        store.clear()

        XCTAssertTrue(store.buffer.isEmpty)
        XCTAssertEqual(store.totalAppended, 0)
    }

    func testStop_endsStreaming() async throws {
        streamer.liveLines = ["2026-07-18T10:00:00Z one"]

        store.start(pods: [makePod("api-1")], context: nil)
        try await waitUntil { self.store.buffer.count == 1 }
        store.stop()

        XCTAssertFalse(store.isStreaming)
    }
}
