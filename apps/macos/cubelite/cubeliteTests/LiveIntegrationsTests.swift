import XCTest

@testable import cubelite

/// Live checks of the Swift Elasticsearch and Prometheus services against a
/// real cluster (the spec's manual checklist, #502 #511 #519 #525). Skipped unless
/// `CUBELITE_LIVE_CONTEXT` names a kube context with ECK (`logging/quickstart`),
/// kube-prometheus-stack and pods in `shop`:
///
///     TEST_RUNNER_CUBELITE_LIVE_CONTEXT=minikube xcodebuild test … \
///       -only-testing cubeliteTests/LiveIntegrationsTests
final class LiveIntegrationsTests: XCTestCase {

    private func context() throws -> String {
        guard let context = ProcessInfo.processInfo.environment["CUBELITE_LIVE_CONTEXT"] else {
            throw XCTSkip("set CUBELITE_LIVE_CONTEXT to run against a live cluster")
        }
        return context
    }

    private func api() -> KubeAPIService {
        KubeAPIService(kubeconfigService: KubeconfigService())
    }

    func testElasticsearchHistoryThroughTheECKTunnel() async throws {
        let context = try context()
        let api = api()
        let service = ElasticService(cluster: api, secrets: MemorySecrets())
        let found = try await service.detect(context: context)
        let es = try XCTUnwrap(found.first { $0.kind == .elasticsearch })
        let endpoint = EsEndpoint(
            target: .inCluster(namespace: es.namespace, service: es.name, port: es.port, https: es.https),
            indexPattern: "logs-*,filebeat-*")
        let info = try await service.test(context: context, endpoint: endpoint, auth: .eckUser)
        print("info:", info)
        XCTAssertTrue(info.version.hasPrefix("8"))
        try await service.useEckCredentials(context: context, endpoint: endpoint)
        let pods = try await api.listPods(namespace: "shop", inContext: context)
        let pod = try XCTUnwrap(pods.first { $0.name.hasPrefix("api-") })
        let page = try await service.search(
            context: context, endpoint: endpoint,
            query: HistoryQuery(namespace: "shop", pod: pod.name, from: "now-1h", to: "now", size: 50))
        print("\(pod.name): \(page.total ?? 0) hits")
        XCTAssertFalse(page.lines.isEmpty)
        XCTAssertNotNil(page.next)
        let older = try await service.search(
            context: context, endpoint: endpoint,
            query: HistoryQuery(
                namespace: "shop", pod: pod.name, from: "now-1h", to: "now", searchAfter: page.next,
                size: 50))
        XCTAssertFalse(older.lines.isEmpty, "load older")
        XCTAssertLessThanOrEqual(older.lines.first?.time ?? "", page.lines.last?.time ?? "")

        // In-cluster Kibana through the service's forward (#519).
        let kb = try XCTUnwrap(found.first { $0.kind == .kibana })
        let kibana = KibanaService(namespace: kb.namespace, service: kb.name, port: kb.port, https: kb.https)
        let port = try await service.kibanaForward(context: context, service: kibana)
        let again = try await service.kibanaForward(context: context, service: kibana)
        XCTAssertEqual(port, again)
        let probe = try XCTUnwrap(URL(string: "\(kb.https ? "https" : "http")://127.0.0.1:\(port)/api/status"))
        // Verified TLS: ECK's CA, and the service name the certificate carries.
        let caSecret = try await api.getIfPresent(
            path: "/api/v1/namespaces/\(kb.namespace)/secrets/\(kb.name)-certs-public", inContext: context)
        let secret = try XCTUnwrap(caSecret)
        let pem = try XCTUnwrap(try JSONDecoder().decode(IntegrationK8s.Secret.self, from: secret).value("ca.crt"))
        let der = try XCTUnwrap(Integration.firstPEMCertificate(pem))
        let anchor = try XCTUnwrap(SecCertificateCreateWithData(nil, der as CFData))
        let verified = URLSession(
            configuration: .ephemeral,
            delegate: IntegrationTrustDelegate(
                hostname: Integration.serviceHost(namespace: kb.namespace, service: kb.name), anchor: anchor,
                insecure: false),
            delegateQueue: nil)
        let (_, response) = try await verified.data(from: probe)
        XCTAssertTrue([200, 401].contains((response as? HTTPURLResponse)?.statusCode ?? 0))
        verified.invalidateAndCancel()
        await service.disconnectAll()
    }

