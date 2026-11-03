import XCTest

@testable import cubelite

/// Records history queries; answers with `lines` (newest first).
private final class RecordingSearcher: LogHistorySearching, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [HistoryQuery] = []
    let lines: [HistoryLine]

    init(_ lines: [HistoryLine] = []) { self.lines = lines }

    var queries: [HistoryQuery] { lock.withLock { recorded } }

    func search(context: String, endpoint: EsEndpoint, query: HistoryQuery) async throws -> HistoryPage {
        lock.withLock { recorded.append(query) }
        return HistoryPage(lines: lines, total: lines.count, totalIsLowerBound: false, next: nil)
    }

    func closeCursor(context: String, endpoint: EsEndpoint, cursor: HistoryCursor) async {}
}

private func line(_ message: String, pod: String?) -> HistoryLine {
    HistoryLine(
        time: "2026-11-03T08:00:00Z", level: .info, message: message, container: "api", document: "{}", pod: pod)
}

/// Workload and namespace history (#529): same vectors as the core's
/// `crates/cubelite-core/src/elastic/tests.rs`.
@MainActor
final class WorkloadHistoryTests: XCTestCase {

    private let safe = "[bcdfghjklmnpqrstvwxz2456789]"

    private func json(_ text: String) -> JSONValue {
        guard let value = JSONValue.parse(text) else {
            XCTFail("invalid JSON: \(text)")
            return .null
        }
        return value
    }

    private func podClause(_ workload: Workload, _ preset: FieldPreset = .ecs) -> JSONValue? {
        let query = HistoryQuery(namespace: "shop", workload: workload, from: "now-1h", to: "now")
        guard case .array(let filter)? = Elastic.searchBody(query, preset: preset)["query"]?["bool"]?["filter"],
            filter.count == 3
        else { return nil }
        return filter[1]
    }

    // MARK: Query building

