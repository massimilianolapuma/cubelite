import XCTest

@testable import cubelite

/// Records the Elasticsearch calls Enable makes; `failTest` makes Test fail.
private actor FakeElastic: ElasticPreferencesBackend {
    var tested: [(EsEndpoint, EsAuth?)] = []
    var saved: [(EsEndpoint, EsAuth)] = []
    var eck: [EsEndpoint] = []
    var failTest = false

    func setFailTest(_ fail: Bool) { failTest = fail }

    func detect(context: String) async throws -> [DetectedService] { [] }

    func test(context: String, endpoint: EsEndpoint, auth: EsAuth?) async throws -> EsInfo {
        tested.append((endpoint, auth))
        if failTest { throw ElasticError.connect("401 unauthorized") }
        return EsInfo(version: "8.15.0", clusterName: "logs", health: "green", indices: 2)
    }

    func saveAuth(context: String, endpoint: EsEndpoint, auth: EsAuth) async throws {
        saved.append((endpoint, auth))
    }

    func authMethod(context: String, endpoint: EsEndpoint) async throws -> String {
        eck.isEmpty ? "none" : "eck-user"
    }

    func useEckCredentials(context: String, endpoint: EsEndpoint) async throws {
        eck.append(endpoint)
    }

    func disconnect(context: String) async {}
}

private actor FakePrometheus: PrometheusPreferencesBackend {
    var tested: [(PromEndpoint, PromAuth?)] = []
    var saved: [(PromEndpoint, PromAuth)] = []

    func detect(context: String) async throws -> [DetectedPrometheus] { [] }

    func test(context: String, endpoint: PromEndpoint, auth: PromAuth?) async throws -> PromInfo {
        tested.append((endpoint, auth))
        return PromInfo(version: "2.54.1", cadvisor: true, kubeStateMetrics: true, clusters: [])
    }

    func saveAuth(context: String, endpoint: PromEndpoint, auth: PromAuth) async throws {
        saved.append((endpoint, auth))
    }

    func authMethod(context: String, endpoint: PromEndpoint) async throws -> String { "none" }

    func disconnect(context: String) async {}
}

/// A cluster where listing services across namespaces is forbidden.
private struct ForbiddenCluster: IntegrationClusterAccess {
    func getIfPresent(path: String, inContext contextName: String?) async throws -> Data? {
        throw CubeliteError.forbidden(resource: "services", reason: "cannot list services at the cluster scope")
    }

    func portForwardWebSocket(
        namespace: String, pod: String, remotePort: Int, inContext contextName: String?
    ) async throws -> URLSessionWebSocketTask {
        throw ElasticError.connect("no port-forward in tests")
    }

    func rawGet(path: String, inContext contextName: String?) async throws -> (status: Int, body: Data) {
        (403, Data())
    }
}

/// Detect on connect, enable in one click (#527).
@MainActor
final class IntegrationSuggestionsTests: XCTestCase {

    private lazy var defaults = TestDefaults.fresh(for: Self.self)

