import XCTest

@testable import cubelite

/// Never called: the discovery tests only build links.
private struct NoSearch: LogHistorySearching {
    func search(context: String, endpoint: EsEndpoint, query: HistoryQuery) async throws -> HistoryPage {
        HistoryPage(lines: [], total: 0, totalIsLowerBound: false, next: nil)
    }
}

private struct NoQuerying: PrometheusQuerying {
    func metrics(context: String, endpoint: PromEndpoint, request: MetricsRequest) async throws -> MetricsResult {
        throw CancellationError()
    }
    func sparklines(context: String, endpoint: PromEndpoint, namespace: String?) async throws -> Sparklines {
        throw CancellationError()
    }
}

/// Discoverable integrations (#526): hints, header links, palette entries.
@MainActor
final class IntegrationDiscoveryTests: XCTestCase {

    /// Emptied once per test (XCTest makes one instance per test method).
    private lazy var defaults = TestDefaults.fresh(for: Self.self)

    // MARK: - Hints

    func testSetupHintNeedsTheIntegrationNoEndpointAndHintsOn() {
        XCTAssertTrue(IntegrationHints.showsSetup(available: true, configured: false, hints: true))
        XCTAssertFalse(IntegrationHints.showsSetup(available: true, configured: false, hints: false), "hidden")
        XCTAssertFalse(IntegrationHints.showsSetup(available: true, configured: true, hints: true), "configured")
        XCTAssertFalse(IntegrationHints.showsSetup(available: false, configured: false, hints: true), "no backend")
    }