    func testWorkloadsFilterByARegexpOnTheKeywordPodField() {
        XCTAssertEqual(
            podClause(.deployment("api")),
            json(#"{"regexp":{"kubernetes.pod.name":{"value":"api-\#(safe){6,10}-\#(safe){5}"}}}"#))
        XCTAssertEqual(
            podClause(.statefulSet("db"), .fluentBit),
            json(#"{"regexp":{"kubernetes.pod_name.keyword":{"value":"db-[0-9]+"}}}"#),
            "Fluent Bit maps the pod name as text: its keyword subfield")
        XCTAssertEqual(
            podClause(.daemonSet("agent")),
            json(#"{"regexp":{"kubernetes.pod.name":{"value":"agent-\#(safe){5}"}}}"#))
        XCTAssertEqual(podClause(.pod("api-0")), json(#"{"term":{"kubernetes.pod.name":"api-0"}}"#))
    }

    func testAJobMatchesItsRegexpOrItsJobNameLabel() {
        let regexp = #"{"regexp":{"kubernetes.pod.name":{"value":"migrate-\#(safe){5}"}}}"#
        XCTAssertEqual(
            podClause(.job("migrate")),
            json(
                #"{"bool":{"should":[\#(regexp),{"term":{"kubernetes.labels.batch_kubernetes_io/job-name":"migrate"}}],"minimum_should_match":1}}"#
            ))
        XCTAssertEqual(
            podClause(.job("migrate"), .fluentBit),
            json(#"{"regexp":{"kubernetes.pod_name.keyword":{"value":"migrate-\#(safe){5}"}}}"#),
            "no label field in the preset: the regexp only")
    }

    func testANamespaceQueryHasNoPodClause() {
        let body = Elastic.searchBody(HistoryQuery(namespace: "shop", from: "now-1h", to: "now"), preset: .ecs)
        guard case .array(let filter)? = body["query"]?["bool"]?["filter"] else { return XCTFail("filter") }
        XCTAssertEqual(filter.count, 2, "namespace and time only")
    }

    func testLuceneQueriesPerKind() {
        func q(_ w: Workload?, _ preset: FieldPreset = .ecs) -> String {
            Elastic.workloadLuceneQuery(preset: preset, namespace: "shop", workload: w)
        }
        XCTAssertEqual(q(nil), #"kubernetes.namespace:"shop""#)
        XCTAssertEqual(q(.pod("api-0")), #"kubernetes.namespace:"shop" AND kubernetes.pod.name:"api-0""#)
        XCTAssertEqual(q(.statefulSet("db")), #"kubernetes.namespace:"shop" AND kubernetes.pod.name:/db-[0-9]+/"#)
        XCTAssertEqual(
            q(.daemonSet("agent")), #"kubernetes.namespace:"shop" AND kubernetes.pod.name:/agent-\#(safe){5}/"#)
        XCTAssertEqual(
            q(.job("migrate")),
            #"kubernetes.namespace:"shop" AND (kubernetes.pod.name:/migrate-\#(safe){5}/ OR kubernetes.labels.batch_kubernetes_io\/job\-name:"migrate")"#
        )
        let escaped = q(.deployment("a.b/c#d"), .fluentBit)
        XCTAssertTrue(
            escaped.hasPrefix(##"kubernetes.namespace_name:"shop" AND kubernetes.pod_name.keyword:/a\.b\/c\#d-"##),
            "keyword subfield, special characters escaped: \(escaped)")
        let namespaceURL = Elastic.kibanaWorkloadURL(
            kibanaBase: "https://kb.example", preset: .ecs, namespace: "shop", workload: nil, from: "now-24h")
        let decoded = namespaceURL.removingPercentEncoding ?? ""
        XCTAssertTrue(decoded.contains("from:'now-24h'"), decoded)
        XCTAssertTrue(decoded.contains(#"query:'kubernetes.namespace:"shop"'"#), decoded)
    }

    func testPodRegexpsNeverMatchASiblingWorkload() {
        func matches(_ w: Workload, _ pod: String) -> Bool {
            LogScope(namespace: "shop", workload: w).matcher()(
                PodInfo(name: pod, namespace: "shop", phase: nil, ready: true, restarts: 0, creationTimestamp: nil))
        }
        XCTAssertTrue(matches(.deployment("api"), "api-7d9f8b6c5-x7k2p"))
        XCTAssertFalse(matches(.deployment("api"), "api-gateway-7d9f8b6c5-x7k2p"))
        XCTAssertTrue(matches(.statefulSet("db"), "db-0"))
        XCTAssertFalse(matches(.statefulSet("db"), "db-backup-0"))
        XCTAssertTrue(matches(.daemonSet("agent"), "agent-x7k2p"))
        XCTAssertFalse(matches(.daemonSet("agent"), "agent-metrics-x7k2p"))
        XCTAssertTrue(matches(.job("migrate"), "migrate-x7k2p"))
        XCTAssertFalse(matches(.job("migrate"), "migrate-28374652-x7k2p"), "a CronJob's pod")
        let other = PodInfo(
            name: "api-7d9f8b6c5-x7k2p", namespace: "billing", phase: nil, ready: true, restarts: 0,
            creationTimestamp: nil)
        XCTAssertFalse(LogScope(namespace: "shop", workload: .deployment("api")).matcher()(other))
    }

    func testPrometheusSelectorsForDaemonSetsAndJobs() {
        XCTAssertEqual(
            Prometheus.selector(namespace: "shop", workload: .daemonSet("agent"), cluster: nil),
            #"namespace="shop", pod=~"agent-\#(safe){5}""#)
        XCTAssertEqual(
            Prometheus.selector(namespace: "shop", workload: .job("migrate"), cluster: nil),
            #"namespace="shop", pod=~"migrate-\#(safe){5}""#)
    }

    func testHitsCarryTheirPod() throws {
        let response = json(
            #"{"hits":{"hits":[{"_source":{"message":"m","kubernetes":{"pod":{"name":"api-7d9f8b6c5-x7k2p"}}}},{"_source":{"log":"x","kubernetes":{"pod_name":"db-0"}}}]}}"#
        )
        XCTAssertEqual(try Elastic.mapResponse(response, preset: .ecs, pageSize: 500).lines.first?.pod, "api-7d9f8b6c5-x7k2p")
        XCTAssertEqual(try Elastic.mapResponse(response, preset: .fluentBit, pageSize: 500).lines.last?.pod, "db-0")
    }

    // MARK: Logs view mapping

    func testLogsViewFilterMapsToAHistoryQuery() {
        let scope = LogScope(namespace: "shop", workload: .deployment("api"))
        XCTAssertEqual(
            LogsHistoryMapping.map(namespace: nil, scope: scope, selector: ""),
            .query(namespace: "shop", target: .deployment("api")))
        XCTAssertEqual(
            LogsHistoryMapping.map(namespace: "shop", scope: nil, selector: " "), .query(namespace: "shop", target: nil))
        XCTAssertEqual(
            LogsHistoryMapping.map(namespace: "shop", scope: scope, selector: "app=api").reason,
            LogsHistoryMapping.selectorHint)
        XCTAssertEqual(
            LogsHistoryMapping.map(namespace: nil, scope: nil, selector: "").reason, LogsHistoryMapping.namespaceHint)
    }

    // MARK: Store

    private func store(_ searcher: RecordingSearcher, endpoint: EsEndpoint?) -> AggregatedLogStore {
        let defaults = TestDefaults.fresh(for: Self.self)
        let endpoints = ElasticEndpointStore(defaults: defaults)
        if let endpoint { endpoints.setEndpoint(endpoint, for: "prod") }
        let store = AggregatedLogStore(streamer: MockLogStreamer(), defaults: defaults)
        store.elastic = LogHistoryAccess(searcher: searcher, endpoints: endpoints)
        return store
    }

    private let endpoint = EsEndpoint(target: .external(url: "https://es.example"), kibanaURL: "https://kb.example")

    func testStoreShowsAWorkloadsHistoryWithEachLinesPod() async throws {
        let searcher = RecordingSearcher([line("newest", pod: "api-b"), line("older", pod: "api-a")])
        let store = store(searcher, endpoint: endpoint)
        store.setHistory(.query(namespace: "shop", target: .deployment("api")), context: "prod")
        let history = try XCTUnwrap(store.history)
        store.setSource(.history)
        for _ in 0..<200 where history.loads == 0 { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(store.showsHistory)
        XCTAssertEqual(store.filtered.map(\.line.message), ["older", "newest"])
        XCTAssertEqual(store.filtered.map(\.pod), ["api-a", "api-b"])
        XCTAssertEqual(store.filtered.first?.namespace, "shop")
        let query = try XCTUnwrap(searcher.queries.first)
        XCTAssertEqual(query.workload, .deployment("api"))
        XCTAssertEqual(query.pod, "")
        XCTAssertNil(query.container)

        let kibana = try await store.kibanaURL(context: "prod")
        let text = try XCTUnwrap(kibana?.absoluteString.removingPercentEncoding)
        XCTAssertTrue(text.contains("kubernetes.pod.name:/api-"), text)

        // The same filter keeps its history; another one replaces it.
        store.setHistory(.query(namespace: "shop", target: .deployment("api")), context: "prod")
        XCTAssertTrue(store.history === history)
        store.setHistory(.query(namespace: "shop", target: nil), context: "prod")
        XCTAssertFalse(store.history === history)
    }

    func testStoreFallsBackToLiveWithoutAHistoryQueryOrEndpoint() throws {
        let store = store(RecordingSearcher(), endpoint: endpoint)
        store.setHistory(.query(namespace: "shop", target: nil), context: "prod")
        store.setSource(.history)
        XCTAssertEqual(store.source, .history)
        store.setHistory(.unavailable(LogsHistoryMapping.selectorHint), context: "prod")
        XCTAssertNil(store.history)
        XCTAssertEqual(store.source, .live)
        store.setSource(.history)
        XCTAssertEqual(store.source, .live, "History needs a query")

        let none = self.store(RecordingSearcher(), endpoint: nil)
        none.setHistory(.query(namespace: "shop", target: nil), context: "prod")
        XCTAssertNil(none.history, "no Elasticsearch endpoint")
    }

    func testHistoryTargetsSendThePodOrTheWorkload() async throws {
        let searcher = RecordingSearcher()
        for target: Workload? in [.pod("api-0"), .job("migrate"), nil] {
            let history = LogHistory(
                context: "prod", namespace: "shop", target: target, endpoint: { self.endpoint },
                container: { nil }, searcher: searcher)
            await history.reload()
        }
        XCTAssertEqual(searcher.queries.map(\.pod), ["api-0", "", ""])
        XCTAssertEqual(searcher.queries.map(\.workload), [nil, .job("migrate"), nil])
        let job = LogHistory(
            context: "prod", namespace: "shop", target: .job("migrate"), endpoint: { self.endpoint },
            container: { nil }, searcher: searcher)
        XCTAssertEqual(job.subject, "job migrate")
    }
}
