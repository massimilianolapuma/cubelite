import XCTest

@testable import cubelite

/// Integration endpoints shared across contexts (#528): store resolution and
/// persistence, credentials of the default, cluster filter and label picker.
@MainActor
final class EndpointStoreScopeTests: XCTestCase {

    private var defaults: UserDefaults!
    private let shared = PromEndpoint(target: .external(url: "https://ws.prometheus.monitor.azure.com"), cluster: "fallback")

    override func setUp() async throws {
        let suite = "EndpointStoreScopeTests"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
    }

    func testOldSettingsWithoutDefaultsStillLoad() throws {
        let old = #"{"prod":{"target":{"kind":"external","url":"https://p.example"},"cluster":"aks"}}"#
        defaults.set(Data(old.utf8), forKey: "prometheus.endpoints")
        let store = PrometheusEndpointStore(defaults: defaults)
        XCTAssertEqual(store.endpoint(for: "prod"), PromEndpoint(target: .external(url: "https://p.example"), cluster: "aks"))
        XCTAssertNil(store.defaultEndpoint)
        XCTAssertEqual(store.use(of: "prod"), .own)
        XCTAssertEqual(store.use(of: "dev"), .none)
        XCTAssertNil(store.endpoint(for: "dev"))
    }

    func testResolvesOwnThenDefaultUnlessOffAndPersists() {
        let store = PrometheusEndpointStore(defaults: defaults)
        XCTAssertTrue(store.setDefault(shared))
        store.setEndpoint(PromEndpoint(target: .external(url: "https://own.example")), for: "own")
        store.setSettings(PrometheusContextSettings(cluster: "aks-2"), for: "aks-2")
        store.setOff(true, for: "dev")

        XCTAssertEqual(store.endpoint(for: "own")?.target, .external(url: "https://own.example"))
        XCTAssertEqual(store.endpoint(for: "own")?.shared, false)
        XCTAssertEqual(store.endpoint(for: "aks-1")?.cluster, "fallback")
        XCTAssertEqual(store.endpoint(for: "aks-1")?.shared, true)
        XCTAssertEqual(store.endpoint(for: "aks-2")?.cluster, "aks-2")
        XCTAssertNil(store.endpoint(for: "dev"))
        XCTAssertEqual(store.usersOfDefault(["own", "aks-1", "aks-2", "dev"]), ["aks-1", "aks-2"])

        let reloaded = PrometheusEndpointStore(defaults: defaults)
        XCTAssertEqual(reloaded.defaultEndpoint, shared)
        XCTAssertEqual(reloaded.use(of: "dev"), .off)
        XCTAssertEqual(reloaded.contextSettings["aks-2"], PrometheusContextSettings(cluster: "aks-2"))
        XCTAssertEqual(reloaded.endpoint(for: "aks-2")?.cluster, "aks-2")
    }

    func testAnOwnEndpointTurnsTheDefaultBackOn() {
        let store = PrometheusEndpointStore(defaults: defaults)
        store.setDefault(shared)
        store.setOff(true, for: "dev")
        store.setEndpoint(PromEndpoint(target: .external(url: "https://own.example")), for: "dev")
        XCTAssertEqual(store.use(of: "dev"), .own)
        store.setEndpoint(nil, for: "dev")
        XCTAssertEqual(store.use(of: "dev"), .shared)
        store.setDefault(nil)
        XCTAssertNil(store.endpoint(for: "dev"))
        XCTAssertNil(PrometheusEndpointStore(defaults: defaults).defaultEndpoint)
    }

    func testRefusesAnInClusterDefault() {
        let store = PrometheusEndpointStore(defaults: defaults)
        let inCluster = PromEndpoint(
            target: .inCluster(namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false))
        XCTAssertFalse(store.setDefault(inCluster))
        XCTAssertNil(store.defaultEndpoint)
        XCTAssertThrowsError(try Integration.checkShared(inCluster.target, shared: true))
        XCTAssertNoThrow(try Integration.checkShared(inCluster.target, shared: false))
    }

