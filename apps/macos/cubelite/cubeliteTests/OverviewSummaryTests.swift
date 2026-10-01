import XCTest

@testable import cubelite

/// Same fixture as `apps/desktop/src/lib/overview-summary.test.ts`: both apps
/// must produce the same Overview numbers.
final class OverviewSummaryTests: XCTestCase {

    private func pod(_ phase: String?) -> PodInfo {
        PodInfo(
            name: "p-\(phase ?? "nil")", namespace: "default", phase: phase,
            ready: phase == "Running", restarts: 0, creationTimestamp: nil)
    }

    private func service(_ type: String?) -> ServiceInfo {
        ServiceInfo(
            name: "s-\(type ?? "nil")", namespace: "default", type: type, clusterIP: nil,
            ports: nil, externalIP: nil, creationTimestamp: nil)
    }

    private func secret(_ type: String?) -> SecretInfo {
        SecretInfo(
            name: "x-\(type ?? "nil")", namespace: "default", type: type, dataCount: 0,
            creationTimestamp: nil)
    }

    private func ingress(tls: Bool) -> IngressInfo {
        IngressInfo(
            name: "i-\(tls)", namespace: "default", ingressClass: nil, hosts: nil, address: nil,
            tlsEnabled: tls, creationTimestamp: nil)
    }

    private func helm(_ status: String?) -> HelmReleaseInfo {
        HelmReleaseInfo(
            name: "h-\(status ?? "nil")", namespace: "default", chart: nil, appVersion: nil,
            revision: 1, status: status, creationTimestamp: nil)
    }

    private func fixture(nodeCount: Int? = 3) -> OverviewSummary {
        OverviewSummary(
            pods: [pod("Running"), pod("Running"), pod("Pending"), pod("Failed"), pod("Succeeded")],
            deployments: [
                DeploymentInfo(name: "a", namespace: "default", replicas: 2, readyReplicas: 2),
                DeploymentInfo(name: "b", namespace: "default", replicas: 3, readyReplicas: 1),
                DeploymentInfo(name: "c", namespace: "default", replicas: 0, readyReplicas: 0),
            ],
            namespaces: [
                NamespaceInfo(name: "default", phase: "Active"),
                NamespaceInfo(name: "old", phase: "Terminating"),
            ],
            services: [
                service("ClusterIP"), service("ClusterIP"), service("NodePort"),
                service("LoadBalancer"), service("ExternalName"),
            ],
            secrets: [
                secret("Opaque"), secret("kubernetes.io/tls"),
                secret("kubernetes.io/dockerconfigjson"),
                secret("kubernetes.io/service-account-token"),
            ],
            configMaps: [
                ConfigMapInfo(name: "c", namespace: "default", dataCount: 1, creationTimestamp: nil)
            ],
            ingresses: [ingress(tls: true), ingress(tls: false)],
            helmReleases: [helm("deployed"), helm("failed"), helm("superseded")],
            nodeCount: nodeCount)
    }

    // MARK: - Counting

    func testCountsTheSharedFixture() {
        let summary = fixture()
        XCTAssertEqual(summary.nodes, 3)
        XCTAssertEqual(summary.pods, .init(total: 5, running: 2, pending: 1, failed: 1))
        XCTAssertEqual(summary.deployments, .init(total: 3, healthy: 2, degraded: 1))
        XCTAssertEqual(summary.namespaces, .init(total: 2, active: 1))
        XCTAssertEqual(
            summary.services, .init(total: 5, clusterIP: 2, nodePort: 1, loadBalancer: 1))
        XCTAssertEqual(summary.secrets, .init(total: 4, opaque: 1, tls: 1, docker: 1))
        XCTAssertEqual(summary.configMaps, 1)
        XCTAssertEqual(summary.ingresses, .init(total: 2, tls: 1))
        XCTAssertEqual(summary.helm, .init(total: 3, deployed: 1, failed: 1))
    }

    func testUnknownNodeCountStaysNil() {
        XCTAssertNil(fixture(nodeCount: nil).nodes)
    }

    func testEmptyClusterCountsZeros() {
        let summary = OverviewSummary(
            pods: [], deployments: [], namespaces: [], services: [], secrets: [],
            configMaps: [], ingresses: [], helmReleases: [], nodeCount: nil)
        XCTAssertEqual(summary.pods, .init())
        XCTAssertEqual(summary.deployments, .init())
        XCTAssertEqual(summary.configMaps, 0)
    }

    @MainActor
    func testStateInitFallsBackToMetricsNodes() {
        let state = ClusterState()
        XCTAssertNil(OverviewSummary(state: state).nodes)
        state.nodeMetrics = [NodeMetricsInfo(name: "n1", cpuCores: 1, memoryBytes: 1)]
        XCTAssertEqual(OverviewSummary(state: state).nodes, 1)
    }

    // MARK: - Capacity sub-labels

    func testCapacityDetailsUseOneDecimal() {
        let capacity = ClusterCapacity(
            cpuUsedCores: 1.2, cpuAllocatableCores: 4, memUsedBytes: 3.5 * 1_073_741_824,
            memAllocatableBytes: 16 * 1_073_741_824)
        XCTAssertEqual(OverviewSummary.coresDetail(capacity), "1.2 / 4.0 cores")
        XCTAssertEqual(OverviewSummary.memoryDetail(capacity), "3.5 / 16.0 GiB")
    }

    func testCapacityDetailsAreNilWithoutAllocatable() {
        let capacity = ClusterCapacity(
            cpuUsedCores: 1, cpuAllocatableCores: 0, memUsedBytes: 1, memAllocatableBytes: 0)
        XCTAssertNil(OverviewSummary.coresDetail(capacity))
        XCTAssertNil(OverviewSummary.memoryDetail(capacity))
    }
}