    func testIntegrationHintsDefaultOnAndPersist() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertTrue(settings.integrationHints)
        settings.integrationHints = false
        XCTAssertFalse(AppSettings(defaults: defaults).integrationHints)
    }

    func testShowIntegrationSettingsSelectsTheTabAndPane() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertEqual(settings.preferencesTab, .general)
        XCTAssertNil(settings.integrationContext)
        settings.showIntegrationSettings(.prometheus, context: "prod")
        XCTAssertEqual(settings.preferencesTab, .integrations)
        XCTAssertEqual(settings.integrationPane, .prometheus)
        XCTAssertEqual(settings.integrationContext, "prod", "the tab edits the panel's context")
        settings.preferencesTab = .general
        settings.showIntegrationSettings(nil, context: "staging")
        XCTAssertEqual(settings.preferencesTab, .integrations)
        XCTAssertEqual(settings.integrationPane, .prometheus, "no pane keeps the last one")
        XCTAssertEqual(settings.integrationContext, "staging")
        settings.showIntegrationSettings(.elasticsearch, context: nil)
        XCTAssertEqual(settings.integrationContext, "staging", "no context keeps the tab's choice")
        XCTAssertNil(AppSettings(defaults: defaults).integrationContext, "not persisted")
    }

    func testHistorySetupIsOfferedOnlyWithoutAnEndpoint() {
        let endpoints = ElasticEndpointStore(defaults: defaults)
        let pod = PodInfo(
            name: "api-0", namespace: "shop", phase: "Running", ready: true, restarts: 0, creationTimestamp: nil)
        let session = LogSession(
            pod: pod, context: "prod", streamer: MockLogStreamer(), defaults: defaults,
            elastic: LogHistoryAccess(searcher: NoSearch(), endpoints: endpoints))
        XCTAssertTrue(session.offersHistorySetup(hints: true))
        XCTAssertFalse(session.offersHistorySetup(hints: false))
        endpoints.setEndpoint(EsEndpoint(target: .external(url: "https://es.example")), for: "prod")
        XCTAssertFalse(session.offersHistorySetup(hints: true), "History itself is offered")

        let noElastic = LogSession(pod: pod, context: "prod", streamer: MockLogStreamer(), defaults: defaults)
        XCTAssertFalse(noElastic.offersHistorySetup(hints: true))
    }

    // MARK: - Kibana

    func testLuceneRegexLiteralEscapesMetacharacters() {
        XCTAssertEqual(Elastic.luceneRegexLiteral("api.v2"), #"api\.v2"#)
        XCTAssertEqual(Elastic.luceneRegexLiteral(##"a#@&<>~/"\"##), ##"a\#\@\&\<\>\~\/\"\\"##)
    }

    /// Whether the workload's Lucene regexp matches `pod` (Lucene regexps match the whole term).
    private func matches(_ regex: String, _ pod: String) throws -> Bool {
        let anchored = try NSRegularExpression(pattern: "^(?:\(regex))$")
        return anchored.firstMatch(in: pod, range: NSRange(pod.startIndex..., in: pod)) != nil
    }

    func testWorkloadPodRegexMatchesOnlyItsPods() throws {
        let api = Prometheus.deploymentPods("api", literal: Elastic.luceneRegexLiteral)
        XCTAssertTrue(try matches(api, "api-7d9f8b6c5-x7k2p"))
        XCTAssertFalse(try matches(api, "api-gateway-x7k2p-abcde"), "another deployment")
        XCTAssertFalse(try matches(api, "api-0"))
        let web = Prometheus.statefulSetPods("web", literal: Elastic.luceneRegexLiteral)
        XCTAssertTrue(try matches(web, "web-0"))
        XCTAssertFalse(try matches(web, "web-x7k2p"))
    }

    func testKibanaWorkloadURLs() throws {
        func decoded(_ workload: Workload) -> String {
            Elastic.kibanaWorkloadURL(
                kibanaBase: "https://kb.example/", preset: .ecs, namespace: "shop", workload: workload
            ).removingPercentEncoding ?? ""
        }
        let safe = "[bcdfghjklmnpqrstvwxz2456789]"
        let deployment = decoded(.deployment("api"))
        XCTAssertTrue(deployment.hasPrefix("https://kb.example/app/discover#/?_g="), deployment)
        XCTAssertTrue(
            deployment.contains(
                #"kubernetes.namespace:"shop" AND kubernetes.pod.name:/api-\#(safe){6,10}-\#(safe){5}/"#),
            deployment)
        XCTAssertTrue(deployment.contains("language:lucene"), deployment)
        XCTAssertTrue(deployment.contains("from:'now-1h',to:'now'"), deployment)

        let long = String(repeating: "a", count: 70)
        XCTAssertTrue(
            decoded(.deployment(long)).contains(
                "kubernetes.pod.name:/\(String(repeating: "a", count: 58))(-\(safe){0,10}-?)?\(safe){5}/"))
        XCTAssertTrue(decoded(.statefulSet("db")).contains("kubernetes.pod.name:/db-[0-9]+/"))

        let pod = Elastic.kibanaWorkloadURL(kibanaBase: "https://kb.example", preset: .ecs, namespace: "shop", workload: .pod("api-0"))
        XCTAssertEqual(
            pod,
            Elastic.kibanaDiscoverURL(
                kibanaBase: "https://kb.example", preset: .ecs, namespace: "shop", pod: "api-0", container: nil,
                from: "now-1h", to: "now"))
        XCTAssertTrue(decoded(.pod("api-0")).contains("language:kuery"), "pod links stay KQL")
        XCTAssertEqual(Elastic.kibanaHomeURL(kibanaBase: " https://kb.example// "), "https://kb.example/app/discover#/")
        XCTAssertEqual(
            Elastic.kibanaHomeURL(kibanaBase: "https://kb.example/kibana/?x=1#top"),
            "https://kb.example/kibana/app/discover#/", "query and fragment dropped from the base")
    }

    func testWebURLDropsCredentialsAndOtherSchemes() {
        XCTAssertEqual(
            Integration.webURL("https://user:secret@kb.example/app/discover#/?_g=x")?.absoluteString,
            "https://kb.example/app/discover#/?_g=x")
        XCTAssertEqual(Integration.webURL("http://kb.example")?.absoluteString, "http://kb.example")
        XCTAssertNil(Integration.webURL("javascript:alert(1)"))
    }

    func testGrafanaBaseDropsQueryAndFragment() {
        let url = Prometheus.grafanaExploreURL(
            grafanaBase: "https://grafana.example/?orgId=1#x", datasource: nil, queries: ["up"], from: "now-1h",
            to: "now")
        XCTAssertTrue(url.hasPrefix("https://grafana.example/explore?schemaVersion=1&panes="), url)
    }

    // MARK: - Grafana

    func testWorkloadCPUQuery() {
        let query = Prometheus.workloadCPUQuery(namespace: "shop", workload: .pod("api-0"), cluster: "eu")
        XCTAssertEqual(
            query,
            Prometheus.chartQuery(
                .cpu, selector: #"namespace="shop", pod="api-0", cluster="eu""#, perContainer: true, window: 60))
        XCTAssertTrue(query.hasPrefix("sum by (container) (rate(container_cpu_usage_seconds_total{"), query)
    }

    // MARK: - Links and palette

    private func links(es: EsEndpoint?, prom: PromEndpoint?, withElastic: Bool = true) -> IntegrationLinks {
        let esStore = ElasticEndpointStore(defaults: defaults)
        if let es { esStore.setEndpoint(es, for: "prod") }
        let promStore = PrometheusEndpointStore(defaults: defaults)
        if let prom { promStore.setEndpoint(prom, for: "prod") }
        return IntegrationLinks(
            context: "prod",
            elastic: withElastic ? LogHistoryAccess(searcher: NoSearch(), endpoints: esStore) : nil,
            prometheus: PrometheusStore(endpoints: promStore, querying: NoQuerying()))
    }

    func testPaletteEntries() {
        XCTAssertEqual(
            IntegrationPaletteEntry.entries(canOpenKibana: true, canOpenGrafana: true, hasIntegrations: true),
            [.openKibana, .openGrafana, .integrationsSettings])
        XCTAssertEqual(
            IntegrationPaletteEntry.entries(canOpenKibana: false, canOpenGrafana: true, hasIntegrations: true),
            [.openGrafana, .integrationsSettings])
        XCTAssertEqual(
            IntegrationPaletteEntry.entries(canOpenKibana: false, canOpenGrafana: false, hasIntegrations: false), [])
        XCTAssertEqual(
            IntegrationPaletteEntry.allCases.map(\.label), ["Open Kibana", "Open Grafana", "Integrations settings"])
    }

    func testNothingToOpenWithoutEndpointsOrUIs() async throws {
        let none = links(es: nil, prom: nil)
        XCTAssertFalse(none.canOpenKibana)
        XCTAssertFalse(none.canOpenGrafana)
        XCTAssertEqual(none.paletteEntries, [.integrationsSettings])
        let kibana = try await none.kibanaURL()
        XCTAssertNil(kibana)

        // Endpoints without a UI URL or an in-cluster service to forward to.
        let noUI = links(
            es: EsEndpoint(target: .external(url: "https://es.example")),
            prom: PromEndpoint(target: .external(url: "https://prom.example")))
        XCTAssertEqual(noUI.paletteEntries, [.integrationsSettings])
    }

    func testConfiguredUIsOpenHomeAndWorkloadLinks() async throws {
        let open = links(
            es: EsEndpoint(target: .external(url: "https://es.example"), kibanaURL: "https://kb.example/"),
            prom: PromEndpoint(
                target: .external(url: "https://prom.example"), grafanaURL: "https://grafana.example",
                grafanaDatasource: "prom"))
        XCTAssertEqual(open.paletteEntries, [.openKibana, .openGrafana, .integrationsSettings])

        let kibanaHome = try await open.kibanaURL()
        XCTAssertEqual(kibanaHome?.absoluteString, "https://kb.example/app/discover#/")
        let kibana = try await open.kibanaURL(namespace: "shop", workload: .deployment("api"))
        XCTAssertTrue(
            kibana?.absoluteString.removingPercentEncoding?.contains("kubernetes.pod.name:/api-[") ?? false,
            String(describing: kibana))

        let grafanaHome = try await open.grafanaURL()
        XCTAssertEqual(grafanaHome?.absoluteString, "https://grafana.example")
        let grafana = try await open.grafanaURL(namespace: "shop", workload: .deployment("api"))
        let text = try XCTUnwrap(grafana?.absoluteString.removingPercentEncoding)
        XCTAssertTrue(text.hasPrefix("https://grafana.example/explore?"), text)
        XCTAssertTrue(text.contains("container_cpu_usage_seconds_total"), text)
        XCTAssertTrue(text.contains("now-1h"), text)
    }

    func testNoElasticBackendHidesKibanaAndKeepsSettings() {
        let promOnly = links(
            es: EsEndpoint(target: .external(url: "https://es.example"), kibanaURL: "https://kb.example"),
            prom: nil, withElastic: false)
        XCTAssertFalse(promOnly.canOpenKibana)
        XCTAssertEqual(promOnly.paletteEntries, [.integrationsSettings])
    }
}
