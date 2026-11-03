import XCTest

@testable import cubelite

/// Same vectors as `crates/cubelite-core/src/elastic/tests.rs` (#502).
final class ElasticModelsTests: XCTestCase {

    private func query() -> HistoryQuery {
        HistoryQuery(namespace: "shop", pod: "api-0", from: "now-1h", to: "now")
    }

    private func json(_ text: String) -> JSONValue {
        guard let value = JSONValue.parse(text) else {
            XCTFail("invalid JSON: \(text)")
            return .null
        }
        return value
    }

    private func array(_ value: JSONValue?) -> [JSONValue] {
        if case .array(let items)? = value { return items }
        return []
    }

    func testSearchBodyFiltersPodNamespaceAndTimeNewestFirst() {
        let body = Elastic.searchBody(query(), preset: .ecs)
        XCTAssertEqual(body["size"], .number("500"))
        let filter = array(body["query"]?["bool"]?["filter"])
        XCTAssertTrue(filter.contains(json(#"{"term":{"kubernetes.namespace":"shop"}}"#)))
        XCTAssertTrue(filter.contains(json(#"{"term":{"kubernetes.pod.name":"api-0"}}"#)))
        XCTAssertTrue(
            filter.contains(json(#"{"range":{"@timestamp":{"gte":"now-1h","lte":"now"}}}"#)))
        XCTAssertEqual(
            array(body["sort"]).first,
            json(#"{"@timestamp":{"order":"desc","unmapped_type":"date"}}"#))
        XCTAssertNil(body["search_after"])
        XCTAssertEqual(body["query"]?["bool"]?["must"], .array([]))
    }

    func testSearchBodyAddsContainerTextPagingAndCapsSize() {
        var q = query()
        q.container = "worker"
        q.text = "  timeout \"db\"  "
        // Beyond 2^53: must stay exact in the body.
        q.searchAfter = [.number("1730000000000123456"), .number("42")]
        q.size = 5000
        let body = Elastic.searchBody(q, preset: .fluentBit)
        let filter = array(body["query"]?["bool"]?["filter"])
        XCTAssertTrue(filter.contains(json(#"{"term":{"kubernetes.container_name":"worker"}}"#)))
        XCTAssertTrue(filter.contains(json(#"{"term":{"kubernetes.pod_name":"api-0"}}"#)))
        let text = array(body["query"]?["bool"]?["must"]).first?["simple_query_string"]
        XCTAssertEqual(text?["query"], .string("timeout \"db\""))
        XCTAssertEqual(text?["fields"], json(#"["log"]"#))
        XCTAssertTrue(body.compactText.contains(#""search_after":[1730000000000123456,42]"#))
        XCTAssertEqual(body["size"], .number("1000"))
    }

    func testMapResponseReadsEcsFluentBitAndFlatDocuments() throws {
        let response = json(
            """
            {"hits":{"total":{"value":10000,"relation":"gte"},"hits":[
              {"_source":{"@timestamp":"2026-11-03T08:00:00Z","log":{"level":"WARN"},
                "message":"disk almost full\\n","kubernetes":{"container":{"name":"web"}}},"sort":[3,1]},
              {"_source":{"@timestamp":"2026-11-03T07:59:00Z","log.level":"error",
                "message":"boom","kubernetes.container.name":"web"},"sort":[2,2]},
              {"_source":{"@timestamp":"2026-11-03T07:58:00Z","event":{"original":"ERROR raw"}},"sort":[1,3]}
            ]}}
            """)
        let page = try Elastic.mapResponse(response, preset: .ecs, pageSize: 3)
        XCTAssertEqual(page.total, 10000)
        XCTAssertTrue(page.totalIsLowerBound)
        XCTAssertEqual(page.next, [.number("1"), .number("3")])
        XCTAssertEqual(page.lines.count, 3)
        let (a, b, c) = (page.lines[0], page.lines[1], page.lines[2])
        XCTAssertEqual(a.message, "disk almost full")
        XCTAssertEqual(a.level, .warn)
        XCTAssertEqual(a.container, "web")
        XCTAssertEqual(a.time, "2026-11-03T08:00:00Z")
        XCTAssertTrue(a.document.contains(#""message":"disk almost full\n""#))
        XCTAssertEqual(b.level, .error)
        XCTAssertEqual(b.container, "web")
        XCTAssertEqual(c.message, "ERROR raw")
        XCTAssertEqual(c.level, .error, "detected from the message without a level field")

        let fluent = json(
            #"{"hits":{"total":1,"hits":[{"_source":{"@timestamp":"t","log":"plain line","kubernetes":{"container_name":"c"}}}]}}"#
        )
        let short = try Elastic.mapResponse(fluent, preset: .fluentBit, pageSize: 500)
        XCTAssertEqual(short.total, 1)
        XCTAssertFalse(short.totalIsLowerBound)
        XCTAssertNil(short.next, "short page is the last")
        XCTAssertEqual(short.lines.first?.message, "plain line")
        XCTAssertEqual(short.lines.first?.container, "c")
    }

    func testMapResponseRejectsNonSearchBodies() {
        XCTAssertThrowsError(
            try Elastic.mapResponse(json(#"{"acknowledged":true}"#), preset: .ecs, pageSize: 1)
        ) { error in
            guard case ElasticError.response = error else {
                return XCTFail("expected a response error, got \(error)")
            }
        }
    }

    func testErrorReasonPrefersRootCauseThenStatusText() {
        let body =
            #"{"error":{"root_cause":[{"reason":"no such index [logs-x]"}],"reason":"outer"},"status":404}"#
        XCTAssertEqual(Elastic.errorReason(body: body, status: 404), "no such index [logs-x]")
        XCTAssertEqual(Elastic.errorReason(body: #"{"error":"plain"}"#, status: 400), "plain")
        XCTAssertTrue(Elastic.errorReason(body: "", status: 401).hasPrefix("authentication failed"))
    }

    func testAuthHeadersAndDescriptionsHideSecrets() {
        let basic = EsAuth.basic(username: "elastic", password: "s3cret")
        XCTAssertEqual(basic.header, "Basic ZWxhc3RpYzpzM2NyZXQ=")
        XCTAssertEqual(EsAuth.apiKey(" abc== ").header, "ApiKey abc==")
        XCTAssertEqual(EsAuth.bearer("t").header, "Bearer t")
        XCTAssertNil(EsAuth.none.header)
        XCTAssertNil(EsAuth.eckUser.header)
        XCTAssertEqual("\(basic)", "EsAuth(basic)")
        XCTAssertEqual(String(reflecting: basic), "EsAuth(basic)")
        var dumped = ""
        dump(basic, to: &dumped)
        XCTAssertFalse(dumped.contains("s3cret"))
    }

    func testAuthAndEndpointUseTheDesktopJSONShape() throws {
        let encoded = try JSONEncoder().encode(EsAuth.apiKey("k"))
        XCTAssertEqual(
            try JSONDecoder().decode([String: String].self, from: encoded),
            ["method": "api-key", "key": "k"])
        for auth in [
            EsAuth.none, .basic(username: "u", password: "p"), .apiKey("k"), .bearer("t"),
            .eckUser,
        ] {
            let data = try JSONEncoder().encode(auth)
            XCTAssertEqual(try JSONDecoder().decode(EsAuth.self, from: data), auth)
            XCTAssertEqual(
                JSONValue.parse(String(decoding: data, as: UTF8.self))?["method"],
                .string(auth.method))
        }
        let endpoint = try JSONDecoder().decode(
            EsEndpoint.self,
            from: Data(
                #"{"target":{"kind":"in-cluster","namespace":"logging","service":"quickstart-es-http","port":9200,"https":true},"indexPattern":"logs-*"}"#
                    .utf8))
        XCTAssertEqual(
            endpoint.target,
            .inCluster(namespace: "logging", service: "quickstart-es-http", port: 9200, https: true))
        XCTAssertEqual(endpoint.preset, .ecs)
        XCTAssertFalse(endpoint.skipTLSVerify)
        XCTAssertNil(endpoint.kibanaService, "endpoints saved before #519")
        let withKibana = try JSONDecoder().decode(
            EsEndpoint.self,
            from: Data(
                #"{"target":{"kind":"external","url":"https://es.example"},"indexPattern":"logs-*","kibanaService":{"namespace":"logging","service":"quickstart-kb-http","port":5601,"https":true}}"#
                    .utf8))
        XCTAssertEqual(
            withKibana.kibanaService,
            KibanaService(namespace: "logging", service: "quickstart-kb-http", port: 5601, https: true))
        let external = EsEndpoint(
            target: .external(url: "https://es.example"), preset: .fluentBit,
            kibanaURL: "https://kb.example", skipTLSVerify: true)
        let roundTrip = try JSONDecoder().decode(
            EsEndpoint.self, from: try JSONEncoder().encode(external))
        XCTAssertEqual(roundTrip, external)
        let text = String(decoding: try JSONEncoder().encode(external), as: UTF8.self)
        XCTAssertTrue(text.contains(#""kibanaUrl""#))
        XCTAssertTrue(text.contains(#""skipTlsVerify":true"#))
        XCTAssertTrue(text.contains(#""preset":"fluent-bit""#))
    }

    func testIndexPatternsArePathSafe() {
        XCTAssertNoThrow(try Elastic.validateIndexPattern(EsEndpoint.defaultIndexPattern))
        XCTAssertNoThrow(try Elastic.validateIndexPattern("remote:logs-*"))
        for bad in [
            "", "logs/x", "logs x", "_all", "a?b", "../x", "-x", "..", ".", "logs-*,..",
            "remote:..", "lögs",
        ] {
            XCTAssertThrowsError(try Elastic.validateIndexPattern(bad), bad)
        }
    }

    func testKibanaDiscoverURLEscapesRisonAndKQL() {
        let url = Elastic.kibanaDiscoverURL(
            kibanaBase: "https://kb.example/", preset: .ecs, namespace: "shop", pod: "api-0",
            container: "web", from: "now-1h", to: "now")
        XCTAssertTrue(url.hasPrefix("https://kb.example/app/discover#/?_g="))
        let decoded = url.removingPercentEncoding ?? ""
        XCTAssertTrue(decoded.contains("_g=(time:(from:'now-1h',to:'now'))"))
        XCTAssertTrue(
            decoded.contains(
                #"query:'kubernetes.namespace:"shop" and kubernetes.pod.name:"api-0" and kubernetes.container.name:"web"'"#
            ))
        let tricky = Elastic.kibanaDiscoverURL(
            kibanaBase: "http://k", preset: .ecs, namespace: "it's", pod: "a\"b!", container: nil,
            from: "now-1h", to: "now")
        XCTAssertTrue(tricky.contains("%21%27"), "' escaped as !' in rison")
        XCTAssertTrue(tricky.contains("%21%21"), "! escaped as !! in rison")
        XCTAssertTrue(tricky.contains("%5C%22"), "\" escaped in KQL")
    }

    func testBindingIsTheOriginAndTLSSetting() throws {
        func ext(_ url: String) -> EsEndpoint { EsEndpoint(target: .external(url: url)) }
        let a = try Elastic.binding(ext("https://es.example:9243/"))
        XCTAssertEqual(a, "https://es.example:9243")
        XCTAssertEqual(try Elastic.binding(ext("https://ES.example:9243/some/path")), a)
        XCTAssertEqual(try Elastic.binding(ext("https://es.example:443")), "https://es.example")
        XCTAssertNotEqual(try Elastic.binding(ext("https://evil.example:9243")), a)
        XCTAssertNotEqual(try Elastic.binding(ext("http://es.example:9243")), a)
        var insecure = ext("https://es.example:9243")
        insecure.skipTLSVerify = true
        XCTAssertEqual(try Elastic.binding(insecure), a + "|insecure")
        let inCluster = EsEndpoint(
            target: .inCluster(
                namespace: "logging", service: "quickstart-es-http", port: 9200, https: true))
        XCTAssertEqual(
            try Elastic.binding(inCluster), "in-cluster:logging/quickstart-es-http:9200:https")
        XCTAssertThrowsError(try Elastic.binding(ext("not a url")))
    }

    func testExternalURLRules() throws {
        let key = EsAuth.apiKey("k")
        XCTAssertEqual(
            try Elastic.checkExternalURL(" https://es.example:9243/ ", auth: key).absoluteString,
            "https://es.example:9243")
        XCTAssertNoThrow(try Elastic.checkExternalURL("http://es.example", auth: .none))
        XCTAssertNoThrow(try Elastic.checkExternalURL("http://localhost:9200", auth: key))
        XCTAssertNoThrow(try Elastic.checkExternalURL("http://127.0.0.1:9200", auth: key))
        XCTAssertNoThrow(try Elastic.checkExternalURL("http://[::1]:9200", auth: key))
        for (url, auth) in [
            ("http://es.example", key),
            ("https://u:p@es.example", EsAuth.none),
            ("ftp://es.example", EsAuth.none),
            ("https://es.example", EsAuth.eckUser),
            ("es.example", EsAuth.none),
        ] {
            XCTAssertThrowsError(try Elastic.checkExternalURL(url, auth: auth), url)
        }
    }

    // MARK: Discovery

    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(text.utf8))
    }

    func testTargetPortResolvesNumericNamedAndDefault() throws {
        let pod = try decode(
            IntegrationK8s.Pod.self,
            #"{"spec":{"containers":[{"name":"es","ports":[{"name":"https","containerPort":9201}]}]}}"#)
        let numeric = try decode(
            IntegrationK8s.Service.self, #"{"spec":{"ports":[{"port":9200,"targetPort":9300}]}}"#)
        let named = try decode(
            IntegrationK8s.Service.self, #"{"spec":{"ports":[{"port":9200,"targetPort":"https"}]}}"#)
        let none = try decode(IntegrationK8s.Service.self, #"{"spec":{"ports":[{"port":9200}]}}"#)
        XCTAssertEqual(Integration.targetPort(numeric, port: 9200, pod: pod), 9300)
        XCTAssertEqual(Integration.targetPort(named, port: 9200, pod: pod), 9201)
        XCTAssertEqual(Integration.targetPort(none, port: 9200, pod: pod), 9200)
        XCTAssertNil(Integration.targetPort(none, port: 1234, pod: pod))
    }

    func testReadyPodSkipsPendingAndUnready() throws {
        let pods = try decode(
            [IntegrationK8s.Pod].self,
            """
            [{"metadata":{"name":"a"},"status":{"phase":"Pending"}},
             {"metadata":{"name":"b"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"False"}]}},
             {"metadata":{"name":"c"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]
            """)
        XCTAssertEqual(Integration.readyPod(pods)?.metadata.name, "c")
        XCTAssertNil(Integration.readyPod(Array(pods.prefix(2))))
    }

    func testClassifyFindsEckAndHelmServices() throws {
        let eck = try decode(
            IntegrationK8s.Service.self,
            #"{"metadata":{"name":"quickstart-es-http","namespace":"logging","labels":{"common.k8s.elastic.co/type":"elasticsearch"}},"spec":{"ports":[{"name":"https","port":9200}]}}"#
        )
        let found = try XCTUnwrap(Elastic.classify(eck))
        XCTAssertEqual(found.kind, .elasticsearch)
        XCTAssertEqual(found.port, 9200)
        XCTAssertTrue(found.https)
        let kibana = try decode(
            IntegrationK8s.Service.self,
            #"{"metadata":{"name":"kibana-kibana","namespace":"logging"},"spec":{"ports":[{"name":"http","port":5601}]}}"#
        )
        let kb = try XCTUnwrap(Elastic.classify(kibana))
        XCTAssertEqual(kb.kind, .kibana)
        XCTAssertFalse(kb.https)
        let transport = try decode(
            IntegrationK8s.Service.self,
            #"{"metadata":{"name":"quickstart-es-transport","labels":{"common.k8s.elastic.co/type":"elasticsearch"}},"spec":{"ports":[{"port":9300}]}}"#
        )
        XCTAssertNil(Elastic.classify(transport))
        let other = try decode(
            IntegrationK8s.Service.self, #"{"metadata":{"name":"web"},"spec":{"ports":[{"port":80}]}}"#)
        XCTAssertNil(Elastic.classify(other))
        XCTAssertEqual(
            Integration.serviceHost(namespace: "logging", service: "quickstart-es-http"),
            "quickstart-es-http.logging.svc")
        let selector = try decode(
            IntegrationK8s.Service.self,
            #"{"spec":{"selector":{"b":"2","a":"1"}}}"#)
        XCTAssertEqual(Integration.selector(selector), "a=1,b=2")
    }

    func testFirstPEMCertificateTakesTheFirstBlock() {
        let one = Data([0x30, 0x82, 0x01]).base64EncodedString()
        let two = Data([0xFF]).base64EncodedString()
        let pem =
            "-----BEGIN CERTIFICATE-----\n\(one)\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\n\(two)\n-----END CERTIFICATE-----\n"
        XCTAssertEqual(Integration.firstPEMCertificate(Data(pem.utf8)), Data([0x30, 0x82, 0x01]))
        XCTAssertNil(Integration.firstPEMCertificate(Data("nope".utf8)))
    }
}
