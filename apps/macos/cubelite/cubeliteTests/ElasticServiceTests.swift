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

    // MARK: Point in time (#531)

    private let pitPath = "/logs-*,filebeat-*,logstash-*/_pit"

    /// A newest-first `_search` response on point in time `pit`.
    private func pitPage(_ pit: String, sorts: [[Int]]) -> String {
        let hits = sorts.map {
            #"{"_source":{"@timestamp":"t","message":"m\#($0[0])"},"sort":[\#($0[0]),\#($0[1])]}"#
        }
        return #"{"pit_id":"\#(pit)","hits":{"total":{"value":3,"relation":"eq"},"hits":["#
            + hits.joined(separator: ",") + "]}}"
    }

    func testHistoryPagesOnAPointInTimeAndClosesItAtTheEnd() async throws {
        let searches = StubCounter()
        let first = pitPage("pit-b", sorts: [[3, 9], [2, 8]])
        let last = pitPage("pit-c", sorts: [[1, 7]])
        IntegrationStubProtocol.reset(
            [pitPath: (200, #"{"id":"pit-a"}"#), "/_pit": (200, #"{"succeeded":true}"#)],
            handle: { request in
                guard request.url?.path == "/_search" else { return nil }
                return (200, searches.next() == 0 ? first : last)
            })
        let es = service()
        var query = HistoryQuery(namespace: "shop", pod: "api-0", from: "now-1h", to: "now", size: 2)
        let page = try await es.search(context: "prod", endpoint: endpoint, query: query)
        XCTAssertEqual(page.lines.first?.message, "m3")
        XCTAssertEqual(page.next, HistoryCursor(pitID: "pit-b", sort: [.number("2"), .number("8")]))
        query.searchAfter = page.next
        let older = try await es.search(context: "prod", endpoint: endpoint, query: query)
        XCTAssertEqual(older.lines.map(\.message), ["m1"])
        XCTAssertNil(older.next, "short page is the last")

        let requests = IntegrationStubProtocol.requests
        XCTAssertEqual(requests.map(\.method), ["POST", "POST", "POST", "DELETE"])
        XCTAssertEqual(requests[0].url, "\(base)\(pitPath)?keep_alive=5m&ignore_unavailable=true")
        XCTAssertEqual(requests[1].url, "\(base)/_search", "no index with a PIT")
        let firstBody = JSONValue.parse(requests[1].body)
        XCTAssertEqual(firstBody?["pit"], JSONValue.parse(#"{"id":"pit-a","keep_alive":"5m"}"#))
        XCTAssertNil(firstBody?["search_after"])
        let olderBody = JSONValue.parse(requests[2].body)
        XCTAssertEqual(olderBody?["pit"]?["id"], .string("pit-b"), "Load older reuses the updated id")
        XCTAssertEqual(olderBody?["search_after"], JSONValue.parse("[2,8]"))
        XCTAssertEqual(requests[3].url, "\(base)/_pit", "closed after the last page")
        XCTAssertEqual(JSONValue.parse(requests[3].body), JSONValue.parse(#"{"id":"pit-c"}"#))
    }

    func testHistoryFallsBackToSearchAfterWithoutPITAndRemembersIt() async throws {
        IntegrationStubProtocol.reset([
            pitPath: (403, #"{"error":{"reason":"unauthorized"}}"#),
            "/logs-*,filebeat-*,logstash-*/_search": (200, searchResponse),
        ])
        let es = service()
        let page = try await es.search(
            context: "prod", endpoint: endpoint,
            query: HistoryQuery(namespace: "shop", pod: "api-0", from: "now-1h", to: "now"))
        XCTAssertEqual(page.lines.map(\.message), ["hello"])
        let again = try await es.search(
            context: "prod", endpoint: endpoint,
            query: HistoryQuery(namespace: "shop", pod: "api-0", from: "now-1h", to: "now", size: 1))
        XCTAssertEqual(again.next, HistoryCursor(pitID: nil, sort: [.number("1"), .number("2")]))
        let requests = IntegrationStubProtocol.requests
        XCTAssertEqual(requests.count, 3, "the PIT is probed once per connection")
        XCTAssertTrue(requests[0].url.contains("/_pit?"))
        for request in requests.dropFirst() {
            XCTAssertTrue(request.url.contains("logstash-*/_search?ignore_unavailable=true"))
            XCTAssertNil(JSONValue.parse(request.body)?["pit"])
        }
    }

    func testAnExpiredPointInTimeResumesAtTheBoundaryOnANewOne() async throws {
        let searches = StubCounter()
        let expired = #"{"error":{"root_cause":[{"reason":"No search context found"}]},"status":404}"#
        let resumed = pitPage("pit-new", sorts: [[1, 7]])
        IntegrationStubProtocol.reset(
            [pitPath: (200, #"{"id":"pit-new"}"#), "/_pit": (200, #"{"succeeded":true}"#)],
            handle: { request in
                guard request.url?.path == "/_search" else { return nil }
                return searches.next() == 0 ? (404, expired) : (200, resumed)
            })
        let es = service()
        var query = HistoryQuery(namespace: "shop", pod: "api-0", from: "now-1h", to: "now")
        query.searchAfter = HistoryCursor(pitID: "pit-old", sort: [.number("2"), .number("8")])
        let page = try await es.search(context: "prod", endpoint: endpoint, query: query)
        XCTAssertEqual(page.lines.map(\.message), ["m1"])
        let requests = IntegrationStubProtocol.requests
        XCTAssertEqual(requests.map(\.method), ["POST", "POST", "POST", "DELETE"])
        XCTAssertEqual(JSONValue.parse(requests[0].body)?["pit"]?["id"], .string("pit-old"))
        XCTAssertTrue(requests[1].url.contains("/_pit?"))
        let body = JSONValue.parse(requests[2].body)
        XCTAssertEqual(body?["pit"]?["id"], .string("pit-new"))
        XCTAssertEqual(
            body?["search_after"], JSONValue.parse("[2,9223372036854775807]"),
            "the old _shard_doc means nothing on a new PIT: resume at the boundary millisecond")
    }

    func testOtherPITOpenFailuresPageWithoutPITForThatRequestOnly() async throws {
        let opens = StubCounter()
        IntegrationStubProtocol.reset(
            [
                "/logs-*,filebeat-*,logstash-*/_search": (200, searchResponse),
                "/_search": (200, pitPage("pit-a", sorts: [[1, 7]])),
                "/_pit": (200, #"{"succeeded":true}"#),
            ],
            handle: { request in
                guard request.url?.path == "/logs-*,filebeat-*,logstash-*/_pit" else { return nil }
                return opens.next() == 0
                    ? (429, #"{"error":{"reason":"too many Point In Time contexts"}}"#)
                    : (200, #"{"id":"pit-a"}"#)
            })
        let es = service()
        let query = HistoryQuery(namespace: "shop", pod: "api-0", from: "now-1h", to: "now")
        let plain = try await es.search(context: "prod", endpoint: endpoint, query: query)
        XCTAssertEqual(plain.lines.map(\.message), ["hello"])
        let onPIT = try await es.search(context: "prod", endpoint: endpoint, query: query)
        XCTAssertEqual(onPIT.lines.map(\.message), ["m1"], "probed again: a 429 is not remembered")
        let urls = IntegrationStubProtocol.requests.map(\.url)
        XCTAssertTrue(urls[1].contains("logstash-*/_search?"))
        XCTAssertTrue(urls[2].contains("/_pit?"))
        XCTAssertEqual(urls[3], "\(base)/_search")
    }

    func testAPITWithoutShardDocClosesItAndPagesWithoutPIT() async throws {
        IntegrationStubProtocol.reset([
            pitPath: (200, #"{"id":"pit-7"}"#),
            "/_search": (400, #"{"error":{"reason":"No mapping found for [_shard_doc]"}}"#),
            "/_pit": (200, #"{"succeeded":true}"#),
            "/logs-*,filebeat-*,logstash-*/_search": (200, searchResponse),
        ])
        let es = service()
        let query = HistoryQuery(namespace: "shop", pod: "api-0", from: "now-1h", to: "now")
        let page = try await es.search(context: "prod", endpoint: endpoint, query: query)
        XCTAssertEqual(page.lines.map(\.message), ["hello"])
        _ = try await es.search(context: "prod", endpoint: endpoint, query: query)
        let requests = IntegrationStubProtocol.requests
        XCTAssertEqual(requests.map(\.method), ["POST", "POST", "DELETE", "POST", "POST"])
        XCTAssertEqual(JSONValue.parse(requests[2].body), JSONValue.parse(#"{"id":"pit-7"}"#))
        XCTAssertTrue(requests[3].url.contains("logstash-*/_search?"))
        XCTAssertTrue(requests[4].url.contains("logstash-*/_search?"), "no probe on this connection")
    }

    func testClosingACursorDeletesItsPointInTimeThroughTheOpenConnection() async throws {
        IntegrationStubProtocol.reset([
            pitPath: (404, ""),
            "/logs-*,filebeat-*,logstash-*/_search": (200, searchResponse),
            "/_pit": (404, #"{"succeeded":true,"num_freed":0}"#),
        ])
        let es = service()
        let cursor = HistoryCursor(pitID: "pit-z", sort: [.number("1")])
        await es.closeCursor(context: "prod", endpoint: endpoint, cursor: cursor)
        XCTAssertTrue(IntegrationStubProtocol.requests.isEmpty, "never connects just to close")
        _ = try await es.search(
            context: "prod", endpoint: endpoint,
            query: HistoryQuery(namespace: "shop", pod: "api-0", from: "now-1h", to: "now"))
        await es.closeCursor(context: "prod", endpoint: endpoint, cursor: cursor)
        let close = try XCTUnwrap(IntegrationStubProtocol.requests.last)
        XCTAssertEqual(close.method, "DELETE")
        XCTAssertEqual(close.url, "\(base)/_pit")
        XCTAssertEqual(JSONValue.parse(close.body), JSONValue.parse(#"{"id":"pit-z"}"#))
    }
}

/// Counts calls across the stub protocol's threads.
private final class StubCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    /// The number of earlier calls.
    func next() -> Int {
        lock.withLock {
            defer { count += 1 }
            return count
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
