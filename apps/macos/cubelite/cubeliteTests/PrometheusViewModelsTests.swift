import XCTest

@testable import cubelite

private actor StubPromBackend: PrometheusPreferencesBackend {
    var saved: [(PromEndpoint, PromAuth)] = []
    var tested: [PromAuth?] = []
    var stored: [String: String] = [:]

    func detect(context: String) async throws -> [DetectedPrometheus] {
        [DetectedPrometheus(namespace: "monitoring", name: "prometheus-operated", port: 9090, https: false)]
    }

    func test(context: String, endpoint: PromEndpoint, auth: PromAuth?) async throws -> PromInfo {
        tested.append(auth)
        return PromInfo(version: "2.54.1", cadvisor: true, kubeStateMetrics: true, clusters: ["aks-prod", "aks-test"])
    }

    func saveAuth(context: String, endpoint: PromEndpoint, auth: PromAuth) async throws {
        saved.append((endpoint, auth))
        stored[try Integration.binding(endpoint.target, skipTLSVerify: endpoint.skipTLSVerify)] = auth.method
    }

    func authMethod(context: String, endpoint: PromEndpoint) async throws -> String {
        stored[try Integration.binding(endpoint.target, skipTLSVerify: endpoint.skipTLSVerify)] ?? "none"
    }

    func setStored(_ method: String, for endpoint: PromEndpoint) throws {
        stored[try Integration.binding(endpoint.target, skipTLSVerify: endpoint.skipTLSVerify)] = method
    }
}

@MainActor
final class PrometheusPreferencesModelTests: XCTestCase {

    private var endpoints: PrometheusEndpointStore!

    override func setUp() async throws {
        let suite = "PrometheusPreferencesModelTests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        endpoints = PrometheusEndpointStore(defaults: defaults)
    }

    func testDetectAndSaveAnInClusterEndpointWithClusterCredentials() async {
        let backend = StubPromBackend()
        let model = PrometheusPreferencesModel(backend: backend, endpoints: endpoints)
        await model.load(context: "prod")
        model.target.mode = .inCluster
        await model.detect()
        model.pick(model.detected![0])
        model.authMethod = .bearer  // ignored in-cluster
        model.grafanaURL = " https://grafana.example "
        await model.save()
        XCTAssertEqual(model.outcome, FormOutcome(ok: true, text: "Prometheus saved for prod"))
        XCTAssertEqual(
            endpoints.endpoint(for: "prod"),
            PromEndpoint(
                target: .inCluster(namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false),
                grafanaURL: "https://grafana.example"))
        let saved = await backend.saved
        XCTAssertEqual(saved.map(\.1), [.none])
    }

    func testAzureCLIOnlyForAzureMonitorAndKeptAcrossModes() async throws {
        let backend = StubPromBackend()
        let model = PrometheusPreferencesModel(backend: backend, endpoints: endpoints)
        await model.load(context: "prod")
        model.target.mode = .external
        model.target.url = "https://grafana.example"
        model.authMethod = .azureCLI
        XCTAssertNotNil(model.azureProblem)
        XCTAssertTrue(model.isIncomplete)
        model.target.url = "https://ws-1.westeurope.prometheus.monitor.azure.com"
        model.cluster = " aks-prod "
        XCTAssertFalse(model.isIncomplete)
        await model.test()
        XCTAssertEqual(
            model.outcome?.text,
            "Prometheus 2.54.1 · cAdvisor ✓ · kube-state-metrics ✓ · clusters: aks-prod, aks-test")
        let tested = await backend.tested
        XCTAssertEqual(tested, [.azureCLI])
        await model.save()
        XCTAssertEqual(endpoints.endpoint(for: "prod")?.cluster, "aks-prod")
        XCTAssertEqual(model.storedMethod, .azureCLI)
        model.target.mode = .inCluster
        model.target.mode = .external
        XCTAssertEqual(model.authMethod, .azureCLI, "the stored choice survives a mode round trip")
    }

    func testTurningOffDeletesTheSecretAndOtherContextsStartEmpty() async throws {
        let backend = StubPromBackend()
        let saved = PromEndpoint(target: .external(url: "https://p.example"))
        endpoints.setEndpoint(saved, for: "prod")
        try await backend.setStored("bearer", for: saved)
        let model = PrometheusPreferencesModel(backend: backend, endpoints: endpoints)
        await model.load(context: "prod")
        XCTAssertEqual(model.authMethod, .bearer)
        model.input.secret = "typed"
        await model.load(context: "dev")
        XCTAssertEqual(model.target.mode, .off)
        XCTAssertEqual(model.input.secret, "")
        await model.load(context: "prod")
        model.target.mode = .off
        await model.save()
        XCTAssertNil(endpoints.endpoint(for: "prod"))
        let calls = await backend.saved
        XCTAssertEqual(calls.map(\.1), [.none])
    }

    func testMovingTheEndpointNeedsTheCredentialsAgain() async throws {
        let backend = StubPromBackend()
        let saved = PromEndpoint(target: .external(url: "https://p.example"))
        endpoints.setEndpoint(saved, for: "prod")
        try await backend.setStored("bearer", for: saved)
        let model = PrometheusPreferencesModel(backend: backend, endpoints: endpoints)
        await model.load(context: "prod")
        model.target.url = "https://other.example"
        await model.save()
        XCTAssertEqual(model.outcome, FormOutcome(ok: false, text: IntegrationForm.movedMessage))
        XCTAssertEqual(endpoints.endpoint(for: "prod"), saved)
    }
}

