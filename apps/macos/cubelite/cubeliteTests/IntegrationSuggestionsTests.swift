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

/// Services and owner resources by path; `forbidden` paths answer 403.
/// Records every path asked for.
private final class RecordingCluster: IntegrationClusterAccess, @unchecked Sendable {
    private let lock = NSLock()
    private let objects: [String: String]
    private let forbidden: Set<String>
    private var recorded: [String] = []

    init(_ objects: [String: String], forbidden: Set<String> = []) {
        self.objects = objects
        self.forbidden = forbidden
    }

    var paths: [String] { lock.withLock { recorded } }

    func getIfPresent(path: String, inContext contextName: String?) async throws -> Data? {
        lock.withLock { recorded.append(path) }
        if forbidden.contains(path) { throw CubeliteError.forbidden(resource: path, reason: "forbidden") }
        return objects[path].map { Data($0.utf8) }
    }

    func portForwardWebSocket(
        namespace: String, pod: String, remotePort: Int, inContext contextName: String?
    ) async throws -> URLSessionWebSocketTask {
        throw ElasticError.connect("no port-forward in tests")
    }

    func rawGet(path: String, inContext contextName: String?) async throws -> (status: Int, body: Data) {
        (404, Data())
    }
}

/// A service in a listing: labels, ports, selector and owner references as JSON.
private struct Row {
    let namespace: String
    let name: String
    var labels = "{}"
    var ports = #"[{"name":"http","port":80}]"#
    var owners = "[]"
    var selector = "{}"

    var json: String {
        #"{"metadata":{"namespace":"\#(namespace)","name":"\#(name)","labels":\#(labels),"ownerReferences":\#(owners)},"spec":{"ports":\#(ports),"selector":\#(selector)}}"#
    }

    static func owner(_ kind: String, _ apiVersion: String, name: String = "x", uid: String = "1") -> String {
        #"[{"apiVersion":"\#(apiVersion)","kind":"\#(kind)","name":"\#(name)","uid":"\#(uid)"}]"#
    }

    static func esOwner(_ name: String = "quickstart", uid: String = "es-uid") -> String {
        owner("Elasticsearch", "elasticsearch.k8s.elastic.co/v1", name: name, uid: uid)
    }

