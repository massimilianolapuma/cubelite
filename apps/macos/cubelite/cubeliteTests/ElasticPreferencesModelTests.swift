import XCTest

@testable import cubelite

/// Records what the form asks the backend; stores methods per binding.
private actor StubBackend: ElasticPreferencesBackend {
    var saved: [(EsEndpoint, EsAuth)] = []
    var eck: [EsEndpoint] = []
    var tested: [EsAuth?] = []
    var stored: [String: String] = [:]
    var info = EsInfo(version: "8.15.0", clusterName: "logs", health: "green", indices: 2)

    func detect(context: String) async throws -> [DetectedService] {
        [
            DetectedService(
                kind: .elasticsearch, namespace: "logging", name: "quickstart-es-http", port: 9200,
                https: true),
            DetectedService(
                kind: .kibana, namespace: "logging", name: "quickstart-kb-http", port: 5601,
                https: true),
        ]
    }

    func test(context: String, endpoint: EsEndpoint, auth: EsAuth?) async throws -> EsInfo {
        tested.append(auth)
        return info
    }

    func saveAuth(context: String, endpoint: EsEndpoint, auth: EsAuth) async throws {
        saved.append((endpoint, auth))
        stored[try Elastic.binding(endpoint)] = auth.method
    }

    func authMethod(context: String, endpoint: EsEndpoint) async throws -> String {
        stored[try Elastic.binding(endpoint)] ?? "none"
    }

    func useEckCredentials(context: String, endpoint: EsEndpoint) async throws {
        eck.append(endpoint)
        stored[try Elastic.binding(endpoint)] = "eck-user"
    }
}

@MainActor
final class ElasticPreferencesModelTests: XCTestCase {

    private var endpoints: ElasticEndpointStore!

    override func setUp() async throws {
        let suite = "ElasticPreferencesModelTests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        endpoints = ElasticEndpointStore(defaults: defaults)
    }

    func testSavingAnExternalEndpointStoresItAndTheKey() async {
        let backend = StubBackend()
        let model = ElasticPreferencesModel(backend: backend, endpoints: endpoints)
        await model.load(context: "prod")
        XCTAssertEqual(model.target.mode, .off)
        model.target.mode = .external
        model.target.url = " https://es.example:9243 "
        model.authMethod = .apiKey
        model.input.secret = "abc=="
        model.kibanaURL = "https://kb.example"
        await model.save()
        XCTAssertEqual(model.outcome, .init(ok: true, text: "Elasticsearch saved for prod"))
        let saved = endpoints.endpoint(for: "prod")
        XCTAssertEqual(saved?.target, .external(url: "https://es.example:9243"))
        XCTAssertEqual(saved?.kibanaURL, "https://kb.example")
        let calls = await backend.saved
        XCTAssertEqual(calls.map(\.1), [.apiKey("abc==")])
        XCTAssertEqual(model.input.secret, "", "secrets are not kept in the form")
        XCTAssertEqual(model.storedMethod, .apiKey)
    }

    func testMovingTheEndpointNeedsTheCredentialsAgain() async {
        let backend = StubBackend()
        let model = ElasticPreferencesModel(backend: backend, endpoints: endpoints)
        await model.load(context: "prod")
        model.target.mode = .external
        model.target.url = "https://es.example"
        model.authMethod = .bearer
        model.input.secret = "t"
        await model.save()

        model.target.url = "https://other.example"
        await model.save()
        XCTAssertEqual(model.outcome?.ok, false)
        XCTAssertTrue(model.outcome?.text.contains("enter the credentials again") ?? false)
        XCTAssertEqual(endpoints.endpoint(for: "prod")?.target, .external(url: "https://es.example"))
    }

    func testTurningOffDeletesTheSecretAndEndpoint() async {
        let backend = StubBackend()
        endpoints.setEndpoint(EsEndpoint(target: .external(url: "https://es.example")), for: "prod")
        let model = ElasticPreferencesModel(backend: backend, endpoints: endpoints)
        await model.load(context: "prod")
        XCTAssertEqual(model.target.mode, .external)
        model.target.mode = .off
        await model.save()
        XCTAssertNil(endpoints.endpoint(for: "prod"))
        let calls = await backend.saved
        XCTAssertEqual(calls.map(\.1), [.none])
    }