/// Scripted metrics and sparklines.
private actor StubQuerying: PrometheusQuerying {
    var sparklineCalls: [String?] = []
    var metricCalls: [MetricsRequest] = []
    var sparklineReply: Result<Sparklines, Error> = .success(Sparklines())
    var gate: CheckedContinuation<Void, Never>?
    var holdNext = false

    func setSparklines(_ reply: Result<Sparklines, Error>) { sparklineReply = reply }
    func hold() { holdNext = true }
    func release() { gate?.resume(); gate = nil }

    func metrics(context: String, endpoint: PromEndpoint, request: MetricsRequest) async throws -> MetricsResult {
        metricCalls.append(request)
        if holdNext {
            holdNext = false
            await withCheckedContinuation { gate = $0 }
        }
        let series = [MetricSeries(label: "\(request.workload)", points: [MetricPoint(time: 0, value: 1)])]
        return MetricsResult(
            start: 0, end: request.range.seconds, step: request.range.step,
            charts: Chart.allCases.map { ChartData(chart: $0, query: "q-\($0.rawValue)", series: series, error: nil) })
    }

    func sparklines(context: String, endpoint: PromEndpoint, namespace: String?) async throws -> Sparklines {
        sparklineCalls.append(context)
        return try sparklineReply.get()
    }
}

@MainActor
final class MetricsModelsTests: XCTestCase {

    private func store(_ querying: StubQuerying) throws -> PrometheusStore {
        let suite = "MetricsModelsTests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let endpoints = PrometheusEndpointStore(defaults: defaults)
        endpoints.setEndpoint(PromEndpoint(target: .external(url: "https://p.example")), for: "prod")
        endpoints.setEndpoint(PromEndpoint(target: .external(url: "https://q.example")), for: "staging")
        return PrometheusStore(endpoints: endpoints, querying: querying)
    }

    func testSparklinesThrottleAndClearOnScopeChange() async throws {
        let querying = StubQuerying()
        await querying.setSparklines(.success(Sparklines(cpu: ["shop/api-0": [MetricPoint(time: 0, value: 0.1)]])))
        let prom = try store(querying)
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        await prom.loadSparklines(context: "prod", namespace: "shop", now: t0)
        await prom.loadSparklines(context: "prod", namespace: "shop", now: t0.addingTimeInterval(5))
        var calls = await querying.sparklineCalls
        XCTAssertEqual(calls.count, 1, "throttled within 30 s")
        XCTAssertEqual(prom.cpu(namespace: "shop", pod: "api-0"), [MetricPoint(time: 0, value: 0.1)])
        XCTAssertNil(prom.memory(namespace: "shop", pod: "api-0"))

        await querying.setSparklines(.failure(PromError.connect("down")))
        await prom.loadSparklines(context: "staging", namespace: "shop", now: t0.addingTimeInterval(6))
        XCTAssertNil(prom.sparklines, "another cluster clears the old data")
        XCTAssertNotNil(prom.sparklineError)
        await prom.loadSparklines(context: "dev", namespace: "shop", now: t0.addingTimeInterval(7))
        XCTAssertNil(prom.sparklineError, "no endpoint: nothing shown")
        calls = await querying.sparklineCalls
        XCTAssertEqual(calls, ["prod", "staging"])
    }

    func testMetricsSectionNeverShowsThePreviousPod() async throws {
        let querying = StubQuerying()
        let endpoint = PromEndpoint(target: .external(url: "https://p.example"))
        let model = MetricsSectionModel()
        await model.load(context: "prod", endpoint: endpoint, namespace: "shop", workload: .pod("a"), querying: querying)
        XCTAssertEqual(model.series(.cpu).first?.label, "pod(\"a\")")
        await querying.hold()
        let loading = Task {
            await model.load(context: "prod", endpoint: endpoint, namespace: "shop", workload: .pod("b"), querying: querying)
        }
        while await querying.metricCalls.count < 2 { await Task.yield() }
        XCTAssertNil(model.result, "pod b never shows pod a's charts")
        XCTAssertTrue(model.isLoading)
        await querying.release()
        await loading.value
        XCTAssertEqual(model.series(.cpu).first?.label, "pod(\"b\")")
        XCTAssertEqual(model.queries(.memory, .memoryLimit), ["q-memory", "q-memory-limit"])
        model.range = .week
        await model.load(context: "prod", endpoint: endpoint, namespace: "shop", workload: .pod("b"), querying: querying)
        XCTAssertEqual(model.resultRange, .week)
    }

    func testMetricsMath() {
        let a = [MetricPoint(time: 1, value: 1), MetricPoint(time: 2, value: 2)]
        let b = [MetricPoint(time: 2, value: 3), MetricPoint(time: 3, value: nil)]
        XCTAssertEqual(MetricsMath.sum([a, b]), [MetricPoint(time: 1, value: 1), MetricPoint(time: 2, value: 5)])
        XCTAssertEqual(MetricsMath.latest(b), 3)
        XCTAssertEqual(
            MetricsMath.latestTotal([MetricSeries(label: "a", points: a), MetricSeries(label: "b", points: b)]), 5)
        XCTAssertNil(MetricsMath.latestTotal([]))
        XCTAssertEqual(MetricsMath.format(0.25, .cores), "250m")
        XCTAssertEqual(MetricsMath.format(1.5, .cores), "1.50")
        XCTAssertEqual(MetricsMath.format(1_048_576, .bytes), "1Mi")
        XCTAssertEqual(MetricsMath.format(2048, .bytesPerSecond), "2Ki/s")
        XCTAssertEqual(MetricsMath.format(2.6, .count), "3")
    }
}