    func testElasticFilterTakesTheDefaultsFieldWhenBlank() {
        let store = ElasticEndpointStore(defaults: defaults)
        store.setDefault(
            EsEndpoint(target: .external(url: "https://es.example"), clusterFilter: ClusterFilter(field: "k8s.cluster", value: "")))
        store.setSettings(ElasticContextSettings(clusterFilter: ClusterFilter(value: "aks-1")), for: "aks-1")
        XCTAssertEqual(store.endpoint(for: "aks-1")?.clusterFilter, ClusterFilter(field: "k8s.cluster", value: "aks-1"))
        XCTAssertEqual(store.endpoint(for: "aks-2")?.clusterFilter, ClusterFilter(field: "k8s.cluster", value: ""))
    }

    func testScopeViews() {
        XCTAssertEqual(ScopeView.of(scope: .allContexts, use: .own, overriding: false), .sharedDefault)
        XCTAssertEqual(ScopeView.of(scope: .context, use: .shared, overriding: false), .inherited)
        XCTAssertEqual(ScopeView.of(scope: .context, use: .shared, overriding: true), .own)
        XCTAssertEqual(ScopeView.of(scope: .context, use: .off, overriding: false), .off)
        XCTAssertEqual(ScopeView.of(scope: .context, use: .none, overriding: false), .own)
        XCTAssertEqual(ScopeText.usedBy(["a", "b"]), "Used by: a, b")
        XCTAssertEqual(ScopeText.usedBy([]), "No context uses the default endpoint yet.")
    }
}

final class IntegrationVaultScopeTests: XCTestCase {

    private func vault() -> (IntegrationVault<PromAuth>, MemorySecrets) {
        let secrets = MemorySecrets()
        return (IntegrationVault(store: secrets, none: PromAuth.none), secrets)
    }

    func testTheDefaultsCredentialsAreSavedOnceAndFoundBySharedEndpointsOnly() async throws {
        let (vault, secrets) = vault()
        try await vault.save(context: "aks-1", shared: true, binding: "https://ws", auth: .bearer("t"))
        let accounts = await secrets.items.keys.sorted()
        XCTAssertEqual(accounts, [Integration.defaultAccount])
        let viaDefault = try await vault.load(context: "aks-2", binding: "https://ws", shared: true)
        XCTAssertEqual(viaDefault, .bearer("t"))
        // A context's own endpoint never reads the default's account.
        let own = try await vault.load(context: "aks-2", binding: "https://ws", shared: false)
        XCTAssertEqual(own, PromAuth.none)
    }

    func testTheDefaultsCredentialsNeverGoToAnotherBinding() async throws {
        let (vault, _) = vault()
        try await vault.save(context: "x", shared: true, binding: "https://ws", auth: .bearer("t"))
        do {
            _ = try await vault.load(context: "aks-1", binding: "https://evil", shared: true)
            XCTFail("expected a binding error")
        } catch let failure as IntegrationFailure {
            XCTAssertEqual(
                failure,
                .config("The saved credentials belong to another endpoint or TLS setting; save them again for this one"))
        }
        let stored = try await vault.stored(context: "aks-1", binding: "https://evil", shared: true)
        XCTAssertNil(stored)
    }

    func testTheContextsOwnRecordWinsAndAStaleOneDoesNotHideTheDefault() async throws {
        let (vault, _) = vault()
        try await vault.save(context: "x", shared: true, binding: "https://ws", auth: .bearer("default"))
        try await vault.save(context: "aks-1", binding: "https://ws", auth: .bearer("own"))
        try await vault.save(context: "aks-2", binding: "https://old", auth: .bearer("stale"))
        let own = try await vault.load(context: "aks-1", binding: "https://ws", shared: true)
        XCTAssertEqual(own, .bearer("own"))
        let fallback = try await vault.load(context: "aks-2", binding: "https://ws", shared: true)
        XCTAssertEqual(fallback, .bearer("default"))
        // Without the default, a record of another endpoint is an error.
        do {
            _ = try await vault.load(context: "aks-2", binding: "https://ws")
            XCTFail("expected a binding error")
        } catch is IntegrationFailure {}
    }

    func testAzureCLIStoresTheChoiceOnly() async throws {
        let (vault, secrets) = vault()
        try await vault.save(context: "x", shared: true, binding: "https://ws", auth: .azureCLI)
        let method = try await vault.stored(context: "aks-1", binding: "https://ws", shared: true)?.method
        XCTAssertEqual(method, "azure-cli")
        let data = await secrets.items[Integration.defaultAccount]
        let text = String(decoding: try XCTUnwrap(data), as: UTF8.self)
        XCTAssertFalse(text.contains("token"), text)
    }
}