    static func promOwner(_ name: String = "kps-kube-prometheus-stack-prometheus", uid: String = "prom-uid") -> String {
        owner("Prometheus", "monitoring.coreos.com/v1", name: name, uid: uid)
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
    private static let web9090 = #"[{"name":"http-web","port":9090}]"#
    private static let esCR = "/apis/elasticsearch.k8s.elastic.co/v1/namespaces/logging/elasticsearches/quickstart"
    private static let promCR =
        "/apis/monitoring.coreos.com/v1/namespaces/monitoring/prometheuses/kps-kube-prometheus-stack-prometheus"

    /// ECK and kube-prometheus-stack as on minikube: the ECK service owned
    /// by its Elasticsearch, `prometheus-operated` by its Prometheus, and
    /// the chart's Prometheus service selecting the same instance.
    private static let stack: [Row] = [
        Row(namespace: "default", name: "kubernetes", ports: #"[{"name":"https","port":443}]"#),
        Row(namespace: "logging", name: "quickstart-es-transport", labels: eckES,
            ports: #"[{"name":"tls-transport","port":9300}]"#),
        Row(namespace: "logging", name: "quickstart-es-default", labels: eckES, ports: https9200),
        Row(namespace: "logging", name: "quickstart-es-http", labels: eckES, ports: https9200, owners: Row.esOwner(),
            selector: #"{"elasticsearch.k8s.elastic.co/cluster-name":"quickstart"}"#),
        Row(namespace: "logging", name: "quickstart-kb-http", labels: #"{"common.k8s.elastic.co/type":"kibana"}"#,
            ports: #"[{"name":"https","port":5601}]"#),
        Row(namespace: "monitoring", name: "kps-kube-prometheus-stack-prometheus", ports: web9090,
            selector: #"{"app.kubernetes.io/name":"prometheus","operator.prometheus.io/name":"kps-kube-prometheus-stack-prometheus"}"#),
        Row(namespace: "monitoring", name: "prometheus-operated", labels: #"{"operated-prometheus":"true"}"#,
            ports: web9090, owners: Row.promOwner(), selector: #"{"app.kubernetes.io/name":"prometheus"}"#),
        Row(namespace: "monitoring", name: "kps-kube-prometheus-stack-alertmanager",
            ports: #"[{"name":"http-web","port":9093}]"#),
        Row(namespace: "monitoring", name: "kps-grafana", labels: #"{"app.kubernetes.io/name":"grafana"}"#,
            ports: #"[{"name":"http-web","port":80}]"#),
    ]

    /// The stack plus a second Elasticsearch chart, Prometheus and Grafana.
    private static let mixed: [Row] = stack + [
        Row(namespace: "a-search", name: "elasticsearch-master", labels: #"{"app":"elasticsearch-master"}"#,
            ports: #"[{"name":"http","port":9200}]"#),
        Row(namespace: "a-search", name: "kibana", labels: #"{"app.kubernetes.io/name":"kibana"}"#,
            ports: #"[{"name":"http","port":5601}]"#),
        Row(namespace: "a-metrics", name: "prometheus-server", labels: #"{"app":"prometheus"}"#),
        Row(namespace: "a-metrics", name: "grafana", labels: #"{"app.kubernetes.io/name":"grafana"}"#,
            ports: #"[{"name":"service","port":80}]"#),
    ]

    private static let verifiedStack: Set<String> = ["logging/quickstart-es-http", "monitoring/prometheus-operated"]

    private static func listJSON(_ rows: [Row]) -> String {
        #"{"items":[\#(rows.map(\.json).joined(separator: ","))]}"#
    }

    private static func pick(_ rows: [Row], verified: Set<String> = []) throws -> DetectedIntegrations {
        let list = try JSONDecoder().decode(
            IntegrationK8s.List<IntegrationK8s.Service>.self, from: Data(listJSON(rows).utf8))
        return DetectedIntegrations.pick(services: list.items, verified: verified)
    }

    /// The services, plus the stack's owner resources with their uids.
    private static func cluster(
        _ rows: [Row] = stack, owners: [String: String] = [esCR: "es-uid", promCR: "prom-uid"],
        forbidden: Set<String> = []
    ) -> RecordingCluster {
        var objects = ["/api/v1/services": listJSON(rows)]
        for (path, uid) in owners { objects[path] = #"{"metadata":{"uid":"\#(uid)"}}"# }
        return RecordingCluster(objects, forbidden: forbidden)
    }

    // MARK: - Ranking (pure)

    func testPickRanksVerifiedThenWellKnownNamespaces() throws {
        let found = try Self.pick(Self.mixed, verified: Self.verifiedStack)
        XCTAssertEqual(found.elasticsearch?.id, "elasticsearch:logging/quickstart-es-http:9200")
        XCTAssertEqual(found.elasticsearch?.https, true)
        XCTAssertEqual(found.kibana?.id, "kibana:logging/quickstart-kb-http:5601")
        XCTAssertEqual(found.prometheus?.id, "prometheus:monitoring/prometheus-operated:9090")
        XCTAssertEqual(found.grafana?.id, "grafana:monitoring/kps-grafana:80")
        XCTAssertEqual(
            found.elasticServices.map(\.name),
            ["quickstart-es-http", "elasticsearch-master", "quickstart-kb-http", "kibana"])
        XCTAssertEqual(
            found.prometheusServices.map(\.name),
            ["prometheus-operated", "kps-kube-prometheus-stack-prometheus", "prometheus-server", "kps-grafana",
             "grafana"])
        XCTAssertFalse(found.elasticsearchOneClick, "a second Elasticsearch elsewhere")
        XCTAssertFalse(found.prometheusOneClick, "a second Prometheus elsewhere")
        XCTAssertEqual(found.found, [.elasticsearch, .prometheus])
    }

    func testAVerifiedInstanceAndItsAliasesAreOneClick() throws {
        let found = try Self.pick(Self.stack, verified: Self.verifiedStack)
        XCTAssertTrue(found.elasticsearchOneClick)
        XCTAssertTrue(found.prometheusOneClick, "the chart's service selects the same Prometheus")
        XCTAssertEqual(found.prometheusServices.filter { $0.kind == .prometheus }.count, 2, "alias still listed")
        let unverified = try Self.pick(Self.stack)
        XCTAssertFalse(unverified.elasticsearchOneClick || unverified.prometheusOneClick, "owners not verified")
        XCTAssertEqual(unverified.prometheus?.name, "prometheus-operated", "conventional name ranks first")
    }

    func testVerifiedRanksAboveAnUnverifiedWellKnownNamespace() throws {
        let rows = [
            Row(namespace: "monitoring", name: "prom-a", labels: #"{"app":"prometheus"}"#, ports: Self.web9090),
            Row(namespace: "team-x", name: "prom-b", labels: #"{"app":"prometheus"}"#, ports: Self.web9090,
                owners: Row.promOwner("b")),
        ]
        let found = try Self.pick(rows, verified: ["team-x/prom-b"])
        XCTAssertEqual(found.prometheus?.name, "prom-b")
        XCTAssertFalse(found.prometheusOneClick, "prom-a is another Prometheus")
        XCTAssertEqual(try Self.pick(rows).prometheus?.name, "prom-a")
        XCTAssertEqual(try Self.pick([]), DetectedIntegrations())
    }

    func testWebUIComesOnlyFromTheBestServicesNamespace() throws {
        let found = try Self.pick([
            Row(namespace: "logging", name: "quickstart-es-http", ports: Self.https9200, owners: Row.esOwner()),
            Row(namespace: "a-search", name: "kibana", labels: #"{"app.kubernetes.io/name":"kibana"}"#),
        ], verified: ["logging/quickstart-es-http"])
        XCTAssertNotNil(found.elasticsearch)
        XCTAssertNil(found.kibana, "no companion from another namespace")
        XCTAssertTrue(found.elasticsearchOneClick)
    }

    // MARK: - Verification (Kubernetes API only)

    func testDetectVerifiesOnlyTheClaimedOwners() async throws {
        let cluster = Self.cluster(Self.mixed)
        let found = try await DetectedIntegrations.detect(context: "prod", cluster: cluster)
        XCTAssertEqual(found.elasticsearch?.name, "quickstart-es-http")
        XCTAssertEqual(found.prometheus?.name, "prometheus-operated")
        XCTAssertEqual(cluster.paths, ["/api/v1/services", Self.esCR, Self.promCR], "no other request")

        let stack = Self.cluster()
        let one = try await DetectedIntegrations.detect(context: "prod", cluster: stack)
        XCTAssertTrue(one.elasticsearchOneClick && one.prometheusOneClick)
    }

    func testAtMostThreeOwnersAreVerifiedPerIntegration() async throws {
        let rows: [Row] = (1...4).map { (i: Int) -> Row in
            Row(namespace: "ns\(i)", name: "es\(i)-es-http", ports: Self.https9200, owners: Row.esOwner("es\(i)"))
        }
        let cluster = Self.cluster(rows, owners: [:])
        _ = try await DetectedIntegrations.detect(context: "prod", cluster: cluster)
        let expected: [String] = (1...3).map { (i: Int) -> String in
            "/apis/elasticsearch.k8s.elastic.co/v1/namespaces/ns\(i)/elasticsearches/es\(i)"
        }
        XCTAssertEqual(Array(cluster.paths.dropFirst()), expected)
    }

    func testLabelsAndUnverifiableOwnersAreNeverTrusted() async throws {
        let lone = { (owners: String) in
            [Row(namespace: "logging", name: "quickstart-es-http", labels: Self.eckLabels, ports: Self.https9200,
                 owners: owners)]
        }
        let labelsOnly = Self.cluster(lone("[]"))
        let found = try await DetectedIntegrations.detect(context: "prod", cluster: labelsOnly)
        XCTAssertNotNil(found.elasticsearch)
        XCTAssertFalse(found.elasticsearchOneClick, "ECK labels alone")
        XCTAssertEqual(labelsOnly.paths, ["/api/v1/services"], "nothing claimed, nothing fetched")

        let missing = try await DetectedIntegrations.detect(
            context: "prod", cluster: Self.cluster(lone(Row.esOwner()), owners: [:]))
        XCTAssertFalse(missing.elasticsearchOneClick, "owner resource not found (404)")
        let otherUID = try await DetectedIntegrations.detect(
            context: "prod", cluster: Self.cluster(lone(Row.esOwner()), owners: [Self.esCR: "someone-else"]))
        XCTAssertFalse(otherUID.elasticsearchOneClick, "uid mismatch")
        let forbidden = try await DetectedIntegrations.detect(
            context: "prod", cluster: Self.cluster(lone(Row.esOwner()), forbidden: [Self.esCR]))
        XCTAssertFalse(forbidden.elasticsearchOneClick, "owner resource forbidden (403)")
        let foreign = try await DetectedIntegrations.detect(
            context: "prod",
            cluster: Self.cluster(lone(Row.owner("Elasticsearch", "elasticsearch.k8s.evil.example/v1",
                                                 name: "quickstart", uid: "es-uid"))))
        XCTAssertFalse(foreign.elasticsearchOneClick, "owner from another API group")
        let verified = try await DetectedIntegrations.detect(
            context: "prod", cluster: Self.cluster(lone(Row.esOwner())))
        XCTAssertTrue(verified.elasticsearchOneClick, "verified owner, lone candidate")
    }

    func testAVerifiedOwnerWithASecondCandidateIsReviewOnly() async throws {
        let rows = Self.stack + [Row(namespace: "team-a", name: "foo-es-http", ports: Self.https9200)]
        let found = try await DetectedIntegrations.detect(context: "prod", cluster: Self.cluster(rows))
        XCTAssertEqual(found.elasticsearch?.name, "quickstart-es-http")
        XCTAssertFalse(found.elasticsearchOneClick)
        XCTAssertTrue(found.prometheusOneClick)
    }

    func testDetectGivesUpSilentlyWhenForbidden() async throws {
        let found = try await DetectedIntegrations.detect(context: "prod", cluster: ForbiddenCluster())
        XCTAssertEqual(found, DetectedIntegrations())
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

    func testLookAlikesOfferReviewOnly() async {
        let h = harness(Self.cluster(Self.stack + [
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

        // A verified Elasticsearch outside ECK's service naming: no ECK user.
        let plain = harness(Self.cluster(
            [Row(namespace: "logging", name: "elasticsearch", ports: #"[{"name":"http","port":9200}]"#,
                 owners: Row.esOwner())]))
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
        let h = harness(Self.cluster(Self.stack.filter { $0.namespace == "monitoring" }))
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
        let h = harness(Self.cluster(Self.mixed))
        await h.store.detectIfNeeded(context: "prod")
        XCTAssertFalse(h.store.canEnable(for: "prod"))
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

    func testAPendingReviewIsDroppedOnConnectOrWhenSettingsCloses() async {
        let h = harness()
        await h.store.detectIfNeeded(context: "prod")
        _ = h.store.review(context: "prod")
        XCTAssertNotNil(h.settings.pendingSuggestion)
        h.store.connected("staging")
        XCTAssertNil(h.settings.pendingSuggestion, "a context switch drops it")
        XCTAssertNil(h.settings.takeSuggestion(for: "prod"))

        await h.store.detectIfNeeded(context: "prod")
        _ = h.store.review(context: "prod")
        h.settings.clearPendingSuggestion()  // Settings closed without showing it
        XCTAssertNil(h.settings.takeSuggestion(for: "prod"))
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