    func testEckChoiceAndDetection() async {
        let backend = StubBackend()
        let model = ElasticPreferencesModel(backend: backend, endpoints: endpoints)
        await model.load(context: "prod")
        model.target.mode = .inCluster
        await model.detect()
        XCTAssertEqual(model.detected?.map(\.name), ["quickstart-es-http"])
        XCTAssertEqual(model.detectedKibana.map(\.name), ["quickstart-kb-http"])
        model.pick(model.detected![0])
        model.pickKibana(model.detectedKibana[0])
        XCTAssertEqual(model.authMethods.last, .eckUser)
        model.authMethod = .eckUser
        await model.save()
        let eck = await backend.eck
        XCTAssertEqual(
            eck.map(\.target),
            [.inCluster(namespace: "logging", service: "quickstart-es-http", port: 9200, https: true)])
        XCTAssertEqual(model.storedMethod, .eckUser)
        XCTAssertEqual(
            endpoints.endpoint(for: "prod")?.kibanaService,
            KibanaService(namespace: "logging", service: "quickstart-kb-http", port: 5601, https: true))
        model.target.mode = .external
        model.target.url = "https://es.example"
        XCTAssertNil(model.draft()?.kibanaService, "only in-cluster endpoints forward to Kibana")
    }

    func testValidationAndLoadingAnotherContextClearsTheForm() async {
        let model = ElasticPreferencesModel(backend: StubBackend(), endpoints: endpoints)
        await model.load(context: "prod")
        model.target.mode = .external
        model.target.url = "https://user:pw@es.example"
        XCTAssertNotNil(model.target.urlProblem)
        XCTAssertTrue(model.isIncomplete)
        XCTAssertFalse(model.authMethods.contains(.eckUser))
        model.target.url = "https://es.example"
        model.kibanaURL = "ftp://kb"
        XCTAssertEqual(model.kibanaProblem, "Use an http:// or https:// URL.")
        model.kibanaURL = ""
        XCTAssertFalse(model.isIncomplete)
        model.input.secret = "typed"
        await model.load(context: "dev")
        XCTAssertEqual(model.target.mode, .off)
        XCTAssertEqual(model.target.url, "")
        XCTAssertEqual(model.input.secret, "")
    }

    func testSaveStoresTheEndpointEvenAfterAContextSwitch() async {
        let backend = StubBackend()
        let model = ElasticPreferencesModel(backend: backend, endpoints: endpoints)
        await model.load(context: "prod")
        model.target.mode = .external
        model.target.url = "https://es.example"
        let saving = Task { await model.save() }
        while model.busy != .save { await Task.yield() }
        await model.load(context: "dev")
        await saving.value
        XCTAssertEqual(endpoints.endpoint(for: "prod")?.target, .external(url: "https://es.example"))
        XCTAssertNil(endpoints.endpoint(for: "dev"))
    }

    func testLeavingInClusterDropsTheEckMethod() async {
        let backend = StubBackend()
        let model = ElasticPreferencesModel(backend: backend, endpoints: endpoints)
        await model.load(context: "prod")
        model.target.mode = .inCluster
        model.target.namespace = "logging"
        model.target.service = "quickstart-es-http"
        model.authMethod = .eckUser
        await model.useEck()
        XCTAssertEqual(model.storedMethod, .eckUser)
        XCTAssertEqual(model.outcome?.ok, true)
        model.target.mode = .external
        XCTAssertEqual(model.authMethod, .none)
    }

    func testTestConnectionUsesTypedOrStoredCredentials() async {
        let backend = StubBackend()
        let model = ElasticPreferencesModel(backend: backend, endpoints: endpoints)
        await model.load(context: "prod")
        model.target.mode = .external
        model.target.url = "https://es.example"
        model.authMethod = .basic
        model.input.username = "elastic"
        model.input.password = "pw"
        await model.test()
        XCTAssertEqual(
            model.outcome?.text, "Elasticsearch 8.15.0 · logs · health green · 2 matching indices or data streams")
        model.input.password = ""
        await model.test()
        let tested = await backend.tested
        XCTAssertEqual(tested, [.basic(username: "elastic", password: "pw"), nil])
    }
}