    func testPrometheusChartsThroughTheServiceProxy() async throws {
        let context = try context()
        let api = api()
        let service = PrometheusService(cluster: api, secrets: MemorySecrets())
        let found = try await service.detect(context: context)
        let prom = try XCTUnwrap(found.first { $0.kind == .prometheus })
        let endpoint = PromEndpoint(
            target: .inCluster(namespace: prom.namespace, service: prom.name, port: prom.port, https: prom.https))
        let info = try await service.test(context: context, endpoint: endpoint, auth: PromAuth.none)
        print("info:", info)
        XCTAssertTrue(info.cadvisor)
        XCTAssertTrue(info.kubeStateMetrics)
        let pods = try await api.listPods(namespace: "shop", inContext: context)
        let pod = try XCTUnwrap(pods.first { $0.name.hasPrefix("api-") })
        for workload in [Workload.pod(pod.name), .deployment("api")] {
            let result = try await service.metrics(
                context: context, endpoint: endpoint,
                request: MetricsRequest(namespace: "shop", workload: workload, range: .hour, perContainer: true))
            for chart in result.charts {
                XCTAssertNil(chart.error, "\(workload) \(chart.chart): \(chart.error ?? "")")
            }
            XCTAssertFalse(result.data(.cpu)?.series.isEmpty ?? true, "CPU for \(workload)")
        }
        let sparklines = try await service.sparklines(context: context, endpoint: endpoint, namespace: "shop")
        XCTAssertTrue(sparklines.cpu.keys.contains { $0.hasPrefix("shop/api-") })

        // In-cluster Grafana through the service's forward (#525): what Open
        // in Grafana opens, plain http on the IPv4 loopback.
        let gf = try XCTUnwrap(found.first { $0.kind == .grafana })
        XCTAssertFalse(gf.https)
        let port = try await service.grafanaForward(context: context, service: gf.serviceRef)
        let again = try await service.grafanaForward(context: context, service: gf.serviceRef)
        XCTAssertEqual(port, again)
        let health = try XCTUnwrap(URL(string: gf.serviceRef.loopbackBase(port: port) + "/api/health"))
        let session = URLSession(configuration: .ephemeral)
        let (body, response) = try await session.data(from: health)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertTrue(String(decoding: body, as: UTF8.self).contains(#""database""#))
        session.invalidateAndCancel()
        await service.disconnectAll()
    }

    /// Detect on connect (#527): one listing finds all four services.
    func testDetectionOnConnectFindsAllFourServices() async throws {
        let context = try context()
        let found = try await DetectedIntegrations.detect(context: context, cluster: api())
        print("detected:", found)
        XCTAssertEqual(found.elasticsearch?.id, "elasticsearch:logging/quickstart-es-http:9200")
        XCTAssertEqual(found.kibana?.id, "kibana:logging/quickstart-kb-http:5601")
        XCTAssertEqual(found.prometheus?.id, "prometheus:monitoring/prometheus-operated:9090")
        XCTAssertEqual(found.grafana?.namespace, "monitoring")
        XCTAssertEqual(found.grafana?.name, "kps-grafana")
        XCTAssertTrue(found.elasticsearchOneClick, "ECK controller owner verified, selector names it, alone")
        // kube-prometheus-stack: `prometheus-operated` is the operator's
        // governing service (owner without `controller`, selecting every
        // Prometheus of the namespace) and the chart's service has no
        // owner, so Prometheus is offered for Review only.
        XCTAssertFalse(found.prometheusOneClick)
    }
}