final class ClusterScopeHelpersTests: XCTestCase {

    func testMatchClusterLabel() {
        let values = ["aks-prod", "aks-prod-weu", "aks-test", "dev"]
        XCTAssertEqual(ClusterLabel.match(values, context: "AKS-PROD"), "aks-prod")
        XCTAssertEqual(ClusterLabel.match(["aks-prod-weu-2", "aks-prod-weu"], context: "aks-prod"), "aks-prod-weu")
        XCTAssertEqual(ClusterLabel.match(values, context: "admin@aks-test"), "aks-test")
        XCTAssertEqual(ClusterLabel.match(["dev", "dev-eu"], context: "user@dev-eu-1"), "dev-eu")
        XCTAssertNil(ClusterLabel.match(values, context: "staging"))
    }

    func testLabelValuesPathAndAnswer() throws {
        XCTAssertEqual(
            try ClusterLabel.valuesPath(label: "cluster", matches: ClusterLabel.series),
            "/api/v1/label/cluster/values?match%5B%5D=container_cpu_usage_seconds_total&match%5B%5D=kube_pod_info")
        XCTAssertEqual(try ClusterLabel.valuesPath(label: "_x1", matches: []), "/api/v1/label/_x1/values")
        for bad in ["", "1abc", "a/b", "a-b", "../x"] {
            XCTAssertThrowsError(try ClusterLabel.valuesPath(label: bad, matches: []), bad)
        }
        let data = try XCTUnwrap(JSONValue.parse(#"["aks-test", "", "aks-prod", "aks-test"]"#))
        XCTAssertEqual(ClusterLabel.values(data), ["aks-prod", "aks-test"])
    }

    func testClusterFilterTermAndSearchBody() throws {
        XCTAssertEqual(ClusterFilter(value: " aks ").term(preset: .ecs)?.field, ClusterFilter.ecsField)
        XCTAssertNil(ClusterFilter(value: "aks").term(preset: .fluentBit))
        XCTAssertEqual(ClusterFilter(field: "cluster", value: "eu").term(preset: .fluentBit)?.value, "eu")
        XCTAssertNil(ClusterFilter(field: "cluster", value: " ").term(preset: .ecs))
        XCTAssertNil(ClusterFilter.typed(field: " ", value: ""))

        // The shape `Elastic.searchBody` builds.
        let body = try XCTUnwrap(JSONValue.parse(#"{"size":1,"query":{"bool":{"filter":[{"term":{"a":"b"}}],"must":[]}}}"#))
        let filtered = Elastic.addingClusterFilter(body, ClusterFilter(value: "aks-prod"), preset: .ecs)
        XCTAssertTrue(filtered.compactText.contains(#"{"term":{"orchestrator.cluster.name":"aks-prod"}}"#), filtered.compactText)
        XCTAssertEqual(Elastic.addingClusterFilter(body, nil, preset: .ecs), body)
    }

    func testOldEndpointsDecodeWithoutTheNewFields() throws {
        let json = #"{"target":{"kind":"external","url":"https://es"},"indexPattern":"logs-*"}"#
        let endpoint = try JSONDecoder().decode(EsEndpoint.self, from: Data(json.utf8))
        XCTAssertNil(endpoint.clusterFilter)
        XCTAssertFalse(endpoint.shared)
        let filter = try JSONDecoder().decode(ClusterFilter.self, from: Data(#"{"value":"eu"}"#.utf8))
        XCTAssertEqual(filter, ClusterFilter(field: "", value: "eu"))
    }
}

private actor ScopeStubBackend: PrometheusPreferencesBackend {
    var saved: [(PromEndpoint, PromAuth)] = []
    var tested: [(PromEndpoint, PromAuth?)] = []
    var disconnected: [String] = []

    func detect(context: String) async throws -> [DetectedPrometheus] { [] }
    func disconnect(context: String) async { disconnected.append(context) }

    func test(context: String, endpoint: PromEndpoint, auth: PromAuth?) async throws -> PromInfo {
        tested.append((endpoint, auth))
        return PromInfo(version: "unknown", cadvisor: true, kubeStateMetrics: true, clusters: ["aks-dev", "aks-prod-weu"])
    }

    func saveAuth(context: String, endpoint: PromEndpoint, auth: PromAuth) async throws {
        saved.append((endpoint, auth))
    }

    func authMethod(context: String, endpoint: PromEndpoint) async throws -> String { "none" }
}

@MainActor
final class PrometheusScopeModelTests: XCTestCase {

    private var endpoints: PrometheusEndpointStore!
    private let shared = PromEndpoint(target: .external(url: "https://ws-1.westeurope.prometheus.monitor.azure.com"))

    override func setUp() async throws {
        let suite = "PrometheusScopeModelTests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        endpoints = PrometheusEndpointStore(defaults: defaults)
    }

    func testSavesAnExternalDefaultWithItsCredentialsUnderTheDefault() async {
        let backend = ScopeStubBackend()
        let model = PrometheusPreferencesModel(backend: backend, endpoints: endpoints)
        await model.load(context: "aks-prod")
        await model.setScope(.allContexts)
        XCTAssertEqual(model.view, .sharedDefault)
        model.target.mode = .external
        model.target.url = "https://ws-1.westeurope.prometheus.monitor.azure.com"
        model.authMethod = .azureCLI
        await model.save()
        XCTAssertEqual(model.outcome, FormOutcome(ok: true, text: "Prometheus default endpoint saved"))
        XCTAssertEqual(endpoints.defaultEndpoint?.target, shared.target)
        XCTAssertEqual(endpoints.defaultEndpoint?.shared, false)
        let saved = await backend.saved
        XCTAssertEqual(saved.map(\.0.shared), [true])
        XCTAssertEqual(saved.map(\.1), [.azureCLI])
        XCTAssertEqual(endpoints.endpoint(for: "aks-test")?.shared, true)
    }

    func testAContextUsingTheDefaultPicksItsClusterLabel() async {
        endpoints.setDefault(shared)
        let backend = ScopeStubBackend()
        let model = PrometheusPreferencesModel(backend: backend, endpoints: endpoints)
        await model.load(context: "aks-prod")
        XCTAssertEqual(model.view, .inherited)
        XCTAssertFalse(model.isIncomplete)
        await model.test()
        let tested = await backend.tested
        XCTAssertEqual(tested.first?.0.shared, true)
        XCTAssertNil(tested.first?.1 ?? nil)
        XCTAssertEqual(model.foundClusters, ["aks-dev", "aks-prod-weu"])
        XCTAssertEqual(model.cluster, "aks-prod-weu", "preselects the value containing the context name")
        await model.save()
        XCTAssertEqual(endpoints.contextSettings["aks-prod"], PrometheusContextSettings(cluster: "aks-prod-weu"))
        XCTAssertEqual(endpoints.endpoint(for: "aks-prod")?.cluster, "aks-prod-weu")
        let saved = await backend.saved
        XCTAssertTrue(saved.isEmpty)
    }

    func testTurnOffOverrideAndUseTheDefaultAgain() async {
        endpoints.setDefault(shared)
        let backend = ScopeStubBackend()
        let model = PrometheusPreferencesModel(backend: backend, endpoints: endpoints)
        var dismissed: [String] = []
        model.onTurnedOff = { dismissed.append($0) }
        await model.load(context: "aks-prod")
        await model.turnOff()
        XCTAssertEqual(model.view, .off)
        XCTAssertNil(endpoints.endpoint(for: "aks-prod"))
        XCTAssertEqual(dismissed, ["aks-prod"])
        await model.useDefault()
        XCTAssertEqual(model.view, .inherited)

        await model.override()
        XCTAssertEqual(model.view, .own)
        XCTAssertEqual(model.target.url, "https://ws-1.westeurope.prometheus.monitor.azure.com", "starts from the default")
        model.target.url = "https://own.example"
        await model.save()
        XCTAssertEqual(endpoints.ownEndpoint(for: "aks-prod")?.target, .external(url: "https://own.example"))
        await model.useDefault()
        XCTAssertNil(endpoints.ownEndpoint(for: "aks-prod"))
        let saved = await backend.saved
        XCTAssertEqual(saved.last?.1, PromAuth.none, "the own endpoint's credentials are removed")
        XCTAssertEqual(saved.last?.0.target, .external(url: "https://own.example"))
    }
}
