import XCTest

@testable import cubelite

/// Scripted history pages; records every query.
private final class StubSearcher: LogHistorySearching, @unchecked Sendable {
    private let lock = NSLock()
    private var pages: [Result<HistoryPage, Error>]
    private var recorded: [HistoryQuery] = []

    init(_ pages: [Result<HistoryPage, Error>]) { self.pages = pages }

    var queries: [HistoryQuery] { lock.withLock { recorded } }

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

/// Newest-first page of `messages`, with a cursor when `more`.
private func page(_ messages: [String], total: Int? = nil, more: Bool = false) -> HistoryPage {
    HistoryPage(
        lines: messages.enumerated().map { n, text in
            HistoryLine(
                time: "2026-11-03T08:00:0\(n)Z", level: .info, message: text, container: "web",
                document: #"{"message":"\#(text)"}"#)
        },
        total: total ?? messages.count, totalIsLowerBound: false,
        next: more ? [.number("1"), .number("2")] : nil)
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
        XCTAssertEqual(searcher.queries.last?.searchAfter, [.number("1"), .number("2")])
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
        let before = try? XCTUnwrap(h.kibanaURL?.absoluteString.removingPercentEncoding)
        XCTAssertTrue(before?.hasPrefix("https://kb.example/app/discover#/?_g=(time:(from:'now-24h'") ?? false)
        XCTAssertFalse(before?.contains("container") ?? true)

        var noKibana = endpoint
        noKibana.kibanaURL = nil
        XCTAssertNil(history(StubSearcher([]), endpoint: noKibana).kibanaURL)
        noKibana.kibanaURL = "javascript:alert(1)"
        XCTAssertNil(history(StubSearcher([]), endpoint: noKibana).kibanaURL)
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

    private func store(_ searcher: StubSearcher, endpoint: EsEndpoint?) -> (
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
                elastic: LogHistoryAccess(searcher: searcher, endpoints: endpoints)),
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
