import XCTest

@testable import cubelite

/// Scripted history pages; records every query.
private final class StubSearcher: LogHistorySearching, @unchecked Sendable {
    private let lock = NSLock()
    private var pages: [Result<HistoryPage, Error>]
    private var recorded: [HistoryQuery] = []
    private var closedCursors: [HistoryCursor] = []

    init(_ pages: [Result<HistoryPage, Error>]) { self.pages = pages }

    var queries: [HistoryQuery] { lock.withLock { recorded } }
    var closed: [HistoryCursor] { lock.withLock { closedCursors } }

    func closeCursor(context: String, endpoint: EsEndpoint, cursor: HistoryCursor) async {
        lock.withLock { closedCursors.append(cursor) }
    }

    /// Waits for `count` released cursors (releases run in their own task).
    func waitForClosed(_ count: Int) async {
        for _ in 0..<200 where closed.count < count {
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    func search(context: String, endpoint: EsEndpoint, query: HistoryQuery) async throws
        -> HistoryPage
    {
        let next = lock.withLock { () -> Result<HistoryPage, Error> in
            recorded.append(query)
            return pages.isEmpty ? .success(page([])) : pages.removeFirst()
        }
        return try next.get()
    }
}

/// Newest-first page of `messages`, with a cursor (on point in time `pit`) when `more`.
private func page(
    _ messages: [String], total: Int? = nil, more: Bool = false, pit: String? = nil
) -> HistoryPage {
    HistoryPage(
        lines: messages.enumerated().map { n, text in
            HistoryLine(
                time: "2026-11-03T08:00:0\(n)Z", level: .info, message: text, container: "web",
                document: #"{"message":"\#(text)"}"#)
        },
        total: total ?? messages.count, totalIsLowerBound: false,
        next: more ? HistoryCursor(pitID: pit, sort: [.number("1"), .number("2")]) : nil)
}

@MainActor
final class LogHistoryTests: XCTestCase {

    private let endpoint = EsEndpoint(
        target: .external(url: "https://es.example"), kibanaURL: "https://kb.example")

    private func history(
        _ searcher: StubSearcher, endpoint: EsEndpoint? = nil, container: String? = "web"
    ) -> LogHistory {
        let configured = endpoint ?? self.endpoint
        return LogHistory(
            context: "prod", namespace: "shop", pod: "api-0", endpoint: { configured },
            container: { container }, searcher: searcher)
    }

    func testReloadShowsOldestFirstWithHistoryIDs() async {
        let searcher = StubSearcher([.success(page(["newest", "older"], total: 1234, more: true))])
        let h = history(searcher)
        h.text = "  timeout  "
        await h.reload()
        XCTAssertEqual(h.lines.map(\.message), ["older", "newest"])
        XCTAssertTrue(h.lines.allSatisfy { $0.id >= LogHistory.idBase })
        XCTAssertEqual(h.lines.last?.document, #"{"message":"newest"}"#)
        XCTAssertEqual(h.lines.last?.time, "08:00:00Z")
        XCTAssertEqual(h.lines.last?.timestamp, "2026-11-03T08:00:00Z")
        XCTAssertEqual(h.statusText, "1,234 hits · showing 2 · 1 h")
        XCTAssertEqual(h.loads, 1)
        XCTAssertTrue(h.canLoadOlder)
        let query = try? XCTUnwrap(searcher.queries.first)
        XCTAssertEqual(query?.text, "timeout")
        XCTAssertEqual(query?.from, "now-1h")
        XCTAssertEqual(query?.container, "web")
        XCTAssertNil(query?.searchAfter)
    }

    func testLoadOlderPrependsWithTheCursorAndFirstPageParameters() async {
        let searcher = StubSearcher([
            .success(page(["b", "a"], more: true)), .success(page(["y", "x"])),
        ])
        let h = history(searcher)
        await h.reload()
        h.range = .last7d  // edited, not submitted: the cursor keeps the 1 h search
        await h.loadOlder()
        XCTAssertEqual(h.lines.map(\.message), ["x", "y", "a", "b"])
        XCTAssertNil(h.next)
        XCTAssertFalse(h.canLoadOlder)
        XCTAssertEqual(
            searcher.queries.last?.searchAfter,
            HistoryCursor(pitID: nil, sort: [.number("1"), .number("2")]))
        XCTAssertEqual(searcher.queries.last?.from, "now-1h")
        XCTAssertEqual(Set(h.lines.map(\.id)).count, 4, "ids stay unique")
    }

    func testErrorsAndMissingEndpointAreShown() async {
        let failing = history(StubSearcher([.failure(ElasticError.http(status: 401, reason: "nope"))]))
        await failing.reload()
        XCTAssertEqual(failing.error, "Elasticsearch returned 401: nope")
        XCTAssertFalse(failing.isLoading)

        let unset = LogHistory(
            context: "prod", namespace: "shop", pod: "api-0", endpoint: { nil },
            container: { nil }, searcher: StubSearcher([]))
        await unset.reload()
        XCTAssertTrue(unset.error?.contains("No Elasticsearch endpoint") ?? false)
        XCTAssertTrue(unset.lines.isEmpty)
    }

    func testKibanaURLFollowsTheShownSearch() async {
        let h = history(StubSearcher([]), container: nil)
        h.range = .last24h
        let shown = try? XCTUnwrap(h.kibanaURL(shown: true)?.absoluteString.removingPercentEncoding)
        XCTAssertTrue(shown?.hasPrefix("https://kb.example/app/discover#/?_g=(time:(from:'now-24h'") ?? false)
        XCTAssertFalse(shown?.contains("container") ?? true)
        let live = h.kibanaURL(shown: false)?.absoluteString.removingPercentEncoding
        XCTAssertTrue(live?.contains("from:'now-1h'") ?? false, "Live opens the last hour")

        var noKibana = endpoint
        noKibana.kibanaURL = nil
        XCTAssertNil(history(StubSearcher([]), endpoint: noKibana).kibanaURL(shown: true))
        noKibana.kibanaURL = "javascript:alert(1)"
        XCTAssertNil(history(StubSearcher([]), endpoint: noKibana).kibanaURL(shown: true))
    }

    func testAFailedReloadDropsTheOldCursor() async {
        let h = history(
            StubSearcher([.success(page(["a"], more: true)), .failure(ElasticError.connect("down"))]))
        await h.reload()
        XCTAssertNotNil(h.next)
        await h.reload()
        XCTAssertNil(h.next, "the cursor belonged to the previous search")
        XCTAssertFalse(h.canLoadOlder)
        h.reset()
        XCTAssertFalse(h.started)
        XCTAssertTrue(h.lines.isEmpty)
        XCTAssertNil(h.error)
    }

    func testPagingKeepsThePointInTimeAndReplacingOrClosingReleasesIt() async {
        let searcher = StubSearcher([
            .success(page(["b"], more: true, pit: "pit-a")),
            .success(page(["a"], more: true, pit: "pit-b")),
            .success(page(["z"], more: true, pit: "pit-c")),
        ])
        let h = history(searcher)
        await h.reload()
        await h.loadOlder()
        XCTAssertEqual(searcher.queries.last?.searchAfter?.pitID, "pit-a", "cursor passed untouched")
        XCTAssertEqual(h.next?.pitID, "pit-b", "the latest PIT id")
        XCTAssertTrue(searcher.closed.isEmpty, "paging keeps the PIT open")
        h.text = "timeout"
        await h.reload()
        await searcher.waitForClosed(1)
        XCTAssertEqual(searcher.closed.map(\.pitID), ["pit-b"], "a new query releases the old PIT")
        h.close()
        await searcher.waitForClosed(2)
        XCTAssertEqual(searcher.closed.last?.pitID, "pit-c")
        XCTAssertNil(h.next)
    }

    func testCursorsWithoutAPointInTimeNeedNoRelease() async {
        let searcher = StubSearcher([.success(page(["b"], more: true))])
        let h = history(searcher)
        await h.reload()
        h.reset()
        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(searcher.closed.isEmpty)
    }

    func testEndpointStorePersistsPerContext() {
        let suite = "ElasticEndpointStoreTests"
        guard let defaults = UserDefaults(suiteName: suite) else { return XCTFail("defaults") }
        defaults.removePersistentDomain(forName: suite)
        let store = ElasticEndpointStore(defaults: defaults)
        store.setEndpoint(endpoint, for: "prod")
        XCTAssertEqual(ElasticEndpointStore(defaults: defaults).endpoint(for: "prod"), endpoint)
        XCTAssertNil(store.endpoint(for: "dev"))
        XCTAssertNil(store.endpoint(for: nil))
        store.setEndpoint(nil, for: "prod")
        XCTAssertNil(ElasticEndpointStore(defaults: defaults).endpoint(for: "prod"))
    }

    func testECSAndJSONModesUseTheStoredDocument() {
        let line = LogLine(
            id: 1, time: nil, level: .info, message: "hello", container: nil,
            document: #"{"message":"hello","service":{"name":"api"}}"#)
        let ecs = ECSDocument.make(line: line, metadata: ECSDocument.Metadata(namespace: "shop", pod: "api-0"))
        XCTAssertTrue(ecs.compactJSON.contains(#""service":{"name":"api"}"#), ecs.compactJSON)
        XCTAssertNotNil(JSONLogView.parse(line.structuredText))
    }
}

@MainActor
final class LogSessionHistoryTests: XCTestCase {

    private func pod() -> PodInfo {
        PodInfo(
            name: "api-0", namespace: "shop", phase: "Running", ready: true, restarts: 0,
            creationTimestamp: nil)
    }

    private func store(
        _ searcher: StubSearcher, endpoint: EsEndpoint?, kibana: (any KibanaForwarding)? = nil
    ) -> (
        LogSessionStore, ElasticEndpointStore
    ) {
        let suite = "LogSessionHistoryTests"
        let defaults = UserDefaults(suiteName: suite) ?? .standard
        defaults.removePersistentDomain(forName: suite)
        let endpoints = ElasticEndpointStore(defaults: defaults)
        if let endpoint { endpoints.setEndpoint(endpoint, for: "prod") }
        let streamer = MockLogStreamer()
        return (
            LogSessionStore(
                streamer: streamer, defaults: defaults,
                elastic: LogHistoryAccess(searcher: searcher, endpoints: endpoints, kibana: kibana)),
            endpoints
        )
    }

    func testHistoryKeepsTheLiveBufferAndLoadsOnFirstSwitch() async throws {
        let searcher = StubSearcher([.success(page(["from es"]))])
        let (logs, _) = store(searcher, endpoint: EsEndpoint(target: .external(url: "https://es.example")))
        logs.open(pod: pod(), context: "prod")
        let session = try XCTUnwrap(logs.activeSession)
        session.simulateAppendForTesting("2026-11-03T08:00:00Z live line")
        XCTAssertNotNil(session.historyEndpoint)

        session.setSource(.history)
        let deadline = Date().addingTimeInterval(2)
        while session.history?.loads == 0, Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(session.displayedLines.map(\.message), ["from es"])
        XCTAssertEqual(session.buffer.lines.map(\.message), ["live line"], "live buffer intact")

        session.setSource(.live)
        XCTAssertEqual(session.displayedLines.map(\.message), ["live line"])
        session.setSource(.history)
        XCTAssertEqual(searcher.queries.count, 1, "switching back does not search again")
        logs.closeAll()
    }

    private func waitFor(_ condition: @escaping () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(2)
        while !condition(), Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    func testFilterSearchFollowsHistoryPages() async throws {
        let searcher = StubSearcher([
            .success(page(["error one", "ok"])), .success(page(["error two", "fine"])),
        ])
        let (logs, _) = store(searcher, endpoint: EsEndpoint(target: .external(url: "https://es.example")))
        logs.open(pod: pod(), context: "prod")
        let session = try XCTUnwrap(logs.activeSession)
        session.search.query = "error"
        session.search.filterMode = true
        session.setSource(.history)
        try await waitFor { session.history?.loads == 1 }
        XCTAssertEqual(
            session.search.visibleLines(from: session.displayedLines).map(\.message), ["error one"])
        await session.history?.reload()
        XCTAssertEqual(
            session.search.visibleLines(from: session.displayedLines).map(\.message), ["error two"],
            "same count, new ids: matches recomputed")
        logs.closeAll()
    }

    func testHistoryFollowsTheContainerAndEndpointChanges() async throws {
        let searcher = StubSearcher([])
        let (logs, endpoints) = store(
            searcher, endpoint: EsEndpoint(target: .external(url: "https://es.example")))
        logs.open(pod: pod(), context: "prod")
        let session = try XCTUnwrap(logs.activeSession)
        session.setSource(.history)
        try await waitFor { searcher.queries.count == 1 }
        session.setSource(.live)
        session.switchContainer(to: "sidecar")
        try await waitFor { searcher.queries.count == 2 }
        XCTAssertEqual(searcher.queries.last?.container, "sidecar", "reloaded while Live")

        session.setSource(.history)
        endpoints.setEndpoint(nil, for: "prod")
        session.historyEndpointChanged()
        XCTAssertEqual(session.source, .live)
        XCTAssertEqual(session.history?.started, false)
        logs.closeAll()
    }

    func testKibanaOpensTheURLOrForwardsToTheService() async throws {
        actor Forwarder: KibanaForwarding {
            var calls: [KibanaService] = []
            func kibanaForward(context: String, service: KibanaService) async throws -> UInt16 {
                calls.append(service)
                return 45601
            }
        }
        let service = KibanaService(namespace: "logging", service: "quickstart-kb-http", port: 5601, https: true)
        let forwarder = Forwarder()
        let inCluster = EsEndpoint(
            target: .inCluster(namespace: "logging", service: "quickstart-es-http", port: 9200, https: true),
            kibanaService: service)
        let (logs, endpoints) = store(StubSearcher([]), endpoint: inCluster, kibana: forwarder)
        logs.open(pod: pod(), context: "prod")
        let session = try XCTUnwrap(logs.activeSession)
        XCTAssertTrue(session.canOpenKibana)
        let forwarded = try await session.kibanaDiscoverURL()
        XCTAssertTrue(
            forwarded?.absoluteString.hasPrefix("https://127.0.0.1:45601/app/discover#/") ?? false,
            "\(String(describing: forwarded))")
        let calls = await forwarder.calls
        XCTAssertEqual(calls, [service])

        var withURL = inCluster
        withURL.kibanaURL = "https://kb.example"
        endpoints.setEndpoint(withURL, for: "prod")
        let configured = try await session.kibanaDiscoverURL()
        XCTAssertTrue(configured?.absoluteString.hasPrefix("https://kb.example/") ?? false, "the URL wins")
        let after = await forwarder.calls
        XCTAssertEqual(after.count, 1)

        var neither = inCluster
        neither.kibanaService = nil
        endpoints.setEndpoint(neither, for: "prod")
        XCTAssertFalse(session.canOpenKibana)
        logs.closeAll()
    }

    func testNoEndpointHidesHistory() throws {
        let (logs, endpoints) = store(StubSearcher([]), endpoint: nil)
        logs.open(pod: pod(), context: "prod")
        let session = try XCTUnwrap(logs.activeSession)
        XCTAssertNil(session.historyEndpoint)
        session.setSource(.history)
        XCTAssertFalse(session.showsHistory, "nothing to show without an endpoint")
        endpoints.setEndpoint(EsEndpoint(target: .external(url: "https://es.example")), for: "prod")
        XCTAssertTrue(session.showsHistory)
        logs.closeAll()
    }
}