    /// ECK, kube-prometheus-stack, a second Elasticsearch chart, a second
    /// Grafana and unrelated services (same list as the core test).
    private static let mixed: [(String, String, String, String)] = [
        ("default", "kubernetes", "{}", #"[{"name":"https","port":443}]"#),
        ("a-search", "elasticsearch-master", #"{"app":"elasticsearch-master"}"#, #"[{"name":"http","port":9200}]"#),
        ("logging", "quickstart-es-transport", #"{"common.k8s.elastic.co/type":"elasticsearch"}"#,
         #"[{"name":"tls-transport","port":9300}]"#),
        ("logging", "quickstart-es-default", #"{"common.k8s.elastic.co/type":"elasticsearch"}"#,
         #"[{"name":"https","port":9200}]"#),
        ("logging", "quickstart-es-http", #"{"common.k8s.elastic.co/type":"elasticsearch"}"#,
         #"[{"name":"https","port":9200}]"#),
        ("a-search", "kibana", #"{"app.kubernetes.io/name":"kibana"}"#, #"[{"name":"http","port":5601}]"#),
        ("logging", "quickstart-kb-http", #"{"common.k8s.elastic.co/type":"kibana"}"#,
         #"[{"name":"https","port":5601}]"#),
        ("a-metrics", "prometheus-server", #"{"app":"prometheus"}"#, #"[{"name":"http","port":80}]"#),
        ("monitoring", "kps-kube-prometheus-stack-prometheus", "{}", #"[{"name":"http-web","port":9090}]"#),
        ("monitoring", "prometheus-operated", #"{"operated-prometheus":"true"}"#, #"[{"name":"http-web","port":9090}]"#),
        ("monitoring", "kps-kube-prometheus-stack-alertmanager", "{}", #"[{"name":"http-web","port":9093}]"#),
        ("a-metrics", "grafana", #"{"app.kubernetes.io/name":"grafana"}"#, #"[{"name":"service","port":80}]"#),
        ("monitoring", "kps-grafana", #"{"app.kubernetes.io/name":"grafana"}"#, #"[{"name":"http-web","port":80}]"#),
    ]

    private static func listJSON(_ rows: [(String, String, String, String)]) -> String {
        let items = rows.map { ns, name, labels, ports in
            #"{"metadata":{"namespace":"\#(ns)","name":"\#(name)","labels":\#(labels)},"spec":{"ports":\#(ports)}}"#
        }
        return #"{"items":[\#(items.joined(separator: ","))]}"#
    }

    private static func services(_ rows: [(String, String, String, String)]) throws -> [IntegrationK8s.Service] {
        try JSONDecoder().decode(
            IntegrationK8s.List<IntegrationK8s.Service>.self, from: Data(listJSON(rows).utf8)
        ).items
    }

    private static func cluster(_ rows: [(String, String, String, String)] = mixed) -> StubCluster {
        StubCluster(objects: ["/api/v1/services": listJSON(rows)])
    }

    // MARK: - Detection

    func testPickPrefersECKOperatedAndCompanionsNextToThem() throws {
        let found = DetectedIntegrations.pick(services: try Self.services(Self.mixed))
        XCTAssertEqual(found.elasticsearch?.id, "elasticsearch:logging/quickstart-es-http:9200")
        XCTAssertEqual(found.elasticsearch?.https, true)
        XCTAssertEqual(found.kibana?.id, "kibana:logging/quickstart-kb-http:5601")
        XCTAssertEqual(found.prometheus?.id, "prometheus:monitoring/prometheus-operated:9090")
        XCTAssertEqual(found.grafana?.id, "grafana:monitoring/kps-grafana:80")
        XCTAssertEqual(found.found, [.elasticsearch, .prometheus])
    }

    func testPickFallsBackToTheFirstByNamespaceAndName() throws {
        let rows = Self.mixed.filter { !$0.1.hasPrefix("quickstart") && $0.1 != "prometheus-operated" }
        let found = DetectedIntegrations.pick(services: try Self.services(rows))
        XCTAssertEqual(found.elasticsearch?.name, "elasticsearch-master")
        XCTAssertEqual(found.kibana?.namespace, "a-search")
        XCTAssertEqual(found.prometheus?.name, "prometheus-server")
        XCTAssertEqual(found.grafana?.namespace, "a-metrics")
        XCTAssertEqual(DetectedIntegrations.pick(services: []), DetectedIntegrations())
    }

    func testDetectGivesUpSilentlyWhenForbidden() async throws {
        let found = try await DetectedIntegrations.detect(context: "prod", cluster: ForbiddenCluster())
        XCTAssertEqual(found, DetectedIntegrations())
        let all = try await DetectedIntegrations.detect(context: "prod", cluster: Self.cluster())
        XCTAssertEqual(all.found, [.elasticsearch, .prometheus])
    }

    // MARK: - Store

    private struct Harness {
        let store: IntegrationsSuggestionStore
        let settings: AppSettings
        let elastic: FakeElastic
        let prometheus: FakePrometheus
        let esEndpoints: ElasticEndpointStore
        let promEndpoints: PrometheusEndpointStore
    }

    private func harness(_ cluster: any IntegrationClusterAccess = IntegrationSuggestionsTests.cluster()) -> Harness {
        let settings = AppSettings(defaults: defaults)
        let elastic = FakeElastic()
        let prometheus = FakePrometheus()
        let es = ElasticEndpointStore(defaults: defaults)
        let prom = PrometheusEndpointStore(defaults: defaults)
        let store = IntegrationsSuggestionStore(
            cluster: cluster, elastic: elastic, prometheus: prometheus, elasticEndpoints: es,
            prometheusEndpoints: prom, settings: settings)
        return Harness(
            store: store, settings: settings, elastic: elastic, prometheus: prometheus, esEndpoints: es,
            promEndpoints: prom)
    }

    func testBannerOffersFoundIntegrationsUntilConfiguredDismissedOrHintsOff() async {
        let h = harness()
        XCTAssertNil(h.store.message(for: "prod"), "nothing before detection")
        await h.store.detectIfNeeded(context: "prod")
        XCTAssertEqual(h.store.offered(for: "prod"), [.elasticsearch, .prometheus])
        XCTAssertEqual(h.store.message(for: "prod")?.text, "Elasticsearch and Prometheus found in this cluster")

        h.esEndpoints.setEndpoint(EsEndpoint(target: .external(url: "https://es.example")), for: "prod")
        XCTAssertEqual(h.store.message(for: "prod")?.text, "Prometheus found in this cluster", "configured")

        h.settings.integrationHints = false
        XCTAssertNil(h.store.message(for: "prod"), "hints off")
        h.settings.integrationHints = true

        h.store.dismiss(context: "prod")
        XCTAssertNil(h.store.message(for: "prod"), "dismissed")
        XCTAssertFalse(h.settings.isDismissed(.elasticsearch, context: "prod"), "only what was offered")
        XCTAssertTrue(AppSettings(defaults: defaults).isDismissed(.prometheus, context: "prod"), "persisted")
        h.settings.clearDismissals(context: "prod")
        XCTAssertEqual(h.store.offered(for: "prod"), [.prometheus])
        XCTAssertNil(h.store.message(for: "staging"), "per context")
    }

    func testNothingFoundOrForbiddenShowsNoBanner() async {
        let empty = harness(Self.cluster([]))
        await empty.store.detectIfNeeded(context: "prod")
        XCTAssertNil(empty.store.message(for: "prod"))
        let forbidden = harness(ForbiddenCluster())
        await forbidden.store.detectIfNeeded(context: "prod")
        XCTAssertNil(forbidden.store.message(for: "prod"))
    }

    func testDetectionRunsOncePerConnect() async {
        let h = harness()
        await h.store.detectIfNeeded(context: "prod")
        h.esEndpoints.setEndpoint(EsEndpoint(target: .external(url: "https://es.example")), for: "prod")
        h.store.connected("prod")
        XCTAssertNil(h.store.message(for: "prod"), "forgotten until the next load")
        await h.store.detectIfNeeded(context: "prod")
        XCTAssertEqual(h.store.offered(for: "prod"), [.prometheus])
        h.promEndpoints.setEndpoint(
            PromEndpoint(target: .external(url: "https://p.example")), for: "prod")
        await h.store.detectIfNeeded(context: "prod")
        XCTAssertEqual(h.store.offered(for: "prod"), [], "no second listing within one connect")
    }

    func testEnableSavesTheInClusterDefaultsWithECKCredentials() async {
        let h = harness()
        h.store.successDuration = .seconds(60)
        await h.store.detectIfNeeded(context: "prod")
        await h.store.enable(context: "prod")

        let es = h.esEndpoints.endpoint(for: "prod")
        XCTAssertEqual(
            es?.target, .inCluster(namespace: "logging", service: "quickstart-es-http", port: 9200, https: true))
        XCTAssertEqual(es?.indexPattern, EsEndpoint.defaultIndexPattern)
        XCTAssertEqual(es?.preset, .ecs)
        XCTAssertNil(es?.kibanaURL)
        XCTAssertEqual(
            es?.kibanaService, KibanaService(namespace: "logging", service: "quickstart-kb-http", port: 5601, https: true))
        let esTested = await h.elastic.tested
        XCTAssertEqual(esTested.map(\.1), [.eckUser], "the ECK secret is read only by Enable's test")
        let eck = await h.elastic.eck
        XCTAssertEqual(eck.count, 1, "ECK credentials stored as a choice")

        let prom = h.promEndpoints.endpoint(for: "prod")
        XCTAssertEqual(
            prom?.target, .inCluster(namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false))
        XCTAssertNil(prom?.cluster)
        XCTAssertNil(prom?.grafanaURL)
        XCTAssertEqual(
            prom?.grafanaService, ServiceRef(namespace: "monitoring", service: "kps-grafana", port: 80, https: false))
        let promSaved = await h.prometheus.saved
        XCTAssertEqual(promSaved.map(\.1), [.none])

        XCTAssertEqual(
            h.store.message(for: "prod"),
            .init(ok: true, text: "Elasticsearch enabled for prod · Prometheus enabled for prod"))
        XCTAssertFalse(h.store.canAct(for: "prod"), "both configured now")
    }

    func testEnableWithoutECKSavesNoAuthAndAFailedTestSavesNothing() async {
        let rows = Self.mixed.filter { !$0.1.hasPrefix("quickstart") }
        let h = harness(Self.cluster(rows))
        await h.elastic.setFailTest(true)
        await h.store.detectIfNeeded(context: "prod")
        await h.store.enable(context: "prod")
        XCTAssertNil(h.esEndpoints.endpoint(for: "prod"), "nothing saved")
        let esSaved = await h.elastic.saved
        XCTAssertTrue(esSaved.isEmpty)
        let esTested = await h.elastic.tested
        XCTAssertEqual(esTested.map(\.1), [EsAuth.none])
        let line = h.store.message(for: "prod")
        XCTAssertEqual(line?.ok, false)
        XCTAssertTrue(line?.text.hasPrefix("Couldn't connect to Elasticsearch: ") ?? false, line?.text ?? "")
        XCTAssertTrue(line?.text.hasSuffix("(credentials may be needed)") ?? false)
        XCTAssertNotNil(h.promEndpoints.endpoint(for: "prod"), "Prometheus still enabled")
        XCTAssertEqual(h.store.offered(for: "prod"), [.elasticsearch], "Review stays offered")

        await h.elastic.setFailTest(false)
        await h.store.enable(context: "prod")
        let saved = await h.elastic.saved
        XCTAssertEqual(saved.map(\.1), [EsAuth.none])
        XCTAssertEqual(h.esEndpoints.endpoint(for: "prod")?.target,
            .inCluster(namespace: "a-search", service: "elasticsearch-master", port: 9200, https: false))
    }

    func testReviewPrefillsTheFormsWithoutSaving() async {
        let h = harness()
        await h.store.detectIfNeeded(context: "prod")
        XCTAssertEqual(h.store.review(context: "prod"), .elasticsearch)
        XCTAssertNil(h.settings.takeSuggestion(for: "staging"), "kept for its context")
        let found = h.settings.takeSuggestion(for: "prod")
        XCTAssertNil(h.settings.takeSuggestion(for: "prod"), "consumed")

        let model = ElasticPreferencesModel(backend: h.elastic, endpoints: h.esEndpoints)
        await model.load(context: "prod")
        if let es = found?.elasticsearch { model.suggest(es, kibana: found?.kibana) }
        XCTAssertEqual(model.target.mode, .inCluster)
        XCTAssertEqual(model.draft()?.target,
            .inCluster(namespace: "logging", service: "quickstart-es-http", port: 9200, https: true))
        XCTAssertEqual(model.kibanaService?.service, "quickstart-kb-http")
        XCTAssertEqual(model.authMethod, .eckUser)
        XCTAssertEqual(model.outcome?.text, "Found in this cluster: Test, then Save.")

        let prom = PrometheusPreferencesModel(backend: h.prometheus, endpoints: h.promEndpoints)
        await prom.load(context: "prod")
        if let p = found?.prometheus { prom.suggest(p, grafana: found?.grafana) }
        XCTAssertEqual(prom.draft()?.grafanaService?.service, "kps-grafana")
        XCTAssertNil(h.esEndpoints.endpoint(for: "prod"))
        XCTAssertNil(h.promEndpoints.endpoint(for: "prod"))

        h.promEndpoints.setEndpoint(PromEndpoint(target: .external(url: "https://p.example")), for: "prod")
        await prom.load(context: "prod")
        if let p = found?.prometheus { prom.suggest(p, grafana: found?.grafana) }
        XCTAssertEqual(prom.target.mode, .external, "a saved endpoint is never replaced")
    }
}
