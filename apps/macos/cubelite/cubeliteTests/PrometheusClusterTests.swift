import XCTest

@testable import cubelite

/// Cluster and node history and the Overview's alerts (#530); the query
/// vectors are the core's (`prometheus/nodes/tests.rs`, `alerts/tests.rs`).
final class HostQueriesTests: XCTestCase {

    private func queries(_ plan: [HostChartPlan], _ chart: HostChart) -> [String] {
        plan.first { $0.chart == chart }?.candidates.map(\.query) ?? []
    }

    private func sources(_ plan: [HostChartPlan], _ chart: HostChart) -> [MetricSource] {
        plan.first { $0.chart == chart }?.candidates.map(\.source) ?? []
    }

    func testClusterPlanUsesTheIssueQueriesAndTheClusterLabel() {
        let plan = HostQueries.clusterPlan(cluster: nil, range: .hour)
        XCTAssertEqual(
            queries(plan, .cpu), [#"sum(rate(container_cpu_usage_seconds_total{container!="", pod!=""}[300s]))"#])
        XCTAssertEqual(queries(plan, .cpuAllocatable), [#"sum(kube_node_status_allocatable{resource="cpu"})"#])
        XCTAssertEqual(queries(plan, .memory), [#"sum(container_memory_working_set_bytes{container!="", pod!=""})"#])
        XCTAssertEqual(
            queries(plan, .memoryAllocatable), [#"sum(kube_node_status_allocatable{resource="memory"})"#])
        let shared = HostQueries.clusterPlan(cluster: " aks-\"prod\" ", range: .week)
        for chart in shared {
            XCTAssertTrue(chart.candidates[0].query.contains(#"cluster="aks-\"prod\"""#), chart.candidates[0].query)
        }
        XCTAssertTrue(queries(shared, .cpu)[0].contains("[10080s]"))
        XCTAssertTrue(
            HostQueries.clusterPlan(cluster: "  ", range: .hour).allSatisfy {
                !$0.candidates[0].query.contains("cluster=")
            })
    }

    func testNodePlanPrefersNodeExporterThenCadvisor() {
        let plan = HostQueries.nodePlan(
            node: "minikube", instances: ["192.168.49.2:9100"], cluster: "eu", range: .hour)
        XCTAssertEqual(plan.map(\.chart), HostChart.allCases)
        XCTAssertEqual(sources(plan, .cpu), [.nodeExporter, .cadvisor, .cadvisor])
        let cpu = queries(plan, .cpu)
        XCTAssertEqual(
            cpu[0],
            #"sum(rate(node_cpu_seconds_total{instance="192.168.49.2:9100", cluster="eu", mode!~"idle|iowait|steal"}[300s]))"#
        )
        XCTAssertEqual(
            cpu[1],
            #"sum(rate(container_cpu_usage_seconds_total{node="minikube", cluster="eu", container!="", pod!=""}[300s]))"#
        )
        XCTAssertTrue(cpu[2].contains(#"{instance="minikube", cluster="eu", "#), cpu[2])
        let memory = queries(plan, .memory)
        XCTAssertTrue(memory[0].contains(#"node_memory_MemTotal_bytes{instance="192.168.49.2:9100""#))
        XCTAssertTrue(memory[0].contains("node_memory_MemAvailable_bytes"))
        XCTAssertTrue(memory[1].hasPrefix(#"sum(container_memory_working_set_bytes{node="minikube""#))
        let rx = queries(plan, .networkRx)
        XCTAssertTrue(rx[0].hasPrefix("sum(rate(node_network_receive_bytes_total{instance="))
        XCTAssertTrue(rx[0].contains(#"device!~"lo|veth.*"#))
        XCTAssertTrue(rx[1].contains(#"container_network_receive_bytes_total{node="minikube""#))
        XCTAssertTrue(queries(plan, .networkTx)[0].contains("node_network_transmit_bytes_total"))
        XCTAssertTrue(queries(plan, .filesystem)[0].contains("node_filesystem_avail_bytes"))
        XCTAssertTrue(queries(plan, .filesystem)[0].contains("max by (device)"))
        XCTAssertEqual(
            queries(plan, .pods)[0],
            #"count(kube_pod_status_phase{phase="Running", cluster="eu"} == 1 and on (namespace, pod) kube_pod_info{node="minikube", cluster="eu"})"#
        )
        XCTAssertEqual(sources(plan, .pods), [.kubeStateMetrics, .kubelet, .kubelet])
        XCTAssertEqual(
            queries(plan, .cpuAllocatable),
            [#"sum(kube_node_status_allocatable{node="minikube", cluster="eu", resource="cpu"})"#])
    }

    func testNodePlanWithoutNodeExporterUsesCadvisorOnly() {
        let plan = HostQueries.nodePlan(node: "minikube", instances: [], cluster: nil, range: .hour)
        for chart in [HostChart.cpu, .memory, .networkRx, .filesystem] {
            XCTAssertEqual(sources(plan, chart), [.cadvisor, .cadvisor], "\(chart)")
        }
    }

    func testNodeNamesAndInstancesAreEscaped() {
        let plan = HostQueries.nodePlan(node: #"we"ird\node"#, instances: [], cluster: nil, range: .hour)
        XCTAssertTrue(queries(plan, .cpu)[0].contains(#"node="we\"ird\\node""#))
        XCTAssertEqual(
            HostQueries.instanceMatcher(["10.0.0.1:9100", "10.0.0.2:9100"]),
            #"instance=~"10\\.0\\.0\\.1:9100|10\\.0\\.0\\.2:9100""#)
        XCTAssertNil(HostQueries.instanceMatcher([]))
        XCTAssertEqual(
            HostQueries.unameQuery(node: #"n"1"#, cluster: "eu"),
            #"node_uname_info{nodename="n\"1", cluster="eu"} or node_uname_info{instance="n\"1", cluster="eu"}"#)
        XCTAssertEqual(HostQueries.nodeInfoQuery(node: "minikube", cluster: nil), #"kube_node_info{node="minikube"}"#)
        XCTAssertEqual(
            HostQueries.unameByIPQuery(ips: ["192.168.49.2", "fd00::1"], cluster: nil),
            #"node_uname_info{instance=~"\\[?(192\\.168\\.49\\.2|fd00::1)\\]?:[0-9]+"}"#)
    }

    private func series(_ values: [Double?]) -> [MetricSeries] {
        [MetricSeries(label: "", points: values.enumerated().map { MetricPoint(time: Double($0), value: $1) })]
    }

    func testSettlePicksTheFirstCandidateWithData() {
        let ne = HostCandidate(source: .nodeExporter, query: "ne")
        let cad = HostCandidate(source: .cadvisor, query: "cad")
        var data = HostQueries.settle(.cpu, preferred: "ne", attempts: [(ne, .success(series([1])))])
        XCTAssertEqual(data.source, .nodeExporter)
        data = HostQueries.settle(
            .cpu, preferred: "ne", attempts: [(ne, .success(series([nil]))), (cad, .success(series([0.5])))])
        XCTAssertEqual(data.source, .cadvisor)
        XCTAssertEqual(data.query, "cad")
        data = HostQueries.settle(.filesystem, preferred: "ne", attempts: [(ne, .success([])), (cad, .success([]))])
        XCTAssertNil(data.source)
        XCTAssertEqual(data.query, "ne")
        XCTAssertNil(data.error)
        let boom = PromError.http(status: 422, reason: "boom")
        data = HostQueries.settle(.cpu, preferred: "ne", attempts: [(ne, .success([])), (cad, .failure(boom))])
        XCTAssertNil(data.error, "missing data, not a failure")
        data = HostQueries.settle(.cpu, preferred: "ne", attempts: [(ne, .failure(boom)), (cad, .failure(boom))])
        XCTAssertEqual(data.error, "Prometheus returned 422: boom")
    }

    func testSeriesLabelsAreDistinctAndNonEmpty() throws {
        let data = try XCTUnwrap(
            JSONValue.parse(
                #"{"result":[{"metric":{"instance":"b:9100"},"value":[1,"1"]},{"metric":{"instance":"a:9100"},"value":[1,"1"]},{"metric":{"instance":"a:9100"},"value":[1,"1"]},{"metric":{},"value":[1,"1"]}]}"#
            ))
        XCTAssertEqual(HostQueries.seriesLabels(data, label: "instance"), ["a:9100", "b:9100"])
    }

    func testPanelsSummariseAgainstTheReference() {
        func chart(_ c: HostChart, _ value: Double?, _ source: MetricSource? = .cadvisor) -> HostChartData {
            HostChartData(
                chart: c, source: value == nil ? nil : source, query: "q-\(c.rawValue)",
                series: value.map { series([$0 / 2, $0]) } ?? [], error: nil)
        }
        let result = HostMetrics(
            start: 0, end: 3600, step: 15,
            charts: [
                chart(.cpu, 0.5), chart(.cpuAllocatable, 4, .kubeStateMetrics), chart(.memory, 1_073_741_824),
                chart(.networkRx, 2048, .nodeExporter), chart(.networkTx, 1024, .nodeExporter),
                chart(.filesystem, nil),
            ])
        let cpu = HostPanel.cluster[0]
        XCTAssertEqual(cpu.summary(result), "500m / alloc 4")
        XCTAssertEqual(cpu.lines(result).map(\.dashed), [false, true])
        XCTAssertEqual(cpu.queries(result), ["q-cpu", "q-cpu-allocatable"])
        XCTAssertEqual(cpu.source(result), "from cAdvisor")
        XCTAssertEqual(HostPanel.cluster[1].summary(result), "1Gi")
        let network = HostPanel.node[3]
        XCTAssertEqual(network.summary(result), "↓ 2Ki/s ↑ 1Ki/s")
        XCTAssertEqual(network.lines(result).map(\.label), ["rx", "tx"])
        XCTAssertEqual(network.source(result), "from node-exporter")
        let filesystem = HostPanel.node[4]
        XCTAssertTrue(filesystem.lines(result).isEmpty)
        XCTAssertNil(filesystem.source(result))
        XCTAssertEqual(filesystem.emptyText, "not available — needs node-exporter or cAdvisor metrics for this node")
    }
}

final class PromAlertsTests: XCTestCase {

    static let alertsBody = #"""
        {"alerts":[
          {"labels":{"alertname":"Watchdog","severity":"none"},
           "annotations":{"description":"This is an alert meant to ensure that the entire alerting pipeline is functional."},
           "state":"firing","activeAt":"2026-11-03T19:29:26.774067357Z","value":"1e+00"},
          {"labels":{"alertname":"KubePodCrashLooping","severity":"warning","namespace":"shop","pod":"api-7d9c8b6f5-x2k4p","container":"api"},
           "annotations":{"summary":"Pod is crash looping.","description":"Pod shop/api is in waiting state."},
           "state":"firing","activeAt":"2026-11-04T08:00:00Z"},
          {"labels":{"alertname":"KubeNodeNotReady","severity":"warning","node":"minikube"},"annotations":{},
           "state":"pending","activeAt":"2026-11-04T09:00:00Z"},
          {"labels":{},"annotations":{},"state":"firing"}
        ]}
        """#

    func testAlertsAPIKeepsFiringAlertsWithTheirSummary() throws {
        let alerts = try PromAlerts.parseAlertsAPI(try XCTUnwrap(JSONValue.parse(Self.alertsBody)))
        XCTAssertEqual(alerts.map(\.name), ["Watchdog", "KubePodCrashLooping"])
        XCTAssertEqual(alerts[0].severity, "none")
        XCTAssertTrue(alerts[0].summary?.hasPrefix("This is an alert") ?? false)
        XCTAssertEqual(alerts[0].activeAt, "2026-11-03T19:29:26.774067357Z")
        XCTAssertEqual(alerts[1].summary, "Pod is crash looping.")
        XCTAssertEqual(alerts[1].namespace, "shop")
        XCTAssertEqual(alerts[1].pod, "api-7d9c8b6f5-x2k4p")
        XCTAssertNil(alerts[1].node)
        XCTAssertEqual(alerts[1].labels["container"], "api")
        XCTAssertThrowsError(try PromAlerts.parseAlertsAPI(.object([])))
    }

    func testAlertsSeriesHaveLabelsOnly() throws {
        let data = try XCTUnwrap(
            JSONValue.parse(
                #"{"resultType":"vector","result":[{"metric":{"__name__":"ALERTS","alertname":"KubeNodeNotReady","alertstate":"firing","severity":"warning","node":"minikube"},"value":[1,"1"]}]}"#
            ))
        let alerts = try PromAlerts.parseAlertsMetric(data)
        XCTAssertEqual(alerts.count, 1)
        XCTAssertEqual(alerts[0].node, "minikube")
        XCTAssertNil(alerts[0].summary)
        XCTAssertNil(alerts[0].activeAt)
        XCTAssertNil(alerts[0].labels["__name__"])
        XCTAssertNil(alerts[0].labels["alertstate"])
        XCTAssertEqual(PromAlerts.metricQuery(cluster: "eu"), #"ALERTS{alertstate="firing", cluster="eu"}"#)
        XCTAssertEqual(PromAlerts.metricQuery(cluster: nil), #"ALERTS{alertstate="firing"}"#)
    }

    func testRulesGiveAlertsTheirExpression() throws {
        let rules = PromAlerts.parseRules(
            try XCTUnwrap(
                JSONValue.parse(
                    #"{"groups":[{"name":"general","rules":[{"type":"alerting","name":"Watchdog","query":"vector(1)","labels":{"severity":"none"}},{"type":"recording","name":"node:cpu","query":"sum(x)"}]},{"name":"pods","rules":[{"type":"alerting","name":"KubePodCrashLooping","query":"crash_critical > 0","labels":{"severity":"critical"}},{"type":"alerting","name":"KubePodCrashLooping","query":"crash_warning > 0","labels":{"severity":"warning"}}]}]}"#
                )))
        XCTAssertEqual(rules.count, 3, "recording rules are left out")
        var alerts = try PromAlerts.parseAlertsAPI(try XCTUnwrap(JSONValue.parse(Self.alertsBody)))
        alerts.append(
            PromAlert(
                name: #"Unknown"Rule"#, severity: nil, namespace: nil, pod: nil, node: nil, summary: nil,
                activeAt: nil, expr: "", labels: [:]))
        alerts = PromAlerts.attachExprs(alerts, rules: rules, cluster: "eu")
        XCTAssertEqual(alerts[0].expr, "vector(1)")
        XCTAssertEqual(alerts[1].expr, "crash_warning > 0")
        XCTAssertEqual(alerts[2].expr, #"ALERTS{alertname="Unknown\"Rule", alertstate="firing", cluster="eu"}"#)
    }

    private func named(_ name: String, _ severity: String?, _ activeAt: String? = nil, cluster: String? = nil)
        -> PromAlert
    {
        var labels = ["alertname": name]
        if let cluster { labels["cluster"] = cluster }
        return PromAlert(
            name: name, severity: severity, namespace: nil, pod: nil, node: nil, summary: nil, activeAt: activeAt,
            expr: "", labels: labels)
    }

    func testAlertsSortBySeverityThenAgeAndKeepTheirCluster() {
        let sorted = PromAlerts.finish(
            [
                named("Watchdog", "none", "2026-01-01T00:00:00Z"),
                named("B", "warning", "2026-11-04T00:00:00Z"),
                named("A", "warning", "2026-11-03T00:00:00Z"),
                named("Crit", "critical", cluster: "eu"),
                named("Other", "critical", cluster: "us"),
                named("Plain", nil),
            ], cluster: "eu")
        XCTAssertEqual(sorted.map(\.name), ["Crit", "A", "B", "Plain", "Watchdog"])
        XCTAssertEqual(PromAlerts.finish([named("Other", nil, cluster: "us")], cluster: nil).count, 1)
    }

    func testAlertsNameAndResolveWhatTheyAreAbout() {
        let pod = PodInfo(
            name: "api-0", namespace: "shop", phase: "Running", ready: true, restarts: 0, creationTimestamp: nil)
        let onPod = PromAlert(
            name: "X", severity: "warning", namespace: "shop", pod: "api-0", node: nil, summary: nil, activeAt: nil,
            expr: "", labels: [:])
        XCTAssertEqual(PromAlerts.subject(onPod), "shop/api-0")
        XCTAssertEqual(PromAlerts.target(onPod, pods: [pod]), .pod("shop/api-0"))
        XCTAssertNil(PromAlerts.target(onPod, pods: []), "a pod that is not loaded has no link")
        let onNode = PromAlert(
            name: "X", severity: "critical", namespace: nil, pod: nil, node: "minikube", summary: nil, activeAt: nil,
            expr: "", labels: [:])
        XCTAssertEqual(PromAlerts.subject(onNode), "minikube")
        XCTAssertEqual(PromAlerts.target(onNode, pods: []), .node("minikube"))
        XCTAssertEqual(PromAlerts.tone("critical"), .err)
        XCTAssertEqual(PromAlerts.tone("Warning"), .warn)
        XCTAssertEqual(PromAlerts.tone("none"), .neutral)
    }

    func testFiringSinceReadsPrometheusTimestamps() throws {
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-04T12:00:00Z"))
        XCTAssertEqual(PromAlerts.firingSince("2026-11-04T09:00:00.774067357Z", now: now), "firing 3h")
        XCTAssertEqual(PromAlerts.firingSince("2026-11-03T08:30:00Z", now: now), "firing 1d3h")
        XCTAssertEqual(PromAlerts.firingSince(nil, now: now), "firing")
        XCTAssertEqual(PromAlerts.age(seconds: 42), "42s")
        XCTAssertEqual(PromAlerts.age(seconds: 3_900), "1h5m")
    }
}

final class PrometheusClusterServiceTests: XCTestCase {

    private let external = PromEndpoint(target: .external(url: "https://prom.example"))

    private func service() -> PrometheusService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [IntegrationStubProtocol.self]
        return PrometheusService(
            cluster: StubCluster(objects: [:]), secrets: MemorySecrets(), configuration: config,
            azure: AzureCLIToken { throw PromError.config("no az in tests") })
    }

    /// The decoded `query` parameter of a request.
    private static func promql(_ request: URLRequest) -> String {
        guard let url = request.url, let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return "" }
        return components.queryItems?.first { $0.name == "query" }?.value ?? ""
    }

    private static func vector(_ result: String) -> (Int, String) {
        (200, #"{"status":"success","data":{"resultType":"vector","result":\#(result)}}"#)
    }

    private static func matrix(_ result: String) -> (Int, String) {
        (200, #"{"status":"success","data":{"resultType":"matrix","result":\#(result)}}"#)
    }

    func testNodeChartsFindNodeExporterThroughTheInternalIP() async throws {
        IntegrationStubProtocol.reset([:]) { request in
            let q = Self.promql(request)
            if q.hasPrefix("node_uname_info{nodename") { return Self.vector("[]") }
            if q.hasPrefix("kube_node_info") {
                return Self.vector(#"[{"metric":{"node":"n1","internal_ip":"10.0.0.7"},"value":[1,"1"]}]"#)
            }
            if q.hasPrefix("node_uname_info{instance=~") {
                return Self.vector(#"[{"metric":{"instance":"10.0.0.7:9100"},"value":[1,"1"]}]"#)
            }
            // node-exporter answers CPU only; everything else falls back.
            if q.contains("node_cpu_seconds_total") || q.contains("kube_node_status_allocatable") {
                return Self.matrix(#"[{"metric":{},"values":[[1,"0.5"],[2,"0.6"]]}]"#)
            }
            if q.contains(#"container_memory_working_set_bytes{node="n1""#) {
                return Self.matrix(#"[{"metric":{},"values":[[1,"100"]]}]"#)
            }
            return Self.matrix("[]")
        }
        let result = try await service().nodeMetrics(context: "prod", endpoint: external, node: "n1", range: .hour)
        XCTAssertEqual(result.charts.map(\.chart), HostChart.allCases)
        XCTAssertEqual(result.data(.cpu)?.source, .nodeExporter)
        XCTAssertTrue(result.data(.cpu)?.query.contains(#"instance="10.0.0.7:9100""#) ?? false)
        XCTAssertEqual(result.data(.cpuAllocatable)?.source, .kubeStateMetrics)
        XCTAssertEqual(result.data(.memory)?.source, .cadvisor, "no node-exporter memory: cAdvisor")
        XCTAssertNil(result.data(.filesystem)?.source)
        XCTAssertNil(result.data(.filesystem)?.error, "not available, not an error")
        let asked = IntegrationStubProtocol.requests.compactMap {
            URLComponents(string: $0.url)?.queryItems?.first { $0.name == "query" }?.value
        }
        XCTAssertFalse(asked.contains { $0.contains(#"container_cpu_usage_seconds_total{node="n1""#) },
            "node-exporter answered: no fallback")
    }

    func testClusterUsageReportsRejectedCredentialsOnce() async {
        IntegrationStubProtocol.reset([:]) { _ in (401, "") }
        do {
            _ = try await service().clusterUsage(context: "prod", endpoint: external, range: .hour)
            XCTFail("expected a 401")
        } catch {
            XCTAssertEqual(
                error as? PromError, .http(status: 401, reason: "authentication failed — check the credentials"))
        }
    }

    func testAlertsComeFromTheAlertsAPIWithRuleExpressions() async throws {
        let body = #"{"status":"success","data":\#(PromAlertsTests.alertsBody)}"#
        IntegrationStubProtocol.reset([
            "/api/v1/alerts": (200, body),
            "/api/v1/rules": (
                200,
                #"{"status":"success","data":{"groups":[{"rules":[{"type":"alerting","name":"Watchdog","query":"vector(1)","labels":{}}]}]}}"#
            ),
        ])
        let result = try await service().alerts(context: "prod", endpoint: external)
        XCTAssertEqual(result.source, .alertsAPI)
        XCTAssertEqual(result.alerts.map(\.name), ["KubePodCrashLooping", "Watchdog"])
        XCTAssertEqual(result.alerts[1].expr, "vector(1)")
        XCTAssertTrue(result.alerts[0].expr.hasPrefix(#"ALERTS{alertname="KubePodCrashLooping""#))
    }

    func testAlertsFallBackToTheAlertsSeries() async throws {
        IntegrationStubProtocol.reset([
            "/api/v1/query": Self.vector(
                #"[{"metric":{"alertname":"Watchdog","alertstate":"firing","severity":"none"},"value":[1,"1"]}]"#)
        ])
        let result = try await service().alerts(context: "prod", endpoint: external)
        XCTAssertEqual(result.source, .alertsMetric)
        XCTAssertEqual(result.alerts.map(\.expr), [#"ALERTS{alertname="Watchdog", alertstate="firing"}"#])
    }

    func testRejectedCredentialsAreNotAMissingAlertsAPI() async {
        IntegrationStubProtocol.reset(["/api/v1/alerts": (403, "")])
        do {
            _ = try await service().alerts(context: "prod", endpoint: external)
            XCTFail("expected a 403")
        } catch {
            XCTAssertEqual((error as? PromError).map { if case .http(403, _) = $0 { true } else { false } }, true)
        }
        XCTAssertEqual(IntegrationStubProtocol.requests.count, 1)
    }
}

/// Counts calls and answers with canned data.
private actor StubClusterQuerying: PrometheusClusterQuerying {
    var usageCalls: [MetricsRange] = []
    var alertCalls = 0
    var nodeCalls: [String] = []
    var failAlerts: PromError?

    func setFailAlerts(_ error: PromError?) { failAlerts = error }

    func clusterUsage(context: String, endpoint: PromEndpoint, range: MetricsRange) async throws -> HostMetrics {
        usageCalls.append(range)
        return HostMetrics(start: 0, end: 3600, step: 15, charts: [])
    }

    func nodeMetrics(context: String, endpoint: PromEndpoint, node: String, range: MetricsRange) async throws
        -> HostMetrics
    {
        nodeCalls.append("\(node)@\(range.rawValue)")
        return HostMetrics(start: 0, end: 3600, step: 15, charts: [])
    }

    func alerts(context: String, endpoint: PromEndpoint) async throws -> PromAlertsResult {
        alertCalls += 1
        if let failAlerts { throw failAlerts }
        return PromAlertsResult(
            alerts: [
                PromAlert(
                    name: "Watchdog", severity: "none", namespace: nil, pod: nil, node: nil, summary: nil,
                    activeAt: nil, expr: "vector(1)", labels: ["alertname": "Watchdog"])
            ], source: .alertsAPI)
    }
}

@MainActor
final class ClusterPromModelsTests: XCTestCase {

    private let endpoint = PromEndpoint(
        target: .inCluster(namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false))

    func testOverviewLoadsAtMostEvery30Seconds() async {
        let stub = StubClusterQuerying()
        let model = OverviewPromModel()
        let start = Date(timeIntervalSince1970: 1_000_000)
        await model.load(context: "prod", endpoint: endpoint, querying: stub, now: start)
        XCTAssertNotNil(model.usage)
        XCTAssertEqual(model.alerts?.map(\.name), ["Watchdog"])
        await model.load(context: "prod", endpoint: endpoint, querying: stub, now: start.addingTimeInterval(5))
        var calls = await stub.usageCalls
        var alertCalls = await stub.alertCalls
        XCTAssertEqual(calls, [.hour])
        XCTAssertEqual(alertCalls, 1)
        // Another range loads the history at once, not the alerts.
        model.range = .week
        await model.load(context: "prod", endpoint: endpoint, querying: stub, now: start.addingTimeInterval(6))
        calls = await stub.usageCalls
        alertCalls = await stub.alertCalls
        XCTAssertEqual(calls, [.hour, .week])
        XCTAssertEqual(alertCalls, 1)
        XCTAssertEqual(model.usageRange, .week)
        await model.load(context: "prod", endpoint: endpoint, querying: stub, now: start.addingTimeInterval(40))
        alertCalls = await stub.alertCalls
        XCTAssertEqual(alertCalls, 2)
    }

    func testOverviewClearsWithoutAnEndpointAndKeepsErrorsApart() async {
        let stub = StubClusterQuerying()
        let model = OverviewPromModel()
        await model.load(context: "prod", endpoint: endpoint, querying: stub)
        XCTAssertNotNil(model.alerts)
        await model.load(context: "prod", endpoint: nil, querying: stub)
        XCTAssertNil(model.alerts)
        XCTAssertNil(model.usage)
        await stub.setFailAlerts(.http(status: 404, reason: "not found"))
        await model.load(context: "other", endpoint: endpoint, querying: stub)
        XCTAssertEqual(model.alertsError, "Prometheus returned 404: not found")
        XCTAssertNil(model.usageError)
        XCTAssertNotNil(model.usage)
    }

    func testNodeMetricsLoadTheNodeAndRange() async {
        let stub = StubClusterQuerying()
        let model = NodeMetricsModel()
        await model.load(context: "prod", endpoint: endpoint, node: "minikube", querying: stub)
        XCTAssertNotNil(model.result)
        XCTAssertFalse(model.isLoading)
        model.range = .day
        await model.load(context: "prod", endpoint: endpoint, node: "minikube", querying: stub)
        let calls = await stub.nodeCalls
        XCTAssertEqual(calls, ["minikube@1h", "minikube@24h"])
        XCTAssertEqual(model.resultRange, .day)
    }
}
