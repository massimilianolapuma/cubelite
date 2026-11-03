import XCTest

@testable import cubelite

// MARK: - Tests

final class ElasticServiceTests: XCTestCase {

    private let base = "https://es.example:9243"
    private lazy var endpoint = EsEndpoint(target: .external(url: base))

    private func service(cluster: [String: String] = [:], secrets: MemorySecrets = MemorySecrets())
        -> ElasticService
    {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [IntegrationStubProtocol.self]
        return ElasticService(
            cluster: StubCluster(objects: cluster), secrets: secrets, configuration: config)
    }

    private let searchResponse = """
        {"hits":{"total":{"value":1,"relation":"eq"},"hits":[
          {"_source":{"@timestamp":"2026-11-03T08:00:00Z","message":"hello","log":{"level":"info"}},"sort":[1,2]}
        ]}}
        """

    func testSearchSendsTheStoredCredentialsToTheirEndpoint() async throws {
        IntegrationStubProtocol.reset(["/logs-*,filebeat-*,logstash-*/_search": (200, searchResponse)])
        let es = service()
        try await es.saveAuth(context: "prod", endpoint: endpoint, auth: .apiKey("abc=="))
        let page = try await es.search(
            context: "prod", endpoint: endpoint,
            query: HistoryQuery(namespace: "shop", pod: "api-0", from: "now-1h", to: "now"))
        XCTAssertEqual(page.lines.map(\.message), ["hello"])
        XCTAssertEqual(page.total, 1)
        let request = try XCTUnwrap(IntegrationStubProtocol.requests.last)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(
            request.url,
            "\(base)/logs-*,filebeat-*,logstash-*/_search?ignore_unavailable=true&allow_no_indices=true"
        )
        XCTAssertEqual(request.authorization, "ApiKey abc==")
        XCTAssertTrue(request.body.contains(#""kubernetes.pod.name":"api-0""#))
    }

    func testCredentialsAreNotSentToAnotherEndpoint() async throws {
        IntegrationStubProtocol.reset(["/logs-*/_search": (200, searchResponse)])
        let es = service()
        try await es.saveAuth(context: "prod", endpoint: endpoint, auth: .apiKey("abc=="))
        let other = EsEndpoint(target: .external(url: "https://evil.example"), indexPattern: "logs-*")
        do {
            _ = try await es.search(
                context: "prod", endpoint: other,
                query: HistoryQuery(namespace: "shop", pod: "api-0", from: "now-1h", to: "now"))
            XCTFail("expected a binding error")
        } catch ElasticError.config(let text) {
            XCTAssertTrue(text.contains("another endpoint"), text)
        }
        XCTAssertTrue(IntegrationStubProtocol.requests.isEmpty, "nothing reached the other host")
        let methodHere = try await es.authMethod(context: "prod", endpoint: endpoint)
        let methodThere = try await es.authMethod(context: "prod", endpoint: other)
        XCTAssertEqual(methodHere, "api-key")
        XCTAssertEqual(methodThere, "none")
        var insecure = endpoint
        insecure.skipTLSVerify = true
        let methodInsecure = try await es.authMethod(context: "prod", endpoint: insecure)
        XCTAssertEqual(methodInsecure, "none", "TLS setting is part of the binding")
    }

    func testSavingNoneDeletesTheSecret() async throws {
        let secrets = MemorySecrets()
        let es = service(secrets: secrets)
        try await es.saveAuth(
            context: "prod", endpoint: endpoint, auth: .basic(username: "u", password: "p"))
        let stored = await secrets.items["prod"]
        XCTAssertNotNil(stored)
        try await es.saveAuth(context: "prod", endpoint: endpoint, auth: .none)
        let deleted = await secrets.items["prod"]
        XCTAssertNil(deleted)
    }

    func testDeletingWorksWithABrokenURL() async throws {
        let secrets = MemorySecrets()
        try await secrets.write(Data("{}".utf8), account: "prod")
        let broken = EsEndpoint(target: .external(url: "not a url"))
        try await service(secrets: secrets).saveAuth(context: "prod", endpoint: broken, auth: .none)
        let left = await secrets.items["prod"]
        XCTAssertNil(left)
    }

    func testHeadersWithControlCharactersAreRefused() async {
        IntegrationStubProtocol.reset(["/": (200, #"{"version":{"number":"8"}}"#)])
        do {
            _ = try await service().test(
                context: "prod", endpoint: endpoint, auth: .bearer("a\r\nX-Injected: 1"))
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? ElasticError, .config("Credentials contain invalid characters"))
        }
        XCTAssertTrue(IntegrationStubProtocol.requests.isEmpty)
        XCTAssertEqual(try Elastic.checkedHeader(.apiKey(" ok== ")), "ApiKey ok==")
        XCTAssertThrowsError(try Elastic.checkedHeader(.apiKey("clé")))
    }

    func testPathSegmentsRefuseDotNames() throws {
        XCTAssertEqual(try Integration.pathSegment("a b/c"), "a%20b%2Fc")
        for bad in ["", ".", ".."] {
            XCTAssertThrowsError(try Integration.pathSegment(bad), bad)
        }
    }

    func testCredentialsOverPlainHTTPAreRefused() async {
        let es = service()
        let plain = EsEndpoint(target: .external(url: "http://es.example"))
        do {
            try await es.saveAuth(context: "prod", endpoint: plain, auth: .bearer("t"))
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? ElasticError, .config("Credentials are only sent over https://"))
        }
    }

    func testErrorsCarryTheServerReason() async {
        IntegrationStubProtocol.reset([
            "/logs-*,filebeat-*,logstash-*/_search": (
                404, #"{"error":{"root_cause":[{"reason":"no such index [logs-x]"}]},"status":404}"#
            )
        ])
        let es = service()
        do {
            _ = try await es.search(
                context: "prod", endpoint: endpoint,
                query: HistoryQuery(namespace: "shop", pod: "api-0", from: "now-1h", to: "now"))
            XCTFail("expected an HTTP error")
        } catch {
            XCTAssertEqual(error as? ElasticError, .http(status: 404, reason: "no such index [logs-x]"))
            XCTAssertNil(IntegrationStubProtocol.requests.last?.authorization)
        }
    }

    func testTestConnectionReportsVersionHealthAndIndices() async throws {
        IntegrationStubProtocol.reset([
            "/": (200, #"{"cluster_name":"prod-logs","version":{"number":"8.15.0"}}"#),
            "/_cluster/health": (200, #"{"status":"yellow"}"#),
            "/_resolve/index/logs-*,filebeat-*,logstash-*": (
                200, #"{"indices":[{"name":"a"}],"data_streams":[{"name":"b"},{"name":"c"}]}"#
            ),
        ])
        let es = service()
        let info = try await es.test(
            context: "prod", endpoint: endpoint, auth: .basic(username: "elastic", password: "pw"))
        XCTAssertEqual(
            info, EsInfo(version: "8.15.0", clusterName: "prod-logs", health: "yellow", indices: 3))
        XCTAssertEqual(
            Set(IntegrationStubProtocol.requests.map(\.authorization)), ["Basic ZWxhc3RpYzpwdw=="])
    }

    func testTestConnectionToleratesMissingHealthRights() async throws {
        IntegrationStubProtocol.reset([
            "/": (200, #"{"cluster_name":"c","version":{"number":"8.0.0"}}"#),
            "/_cluster/health": (403, #"{"error":{"reason":"forbidden"}}"#),
        ])
        let info = try await service().test(context: "prod", endpoint: endpoint, auth: EsAuth.none)
        XCTAssertNil(info.health)
        XCTAssertNil(info.indices)
        XCTAssertEqual(info.version, "8.0.0")
    }

    func testDetectClassifiesClusterServices() async throws {
        let list = """
            {"items":[
              {"metadata":{"name":"quickstart-es-http","namespace":"logging","labels":{"common.k8s.elastic.co/type":"elasticsearch"}},"spec":{"ports":[{"name":"https","port":9200}]}},
              {"metadata":{"name":"quickstart-kb-http","namespace":"logging","labels":{"common.k8s.elastic.co/type":"kibana"}},"spec":{"ports":[{"name":"https","port":5601}]}},
              {"metadata":{"name":"web","namespace":"shop"},"spec":{"ports":[{"port":80}]}}
            ]}
            """
        let found = try await service(cluster: ["/api/v1/services": list]).detect(context: "prod")
        XCTAssertEqual(found.map(\.name), ["quickstart-es-http", "quickstart-kb-http"])
        XCTAssertEqual(found.map(\.kind), [.elasticsearch, .kibana])
    }

    func testEckCredentialsStoreOnlyTheChoice() async throws {
        let secrets = MemorySecrets()
        let password = Data("pw".utf8).base64EncodedString()
        let es = service(
            cluster: [
                "/api/v1/namespaces/logging/secrets/quickstart-es-elastic-user":
                    #"{"data":{"elastic":"\#(password)"}}"#
            ], secrets: secrets)
        let inCluster = EsEndpoint(
            target: .inCluster(
                namespace: "logging", service: "quickstart-es-http", port: 9200, https: true))
        try await es.useEckCredentials(context: "prod", endpoint: inCluster)
        let record = await secrets.items["prod"]
        let stored = try XCTUnwrap(record)
        let text = String(decoding: stored, as: UTF8.self)
        XCTAssertFalse(text.contains("pw"), "the password is never stored")
        XCTAssertTrue(text.contains("eck-user"))
        let method = try await es.authMethod(context: "prod", endpoint: inCluster)
        XCTAssertEqual(method, "eck-user")

        let notEck = EsEndpoint(
            target: .inCluster(namespace: "logging", service: "es", port: 9200, https: false))
        do {
            try await es.useEckCredentials(context: "prod", endpoint: notEck)
            XCTFail("expected a refusal")
        } catch ElasticError.config(let text) {
            XCTAssertTrue(text.contains("not an ECK service"), text)
        }
    }

    func testInClusterConnectNeedsAReadyPod() async {
        let es = service(cluster: [
            "/api/v1/namespaces/logging/services/es-http":
                #"{"metadata":{"name":"es-http"},"spec":{"selector":{"app":"es"},"ports":[{"port":9200}]}}"#,
            "/api/v1/namespaces/logging/pods?labelSelector=app%3Des":
                #"{"items":[{"metadata":{"name":"es-0"},"status":{"phase":"Pending"}}]}"#,
        ])
        let inCluster = EsEndpoint(
            target: .inCluster(namespace: "logging", service: "es-http", port: 9200, https: false))
        do {
            _ = try await es.test(context: "prod", endpoint: inCluster, auth: EsAuth.none)
            XCTFail("expected a connect error")
        } catch {
            XCTAssertEqual(error as? ElasticError, .connect("no ready pod behind logging/es-http"))
        }
    }
}

final class ElasticTunnelTests: XCTestCase {

    func testTunnelListensOnALoopbackPortAndCloses() async throws {
        let (tunnel, port) = try await IntegrationTunnel.open {
            throw ElasticError.connect("unused")
        }
        XCTAssertGreaterThan(port, 0)
        tunnel.close()
        tunnel.close()  // idempotent
    }
}

final class ElasticTrustDelegateTests: XCTestCase {

    func testRedirectsAreNeverFollowed() throws {
        let delegate = IntegrationTrustDelegate(hostname: nil, anchor: nil, insecure: false)
        let from = try XCTUnwrap(URL(string: "https://es.example/_search"))
        let to = try XCTUnwrap(URL(string: "https://evil.example/collect"))
        let response = try XCTUnwrap(
            HTTPURLResponse(
                url: from, statusCode: 302, httpVersion: "HTTP/1.1",
                headerFields: ["Location": to.absoluteString]))
        var next = URLRequest(url: to)
        next.setValue("ApiKey secret", forHTTPHeaderField: "Authorization")
        let task = URLSession.shared.dataTask(with: from)
        var followed: URLRequest? = next
        delegate.urlSession(
            .shared, task: task, willPerformHTTPRedirection: response, newRequest: next
        ) { followed = $0 }
        XCTAssertNil(followed)
    }
}

final class ElasticKibanaForwardTests: XCTestCase {

    func testKibanaForwardIsReusedWhileItsPodIsReady() async throws {
        let kibana = KibanaService(namespace: "logging", service: "quickstart-kb-http", port: 5601, https: true)
        let cluster = ForwardScenario.cluster(kibana)
        let service = ElasticService(cluster: cluster, secrets: MemorySecrets())
        try await ForwardScenario.run(
            cluster: cluster, service: kibana,
            forward: { try await service.kibanaForward(context: "prod", service: kibana) },
            pod: { await service.kibanaPod(context: "prod", service: kibana) },
            disconnect: { await service.disconnect(context: "prod") })
        await service.disconnectAll()
    }
}
