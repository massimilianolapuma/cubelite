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

/// Records the Prometheus calls; `cadvisor` is what Test reports.
private actor FakePrometheus: PrometheusPreferencesBackend {
    var tested: [(PromEndpoint, PromAuth?)] = []
    var saved: [(PromEndpoint, PromAuth)] = []
    var cadvisor = true

    func setCadvisor(_ value: Bool) { cadvisor = value }

    func detect(context: String) async throws -> [DetectedPrometheus] { [] }

    func test(context: String, endpoint: PromEndpoint, auth: PromAuth?) async throws -> PromInfo {
        tested.append((endpoint, auth))
        return PromInfo(version: "2.54.1", cadvisor: cadvisor, kubeStateMetrics: true, clusters: [])
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

/// A service in a listing: labels, ports and owner references as JSON.
private struct Row {
    let namespace: String
    let name: String
    var labels = "{}"
    var ports = #"[{"name":"http","port":80}]"#
    var owners = "[]"

    var json: String {
        #"{"metadata":{"namespace":"\#(namespace)","name":"\#(name)","labels":\#(labels),"ownerReferences":\#(owners)},"spec":{"ports":\#(ports)}}"#
    }

    static func owner(_ kind: String, _ apiVersion: String) -> String {
        #"[{"apiVersion":"\#(apiVersion)","kind":"\#(kind)","name":"x","uid":"1"}]"#
    }
}

/// Detect on connect, enable in one click (#527).
@MainActor
final class IntegrationSuggestionsTests: XCTestCase {

    private lazy var defaults = TestDefaults.fresh(for: Self.self)

    private static let eckES = #"{"common.k8s.elastic.co/type":"elasticsearch"}"#
    private static let eckLabels =
        #"{"common.k8s.elastic.co/type":"elasticsearch","elasticsearch.k8s.elastic.co/cluster-name":"evil"}"#
    private static let https9200 = #"[{"name":"https","port":9200}]"#

    /// ECK (owned by its Elasticsearch), kube-prometheus-stack, a second
    /// Elasticsearch chart, a second Grafana and unrelated services (same
    /// list as the core test).
    private static let mixed: [Row] = [
        Row(namespace: "default", name: "kubernetes", ports: #"[{"name":"https","port":443}]"#),
        Row(namespace: "a-search", name: "elasticsearch-master", labels: #"{"app":"elasticsearch-master"}"#,
            ports: #"[{"name":"http","port":9200}]"#),
        Row(namespace: "logging", name: "quickstart-es-transport", labels: eckES,
            ports: #"[{"name":"tls-transport","port":9300}]"#),
        Row(namespace: "logging", name: "quickstart-es-default", labels: eckES, ports: https9200),
        Row(namespace: "logging", name: "quickstart-es-http", labels: eckES, ports: https9200,
            owners: Row.owner("Elasticsearch", "elasticsearch.k8s.elastic.co/v1")),
        Row(namespace: "a-search", name: "kibana", labels: #"{"app.kubernetes.io/name":"kibana"}"#,
            ports: #"[{"name":"http","port":5601}]"#),
        Row(namespace: "logging", name: "quickstart-kb-http", labels: #"{"common.k8s.elastic.co/type":"kibana"}"#,
            ports: #"[{"name":"https","port":5601}]"#),
        Row(namespace: "a-metrics", name: "prometheus-server", labels: #"{"app":"prometheus"}"#),
        Row(namespace: "monitoring", name: "kps-kube-prometheus-stack-prometheus",
            ports: #"[{"name":"http-web","port":9090}]"#),
        Row(namespace: "monitoring", name: "prometheus-operated", labels: #"{"operated-prometheus":"true"}"#,
            ports: #"[{"name":"http-web","port":9090}]"#),
        Row(namespace: "monitoring", name: "kps-kube-prometheus-stack-alertmanager",
            ports: #"[{"name":"http-web","port":9093}]"#),
        Row(namespace: "a-metrics", name: "grafana", labels: #"{"app.kubernetes.io/name":"grafana"}"#,
            ports: #"[{"name":"service","port":80}]"#),
        Row(namespace: "monitoring", name: "kps-grafana", labels: #"{"app.kubernetes.io/name":"grafana"}"#,
            ports: #"[{"name":"http-web","port":80}]"#),
    ]

    private static func listJSON(_ rows: [Row]) -> String {
        #"{"items":[\#(rows.map(\.json).joined(separator: ","))]}"#
    }

    private static func pick(_ rows: [Row]) throws -> DetectedIntegrations {
        let list = try JSONDecoder().decode(
            IntegrationK8s.List<IntegrationK8s.Service>.self, from: Data(listJSON(rows).utf8))
        return DetectedIntegrations.pick(services: list.items)
    }

    private static func cluster(_ rows: [Row] = mixed) -> StubCluster {
        StubCluster(objects: ["/api/v1/services": listJSON(rows)])
    }

    // MARK: - Detection

    func testPickRanksOperatorOwnedThenWellKnownNamespaces() throws {
        let found = try Self.pick(Self.mixed)
        XCTAssertEqual(found.elasticsearch?.id, "elasticsearch:logging/quickstart-es-http:9200")
        XCTAssertEqual(found.elasticsearch?.https, true)
        XCTAssertEqual(found.kibana?.id, "kibana:logging/quickstart-kb-http:5601")
        XCTAssertEqual(found.prometheus?.id, "prometheus:monitoring/prometheus-operated:9090")
        XCTAssertEqual(found.grafana?.id, "grafana:monitoring/kps-grafana:80")
        XCTAssertTrue(found.elasticsearchOneClick)
        XCTAssertTrue(found.prometheusOneClick)
        XCTAssertEqual(
            found.elasticServices.map(\.name),
            ["quickstart-es-http", "elasticsearch-master", "quickstart-kb-http", "kibana"])
        XCTAssertEqual(
            found.prometheusServices.map(\.name),
            ["prometheus-operated", "kps-kube-prometheus-stack-prometheus", "prometheus-server", "kps-grafana",
             "grafana"])
        XCTAssertEqual(found.found, [.elasticsearch, .prometheus])
    }

    func testUnmanagedServicesFallBackToWellKnownNamespacesWithoutOneClick() throws {
        let rows = Self.mixed.filter { !$0.name.hasPrefix("quickstart") && $0.name != "prometheus-operated" }
        let found = try Self.pick(rows)
        XCTAssertEqual(found.elasticsearch?.name, "elasticsearch-master")
        XCTAssertEqual(found.kibana?.namespace, "a-search")
        XCTAssertEqual(found.prometheus?.name, "kps-kube-prometheus-stack-prometheus", "monitoring first")
        XCTAssertEqual(found.grafana?.name, "kps-grafana", "same namespace as Prometheus")
        XCTAssertFalse(found.elasticsearchOneClick)
        XCTAssertFalse(found.prometheusOneClick)
        XCTAssertEqual(try Self.pick([]), DetectedIntegrations())
    }

    func testWebUIComesOnlyFromTheMainServicesNamespace() throws {
        let found = try Self.pick([
            Row(namespace: "logging", name: "quickstart-es-http", labels: Self.eckLabels, ports: Self.https9200),
            Row(namespace: "a-search", name: "kibana", labels: #"{"app.kubernetes.io/name":"kibana"}"#),
        ])
        XCTAssertNotNil(found.elasticsearch)
        XCTAssertNil(found.kibana, "no companion from another namespace")
        XCTAssertTrue(found.elasticsearchOneClick, "type and cluster-name labels are trusted")
    }

    func testLookAlikesAndForeignOwnersAreNotOneClick() throws {
        let lookAlikes = Self.mixed + [
            Row(namespace: "team-a", name: "prometheus-operated", labels: #"{"operated-prometheus":"true"}"#,
                ports: #"[{"name":"http-web","port":9090}]"#),
            Row(namespace: "team-a", name: "evil-es-http", labels: Self.eckLabels, ports: Self.https9200),
        ]
        let several = try Self.pick(lookAlikes)
        XCTAssertEqual(several.elasticsearch?.namespace, "logging", "the well-known namespace still wins")
        XCTAssertEqual(several.prometheus?.namespace, "monitoring")
        XCTAssertFalse(several.elasticsearchOneClick, "two trusted Elasticsearch services")
        XCTAssertFalse(several.prometheusOneClick, "two trusted Prometheus services")

        let lone = try Self.pick([Row(namespace: "team-a", name: "foo-es-http", ports: Self.https9200)])
        XCTAssertEqual(lone.elasticsearch?.name, "foo-es-http")
        XCTAssertFalse(lone.elasticsearchOneClick, "not operator-managed")

        let foreign = try Self.pick([
            Row(namespace: "logging", name: "quickstart-es-http", ports: Self.https9200,
                owners: Row.owner("Elasticsearch", "elasticsearch.k8s.evil.example/v1"))
        ])
        XCTAssertFalse(foreign.elasticsearchOneClick, "owner from another API group")
        let promOwned = try Self.pick([
            Row(namespace: "monitoring", name: "kps-prometheus", ports: #"[{"name":"http-web","port":9090}]"#,
                owners: Row.owner("Prometheus", "monitoring.coreos.com/v1"))
        ])
        XCTAssertTrue(promOwned.prometheusOneClick, "owned by a Prometheus resource")
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
        store.successDuration = .seconds(60)
        return Harness(
            store: store, settings: settings, elastic: elastic, prometheus: prometheus, esEndpoints: es,
            promEndpoints: prom)
    }

    func testBannerNamesWhatWouldBeUsedUntilConfiguredDismissedOrHintsOff() async {
        let h = harness()
        XCTAssertNil(h.store.message(for: "prod"), "nothing before detection")
        await h.store.detectIfNeeded(context: "prod")
        XCTAssertEqual(h.store.offered(for: "prod"), [.elasticsearch, .prometheus])
        XCTAssertEqual(
            h.store.message(for: "prod")?.text,
            "Elasticsearch found (logging/quickstart-es-http) and Prometheus (monitoring/prometheus-operated)")
        XCTAssertTrue(h.store.canEnable(for: "prod"))

        h.esEndpoints.setEndpoint(EsEndpoint(target: .external(url: "https://es.example")), for: "prod")
        XCTAssertEqual(
            h.store.message(for: "prod")?.text, "Prometheus found (monitoring/prometheus-operated)", "configured")

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

    func testSeveralCandidatesOfferReviewOnly() async {
        let h = harness(Self.cluster(Self.mixed + [
            Row(namespace: "team-a", name: "evil-es-http", labels: Self.eckLabels, ports: Self.https9200)
        ]))
        await h.store.detectIfNeeded(context: "prod")
        XCTAssertTrue(h.store.canAct(for: "prod"))
        XCTAssertFalse(h.store.canEnable(for: "prod"), "Elasticsearch needs a review")
        await h.store.enable(context: "prod")
        XCTAssertNil(h.esEndpoints.endpoint(for: "prod"), "Enable refuses")
        XCTAssertNil(h.promEndpoints.endpoint(for: "prod"), "not even the one-click one")
        let tested = await h.elastic.tested
        XCTAssertTrue(tested.isEmpty, "no traffic to Elasticsearch")

        let lone = harness(Self.cluster([Row(namespace: "team-a", name: "foo-es-http", ports: Self.https9200)]))
        await lone.store.detectIfNeeded(context: "prod")
        XCTAssertEqual(lone.store.message(for: "prod")?.text, "Elasticsearch found (team-a/foo-es-http)")
        XCTAssertFalse(lone.store.canEnable(for: "prod"))
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
        h.promEndpoints.setEndpoint(PromEndpoint(target: .external(url: "https://p.example")), for: "prod")
        await h.store.detectIfNeeded(context: "prod")
        XCTAssertEqual(h.store.offered(for: "prod"), [], "no second listing within one connect")
    }

    func testEnableSavesTheInClusterDefaultsWithECKCredentials() async {
        let h = harness()
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
            .init(tone: .saved, text: "Elasticsearch enabled for prod · Prometheus enabled for prod"))
        XCTAssertFalse(h.store.canAct(for: "prod"), "both configured now")
    }

    func testFailedTestSavesNothingAndNonECKUsesNoAuth() async {
        let h = harness()
        await h.elastic.setFailTest(true)
        await h.store.detectIfNeeded(context: "prod")
        await h.store.enable(context: "prod")
        XCTAssertNil(h.esEndpoints.endpoint(for: "prod"), "nothing saved")
        let esSaved = await h.elastic.saved
        let eck = await h.elastic.eck
        XCTAssertTrue(esSaved.isEmpty && eck.isEmpty)
        let line = h.store.message(for: "prod")
        XCTAssertEqual(line?.tone, .failed)
        XCTAssertEqual(line?.text, "Couldn't connect to Elasticsearch: Cannot reach Elasticsearch: 401 unauthorized")
        XCTAssertNotNil(h.promEndpoints.endpoint(for: "prod"), "Prometheus still enabled")
        XCTAssertEqual(h.store.offered(for: "prod"), [.elasticsearch], "Review stays offered")
        XCTAssertFalse(h.store.canEnable(for: "prod"), "no Enable next to a failure")

        // An operator-owned Elasticsearch outside ECK's naming: no ECK user.
        let plain = harness(Self.cluster([
            Row(namespace: "logging", name: "elasticsearch", ports: #"[{"name":"http","port":9200}]"#,
                owners: Row.owner("Elasticsearch", "elasticsearch.k8s.elastic.co/v1"))
        ]))
        await plain.elastic.setFailTest(true)
        await plain.store.detectIfNeeded(context: "prod")
        await plain.store.enable(context: "prod")
        XCTAssertEqual(
            plain.store.message(for: "prod")?.text,
            "Couldn't connect to Elasticsearch: Cannot reach Elasticsearch: 401 unauthorized (credentials may be needed)")
        await plain.elastic.setFailTest(false)
        plain.store.connected("prod")
        await plain.store.detectIfNeeded(context: "prod")
        await plain.store.enable(context: "prod")
        let tested = await plain.elastic.tested
        XCTAssertEqual(tested.map(\.1), [EsAuth.none, EsAuth.none])
        let saved = await plain.elastic.saved
        XCTAssertEqual(saved.map(\.1), [EsAuth.none])
    }

    func testPrometheusWithoutCadvisorIsSavedWithAWarning() async {
        let h = harness(Self.cluster(Self.mixed.filter { $0.namespace == "monitoring" }))
        await h.prometheus.setCadvisor(false)
        await h.store.detectIfNeeded(context: "prod")
        XCTAssertEqual(h.store.offered(for: "prod"), [.prometheus])
        await h.store.enable(context: "prod")
        XCTAssertNotNil(h.promEndpoints.endpoint(for: "prod"), "still saved")
        XCTAssertEqual(
            h.store.message(for: "prod"),
            .init(tone: .warning, text: "Prometheus enabled for prod — no container metrics (cAdvisor) found yet"))
    }

    func testReviewPrefillsTheFormsWithEveryCandidateWithoutSaving() async {
        let h = harness()
        await h.store.detectIfNeeded(context: "prod")
        XCTAssertEqual(h.store.review(context: "prod"), .elasticsearch)
        XCTAssertNil(h.settings.takeSuggestion(for: "staging"), "kept for its context")
        let found = h.settings.takeSuggestion(for: "prod")
        XCTAssertNil(h.settings.takeSuggestion(for: "prod"), "consumed")

        let model = ElasticPreferencesModel(backend: h.elastic, endpoints: h.esEndpoints)
        await model.load(context: "prod")
        if let es = found?.elasticsearch {
            model.suggest(es, kibana: found?.kibana, candidates: found?.elasticServices ?? [])
        }
        XCTAssertEqual(model.target.mode, .inCluster)
        XCTAssertEqual(
            model.draft()?.target,
            .inCluster(namespace: "logging", service: "quickstart-es-http", port: 9200, https: true))
        XCTAssertEqual(model.kibanaService?.service, "quickstart-kb-http")
        XCTAssertEqual(model.authMethod, .eckUser)
        XCTAssertEqual(model.outcome?.text, "Found in this cluster: Test, then Save.")
        XCTAssertEqual(model.detected?.map(\.name), ["quickstart-es-http", "elasticsearch-master"])
        XCTAssertEqual(model.detectedKibana.map(\.name), ["quickstart-kb-http", "kibana"])

        let prom = PrometheusPreferencesModel(backend: h.prometheus, endpoints: h.promEndpoints)
        await prom.load(context: "prod")
        if let p = found?.prometheus {
            prom.suggest(p, grafana: found?.grafana, candidates: found?.prometheusServices ?? [])
        }
        XCTAssertEqual(prom.draft()?.grafanaService?.service, "kps-grafana")
        XCTAssertEqual(prom.detected?.count, 3)
        XCTAssertEqual(prom.detectedGrafana.map(\.name), ["kps-grafana", "grafana"])
        XCTAssertNil(h.esEndpoints.endpoint(for: "prod"))
        XCTAssertNil(h.promEndpoints.endpoint(for: "prod"))

        h.promEndpoints.setEndpoint(PromEndpoint(target: .external(url: "https://p.example")), for: "prod")
        await prom.load(context: "prod")
        if let p = found?.prometheus { prom.suggest(p, grafana: found?.grafana) }
        XCTAssertEqual(prom.target.mode, .external, "a saved endpoint is never replaced")
    }

    func testTurningAnIntegrationOffInSettingsDismissesItsSuggestion() async {
        let h = harness()
        await h.store.detectIfNeeded(context: "prod")
        h.promEndpoints.setEndpoint(PromEndpoint(target: .external(url: "https://p.example")), for: "prod")
        let model = PrometheusPreferencesModel(backend: h.prometheus, endpoints: h.promEndpoints)
        model.onTurnedOff = { [settings = h.settings] in settings.dismiss([.prometheus], context: $0) }
        await model.load(context: "prod")
        model.target.mode = .off
        await model.save()
        XCTAssertNil(h.promEndpoints.endpoint(for: "prod"))
        XCTAssertTrue(h.settings.isDismissed(.prometheus, context: "prod"))
        XCTAssertEqual(h.store.offered(for: "prod"), [.elasticsearch], "not offered again")
        h.settings.clearDismissals(context: "prod")
        XCTAssertEqual(h.store.offered(for: "prod"), [.elasticsearch, .prometheus], "Settings brings it back")

        let es = ElasticPreferencesModel(backend: h.elastic, endpoints: h.esEndpoints)
        var turnedOff: [String] = []
        es.onTurnedOff = { turnedOff.append($0) }
        h.esEndpoints.setEndpoint(EsEndpoint(target: .external(url: "https://es.example")), for: "prod")
        await es.load(context: "prod")
        es.target.mode = .off
        await es.save()
        XCTAssertEqual(turnedOff, ["prod"])
    }
}
