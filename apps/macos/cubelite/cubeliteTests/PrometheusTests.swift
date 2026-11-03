import XCTest

@testable import cubelite

/// Same vectors as `crates/cubelite-core/src/prometheus/tests.rs` (#511).
final class PrometheusModelsTests: XCTestCase {

    private func json(_ text: String) -> JSONValue {
        guard let value = JSONValue.parse(text) else {
            XCTFail("invalid JSON: \(text)")
            return .null
        }
        return value
    }

    func testSelectorsMatchPodsDeploymentsAndStatefulSetsLiterally() {
        XCTAssertEqual(
            Prometheus.selector(namespace: "shop", workload: .pod("api-0"), cluster: nil),
            #"namespace="shop", pod="api-0""#)
        XCTAssertEqual(
            Prometheus.selector(namespace: "shop", workload: .deployment("api.v2"), cluster: " aks-prod "),
            #"namespace="shop", pod=~"api\\.v2-[bcdfghjklmnpqrstvwxz2456789]{6,10}-[bcdfghjklmnpqrstvwxz2456789]{5}", cluster="aks-prod""#
        )
        XCTAssertEqual(
            Prometheus.selector(namespace: "shop", workload: .statefulSet("db"), cluster: ""),
            #"namespace="shop", pod=~"db-[0-9]+""#)
        XCTAssertEqual(Prometheus.escape("a\"b\\c\nd"), #""a\"b\\c\nd""#)
    }

    func testDeploymentRegexMatchesItsPodsOnly() throws {
        func matches(_ name: String, _ pod: String) throws -> Bool {
            let regex = try NSRegularExpression(pattern: "^(?:\(Prometheus.deploymentPods(name)))$")
            return regex.firstMatch(in: pod, range: NSRange(pod.startIndex..., in: pod)) != nil
        }
        XCTAssertTrue(try matches("api", "api-7c9f8b6d54-x2kzq"))
        XCTAssertFalse(try matches("api", "api-28345678-ab0cd"), "CronJob pod")
        XCTAssertFalse(try matches("api", "api-gateway-7c9f8b6d54-x2kzq"))
        let long = String(repeating: "a", count: 50)
        let truncated = String("\(long)-7c9f8b6".prefix(58))
        XCTAssertTrue(try matches(long, truncated + "x2kzq"), "generateName cut at 58 characters")
    }

    func testChartQueriesGroupByContainerOrSum() {
        let sel = #"namespace="shop", pod="api-0""#
        XCTAssertEqual(
            Prometheus.chartQuery(.cpu, selector: sel, perContainer: true, window: 60),
            #"sum by (container) (rate(container_cpu_usage_seconds_total{namespace="shop", pod="api-0", container!="", container!="POD"}[60s]))"#
        )
        XCTAssertEqual(
            Prometheus.chartQuery(.memoryLimit, selector: sel, perContainer: false, window: 60),
            #"sum(kube_pod_container_resource_limits{namespace="shop", pod="api-0", resource="memory"})"#)
        XCTAssertEqual(
            Prometheus.chartQuery(.restarts, selector: sel, perContainer: true, window: 360),
            #"sum by (container) (kube_pod_container_status_restarts_total{namespace="shop", pod="api-0"})"#)
        XCTAssertEqual(
            Prometheus.chartQuery(.networkTx, selector: sel, perContainer: true, window: 60),
            #"sum(rate(container_network_transmit_bytes_total{namespace="shop", pod="api-0"}[60s]))"#)
        let queries = Prometheus.metricsQueries(
            MetricsRequest(namespace: "shop", workload: .pod("api-0"), range: .day, perContainer: false),
            cluster: nil)
        XCTAssertEqual(queries.map(\.0), Chart.allCases)
        XCTAssertTrue(queries[0].1.contains("[1440s]"))
        XCTAssertEqual(
            queries.first { $0.0 == .restartsTotal }?.1,
            #"sum(increase(kube_pod_container_status_restarts_total{namespace="shop", pod="api-0"}[86400s]))"#)
    }

    func testStepsAndWindowsFollowTheRange() {
        XCTAssertEqual(MetricsRange.allCases.map(\.step), [15, 90, 360, 2520])
        XCTAssertEqual(MetricsRange.allCases.map(\.window), [60, 360, 1440, 10080])
        XCTAssertEqual(MetricsRange.week.grafanaFrom, "now-7d")
    }

    func testSparklinesCoverOneOrEveryNamespace() throws {
        let (cpu, memory) = Prometheus.sparklineQueries(namespace: "shop", cluster: "aks")
        XCTAssertEqual(
            cpu,
            #"sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{namespace="shop", container!="", container!="POD", cluster="aks"}[5m]))"#
        )
        XCTAssertTrue(memory.hasPrefix("sum by (namespace, pod) (container_memory_working_set_bytes{"))
        XCTAssertFalse(Prometheus.sparklineQueries(namespace: nil, cluster: nil).cpu.contains("namespace="))
        let data = json(#"{"result":[{"metric":{"namespace":"shop","pod":"api-0"},"values":[[1,"1"]]}]}"#)
        XCTAssertEqual(try Prometheus.parseSeries(data, labels: ["namespace", "pod"]).first?.label, "shop/api-0")
    }

    func testSeriesParseMatrixVectorAndNonFiniteValues() throws {
        let data = json(
            #"{"resultType":"matrix","result":[{"metric":{"container":"web"},"values":[[1,"0.5"],[16,"NaN"],[31,"+Inf"]]},{"metric":{"container":"app"},"values":[[1,"2"]]}]}"#
        )
        let series = try Prometheus.parseSeries(data, labels: ["container"])
        XCTAssertEqual(series.first?.label, "app", "sorted by label")
        XCTAssertEqual(
            series[1].points,
            [MetricPoint(time: 1, value: 0.5), MetricPoint(time: 16, value: nil), MetricPoint(time: 31, value: nil)])
        let summed = try Prometheus.parseSeries(
            json(#"{"resultType":"vector","result":[{"metric":{},"value":[5,"1"]}]}"#), labels: [])
        XCTAssertEqual(summed.first?.label, "")
        XCTAssertEqual(summed.first?.points, [MetricPoint(time: 5, value: 1)])
        XCTAssertThrowsError(try Prometheus.parseSeries(json("{}"), labels: []))
        XCTAssertTrue(try Prometheus.parseSeries(json(#"{"result":[]}"#), labels: []).isEmpty)
    }

    func testAPIErrorsCarryTheServerReason() {
        XCTAssertThrowsError(
            try Prometheus.unwrapData(json(#"{"status":"error","errorType":"bad_data","error":"parse error at char 5"}"#))
        ) { error in
            XCTAssertEqual(error as? PromError, .http(status: 400, reason: "parse error at char 5"))
        }
        XCTAssertEqual(
            try? Prometheus.unwrapData(json(#"{"status":"success","data":{"result":[]}}"#)),
            json(#"{"result":[]}"#))
        XCTAssertEqual(Prometheus.errorReason(body: #"{"status":"error","error":"bad"}"#, status: 422), "bad")
        XCTAssertTrue(Prometheus.errorReason(body: "", status: 401).hasPrefix("authentication failed"))
    }

    func testAuthTagsHeadersAndDescriptionsHideSecrets() throws {
        let basic = PromAuth.basic(username: "123", password: "glc_x")
        XCTAssertEqual(basic.header, "Basic MTIzOmdsY194")
        XCTAssertEqual(PromAuth.bearer(" t ").header, "Bearer t")
        XCTAssertNil(PromAuth.azureCLI.header)
        XCTAssertEqual("\(basic)", "PromAuth(basic)")
        var dumped = ""
        dump(basic, to: &dumped)
        XCTAssertFalse(dumped.contains("glc_x"))
        for auth in [PromAuth.none, basic, .bearer("t"), .azureCLI] {
            let data = try JSONEncoder().encode(auth)
            XCTAssertEqual(try JSONDecoder().decode(PromAuth.self, from: data), auth)
            XCTAssertEqual(JSONValue.parse(String(decoding: data, as: UTF8.self))?["method"], .string(auth.method))
        }
        let endpoint = try JSONDecoder().decode(
            PromEndpoint.self,
            from: Data(#"{"target":{"kind":"external","url":"https://x.westeurope.prometheus.monitor.azure.com"},"grafanaUrl":"https://g"}"#.utf8))
        XCTAssertNil(endpoint.cluster)
        XCTAssertEqual(endpoint.grafanaURL, "https://g")
        XCTAssertFalse(endpoint.skipTLSVerify)
    }

    func testGrafanaExploreURLEncodesPanes() throws {
        let url = Prometheus.grafanaExploreURL(
            grafanaBase: "https://grafana.example/", datasource: "prom-uid",
            queries: ["sum(a)", "sum(b)"], from: "now-6h", to: "now")
        XCTAssertTrue(url.hasPrefix("https://grafana.example/explore?schemaVersion=1&panes="))
        let encoded = try XCTUnwrap(url.components(separatedBy: "panes=").last)
        let panes = try XCTUnwrap(JSONValue.parse(try XCTUnwrap(encoded.removingPercentEncoding)))
        XCTAssertEqual(panes["a"]?["datasource"], .string("prom-uid"))
        XCTAssertEqual(panes["a"]?["range"]?["from"], .string("now-6h"))
        if case .array(let queries)? = panes["a"]?["queries"] {
            XCTAssertEqual(queries[1]["refId"], .string("B"))
            XCTAssertEqual(queries[1]["expr"], .string("sum(b)"))
        } else {
            XCTFail("queries")
        }
        XCTAssertFalse(
            Prometheus.grafanaExploreURL(grafanaBase: "http://g", datasource: nil, queries: ["x"], from: "now-1h", to: "now")
                .contains("datasource"))
    }

    func testAzureTokensParseAndOnlyGoToAzureMonitor() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        let parsed = try Prometheus.parseAzureToken(Data(#"{"accessToken":"eyJ","expires_on":1730000000}"#.utf8), now: now)
        XCTAssertEqual(parsed.token, "eyJ")
        XCTAssertEqual(parsed.expires, Date(timeIntervalSince1970: 1_730_000_000))
        let old = try Prometheus.parseAzureToken(
            Data(#"{"accessToken":"eyJ","expiresOn":"2026-11-03 16:00:00.000000"}"#.utf8), now: now)
        XCTAssertEqual(old.expires, now.addingTimeInterval(600))
        XCTAssertThrowsError(try Prometheus.parseAzureToken(Data(#"{"accessToken":""}"#.utf8), now: now))
        XCTAssertTrue(
            Prometheus.azureCLIError("ERROR: Please run 'az login' to setup account.").localizedDescription
                .contains("az login"))
        XCTAssertTrue(Prometheus.isAzureMonitorURL(try XCTUnwrap(URL(string: "https://ws-1.westeurope.prometheus.monitor.azure.com"))))
        for bad in [
            "http://ws.westeurope.prometheus.monitor.azure.com",
            "https://prometheus.monitor.azure.com.evil.example", "https://grafana.net",
        ] {
            XCTAssertFalse(Prometheus.isAzureMonitorURL(try XCTUnwrap(URL(string: bad))), bad)
        }
    }

    func testClassifyFindsPrometheusServersOnly() throws {
        func service(_ text: String) throws -> IntegrationK8s.Service {
            try JSONDecoder().decode(IntegrationK8s.Service.self, from: Data(text.utf8))
        }
        let operated = try XCTUnwrap(Prometheus.classify(try service(
            #"{"metadata":{"name":"prometheus-operated","namespace":"monitoring","labels":{"operated-prometheus":"true"}},"spec":{"ports":[{"name":"http-web","port":9090}]}}"#
        )))
        XCTAssertEqual(operated.namespace, "monitoring")
        XCTAssertEqual(operated.port, 9090)
        XCTAssertFalse(operated.https)
        for other in ["kps-alertmanager", "kps-prometheus-node-exporter", "kps-operator"] {
            XCTAssertNil(Prometheus.classify(try service(
                #"{"metadata":{"name":"\#(other)","labels":{"app.kubernetes.io/name":"prometheus"}},"spec":{"ports":[{"port":9090}]}}"#)), other)
        }
        XCTAssertEqual(
            Prometheus.proxyBase(namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false),
            "/api/v1/namespaces/monitoring/services/http:prometheus-operated:9090/proxy")
    }
}

final class PrometheusServiceTests: XCTestCase {

    private let matrix = #"{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"container":"web","namespace":"shop","pod":"api-0"},"values":[[1,"0.25"]]}]}}"#

    private func service(
        cluster: StubCluster = StubCluster(objects: [:]), secrets: MemorySecrets = MemorySecrets(),
        azure: AzureCLIToken = AzureCLIToken { throw PromError.config("no az in tests") }
    ) -> PrometheusService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [IntegrationStubProtocol.self]
        return PrometheusService(cluster: cluster, secrets: secrets, configuration: config, azure: azure)
    }

    private let external = PromEndpoint(target: .external(url: "https://prom.example/api/prom"), cluster: "aks-prod")

    func testMetricsQueryEveryChartAndKeepPartialFailures() async throws {
        let matrix = self.matrix
        IntegrationStubProtocol.reset([:]) { request in
            let query = request.url?.query ?? ""
            return query.contains("resource_requests") && query.contains("cpu")
                ? (422, #"{"status":"error","errorType":"execution","error":"boom"}"#) : (200, matrix)
        }
        let secrets = MemorySecrets()
        let prom = service(secrets: secrets)
        try await prom.saveAuth(context: "prod", endpoint: external, auth: .bearer("tok"))
        let result = try await prom.metrics(
            context: "prod", endpoint: external,
            request: MetricsRequest(namespace: "shop", workload: .pod("api-0"), range: .hour, perContainer: true))
        XCTAssertEqual(result.step, 15)
        XCTAssertEqual(result.end - result.start, 3_600)
        XCTAssertEqual(result.charts.map(\.chart), Chart.allCases)
        XCTAssertEqual(result.data(.cpuRequest)?.error, "Prometheus returned 422: boom")
        XCTAssertEqual(result.data(.memory)?.series.first?.label, "web")
        XCTAssertEqual(result.data(.networkRx)?.series.first?.label, "", "network is summed")
        let requests = IntegrationStubProtocol.requests
        XCTAssertEqual(requests.count, Chart.allCases.count)
        XCTAssertTrue(requests.allSatisfy { $0.url.hasPrefix("https://prom.example/api/prom/api/v1/query_range?") })
        XCTAssertTrue(requests.allSatisfy { $0.authorization == "Bearer tok" })
        XCTAssertTrue(requests.contains { $0.url.contains("cluster%3D%22aks-prod%22") })
    }

    func testOneRejectedChartDoesNotCollapseTheSection() async throws {
        let matrix = self.matrix
        IntegrationStubProtocol.reset([:]) { request in
            (request.url?.query ?? "").contains("container_cpu") ? (401, "") : (200, matrix)
        }
        let result = try await service().metrics(
            context: "prod", endpoint: external,
            request: MetricsRequest(namespace: "shop", workload: .pod("api-0"), range: .hour, perContainer: false))
        XCTAssertNotNil(result.data(.cpu)?.error)
        XCTAssertNil(result.data(.memory)?.error)
    }

    func testCancelledMetricsKeepTheConnection() async throws {
        let matrix = self.matrix
        IntegrationStubProtocol.reset([:]) { _ in (200, matrix) }
        let prom = service()
        let endpoint = external
        let task = Task {
            try await prom.metrics(
                context: "prod", endpoint: endpoint,
                request: MetricsRequest(namespace: "shop", workload: .pod("api-0"), range: .hour, perContainer: false))
        }
        task.cancel()
        do {
            _ = try await task.value
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
    }

    func testRejectedCredentialsAreReportedOnce() async {
        IntegrationStubProtocol.reset([:]) { _ in (401, "") }
        do {
            _ = try await service().metrics(
                context: "prod", endpoint: external,
                request: MetricsRequest(namespace: "shop", workload: .pod("api-0"), range: .hour, perContainer: false))
            XCTFail("expected a 401")
        } catch {
            XCTAssertEqual(
                error as? PromError, .http(status: 401, reason: "authentication failed — check the credentials"))
        }
    }

    func testInClusterGoesThroughTheServiceProxy() async throws {
        let matrix = self.matrix
        let base = "/api/v1/namespaces/monitoring/services/http:prometheus-operated:9090/proxy"
        let cluster = StubCluster(
            objects: [:],
            proxy: [
                base + "/api/v1/status/buildinfo": (200, #"{"status":"success","data":{"version":"2.54.1"}}"#),
                base + "/api/v1/query_range": (200, matrix),
            ])
        let inCluster = PromEndpoint(
            target: .inCluster(namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false))
        IntegrationStubProtocol.reset([:])
        let sparklines = try await service(cluster: cluster).sparklines(
            context: "prod", endpoint: inCluster, namespace: nil)
        XCTAssertEqual(sparklines.cpu["shop/api-0"], [MetricPoint(time: 1, value: 0.25)])
        XCTAssertTrue(IntegrationStubProtocol.requests.isEmpty, "nothing over HTTP: the API server proxies")
    }

    func testProxyErrorsFromTheAPIServer() async {
        let base = "/api/v1/namespaces/monitoring/services/http:prometheus-operated:9090/proxy"
        let inCluster = PromEndpoint(
            target: .inCluster(namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false))
        let missing = StubCluster(
            objects: [:],
            proxy: [base: (404, #"{"kind":"Status","code":404,"message":"services \"prometheus-operated\" not found"}"#)])
        do {
            _ = try await service(cluster: missing).sparklines(context: "prod", endpoint: inCluster, namespace: "shop")
            XCTFail("expected a config error")
        } catch {
            XCTAssertTrue((error as? PromError).map { "\($0)".contains("not found") } ?? false, "\(error)")
        }
        // Forbidden proxy: falls back to a port-forward (none behind it here).
        let forbidden = StubCluster(
            objects: [:], proxy: [base: (403, #"{"kind":"Status","code":403,"message":"forbidden"}"#)])
        do {
            _ = try await service(cluster: forbidden).sparklines(context: "prod", endpoint: inCluster, namespace: "shop")
            XCTFail("expected the tunnel to fail")
        } catch {
            XCTAssertEqual(error as? PromError, .config("Not found: /api/v1/namespaces/monitoring/services/prometheus-operated"))
        }
        let bad = PromEndpoint(target: .inCluster(namespace: "../x", service: "s", port: 9090, https: false))
        do {
            _ = try await service().sparklines(context: "prod", endpoint: bad, namespace: nil)
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? PromError, .config(#"Invalid namespace name "../x""#))
        }
    }

    func testCredentialRules() async throws {
        let prom = service()
        do {
            try await prom.saveAuth(
                context: "prod", endpoint: PromEndpoint(target: .external(url: "http://prom.example")),
                auth: .bearer("t"))
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? PromError, .config("Credentials are only sent over https://"))
        }
        do {
            try await prom.saveAuth(context: "prod", endpoint: external, auth: .azureCLI)
            XCTFail("expected a refusal")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("prometheus.monitor.azure.com"))
        }
        let inCluster = PromEndpoint(
            target: .inCluster(namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false))
        do {
            try await prom.saveAuth(context: "prod", endpoint: inCluster, auth: .bearer("t"))
            XCTFail("expected a refusal")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("cluster credentials"))
        }
        try await prom.saveAuth(context: "prod", endpoint: external, auth: .basic(username: "u", password: "p"))
        let here = try await prom.authMethod(context: "prod", endpoint: external)
        let there = try await prom.authMethod(
            context: "prod", endpoint: PromEndpoint(target: .external(url: "https://other.example")))
        XCTAssertEqual(here, "basic")
        XCTAssertEqual(there, "none")
    }

    func testAzureCLITokenIsRefreshedAndSentOnlyToAzureMonitor() async throws {
        actor Runs { var count = 0; func bump() -> Int { count += 1; return count } }
        let runs = Runs()
        let azure = AzureCLIToken {
            let n = await runs.bump()
            let expires = Int(Date().timeIntervalSince1970) + (n == 1 ? 60 : 3600)
            return (0, Data(#"{"accessToken":"tok\#(n)","expires_on":\#(expires)}"#.utf8), Data())
        }
        // Within the 5-minute margin: the first token is refreshed at once.
        let first = try await azure.token()
        let second = try await azure.token()
        XCTAssertEqual([first, second], ["tok1", "tok2"])
        let third = try await azure.token()
        XCTAssertEqual(third, "tok2", "cached while valid")

        let matrix = self.matrix
        IntegrationStubProtocol.reset([:]) { _ in (200, matrix) }
        let azureEndpoint = PromEndpoint(target: .external(url: "https://ws-1.westeurope.prometheus.monitor.azure.com"))
        let prom = service(azure: azure)
        try await prom.saveAuth(context: "prod", endpoint: azureEndpoint, auth: .azureCLI)
        _ = try await prom.sparklines(context: "prod", endpoint: azureEndpoint, namespace: "shop")
        XCTAssertTrue(IntegrationStubProtocol.requests.allSatisfy { $0.authorization == "Bearer tok2" })

        let failing = AzureCLIToken { (1, Data(), Data("ERROR: Please run 'az login' to setup account.".utf8)) }
        do {
            _ = try await failing.token()
            XCTFail("expected a login hint")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("az login"))
        }
    }

    func testTestConnectionReportsExportersAndClusters() async throws {
        IntegrationStubProtocol.reset([
            "/api/prom/api/v1/status/buildinfo": (200, #"{"status":"success","data":{"version":"2.54.1"}}"#)
        ]) { request in
            guard let query = request.url?.query, request.url?.path.hasSuffix("/api/v1/query") == true else {
                return nil
            }
            if query.contains("vector") || query.contains("container_cpu") {
                return (200, #"{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1,"1"]}]}}"#)
            }
            if query.contains("by%20%28cluster%29") {
                return (200, #"{"status":"success","data":{"resultType":"vector","result":[{"metric":{"cluster":"aks-prod"},"value":[1,"3"]}]}}"#)
            }
            return (200, #"{"status":"success","data":{"resultType":"vector","result":[]}}"#)
        }
        let info = try await service().test(context: "prod", endpoint: external, auth: PromAuth.none)
        XCTAssertEqual(info, PromInfo(version: "2.54.1", cadvisor: true, kubeStateMetrics: false, clusters: ["aks-prod"]))
    }
}

final class KubeURLSessionDelegateTests: XCTestCase {

    func testKubeSessionsNeverFollowRedirects() throws {
        let delegate = KubeURLSessionDelegate(
            trustedCertificate: nil, clientIdentity: nil, insecureSkipTLS: false)
        let from = try XCTUnwrap(URL(string: "https://api.cluster:6443/api/v1/namespaces/x/services/http:s:80/proxy/"))
        let to = try XCTUnwrap(URL(string: "https://evil.example/collect"))
        let response = try XCTUnwrap(
            HTTPURLResponse(url: from, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": to.absoluteString]))
        var next = URLRequest(url: to)
        next.setValue("Bearer cluster-token", forHTTPHeaderField: "Authorization")
        var followed: URLRequest? = next
        delegate.urlSession(
            .shared, task: URLSession.shared.dataTask(with: from), willPerformHTTPRedirection: response,
            newRequest: next
        ) { followed = $0 }
        XCTAssertNil(followed)
    }
}
