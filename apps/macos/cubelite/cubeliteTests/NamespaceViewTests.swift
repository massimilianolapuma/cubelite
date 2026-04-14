import XCTest
@testable import cubelite

// MARK: - NamespaceViewTests

/// Unit tests for namespace-related model mappings and pod count logic.
final class NamespaceViewTests: XCTestCase {

    // MARK: - toPodInfo: CPU and Memory

    func testToPodInfo_extractsCPUAndMemoryRequests() {
        let pod = K8sPod(
            metadata: K8sObjectMeta(name: "my-pod", namespace: "default", creationTimestamp: nil),
            spec: K8sPodSpec(
                nodeName: "node-1",
                containers: [
                    K8sContainer(resources: K8sResourceRequirements(requests: ["cpu": "250m", "memory": "256Mi"]))
                ]
            ),
            status: K8sPodStatus(phase: "Running", podIP: nil, hostIP: nil, containerStatuses: nil)
        )

        let info = pod.toPodInfo()

        XCTAssertEqual(info.cpuRequest, "250m")
        XCTAssertEqual(info.memoryRequest, "256Mi")
    }

    // MARK: - toPodInfo: podIP and nodeName

    func testToPodInfo_extractsPodIPAndNodeName() {
        let pod = K8sPod(
            metadata: K8sObjectMeta(name: "web-pod", namespace: "staging", creationTimestamp: nil),
            spec: K8sPodSpec(nodeName: "worker-node-3", containers: nil),
            status: K8sPodStatus(phase: "Running", podIP: "10.0.0.42", hostIP: "192.168.1.10", containerStatuses: nil)
        )

        let info = pod.toPodInfo()

        XCTAssertEqual(info.podIP, "10.0.0.42")
        XCTAssertEqual(info.nodeName, "worker-node-3")
    }

    // MARK: - toPodInfo: missing optional fields

    func testToPodInfo_missingOptionalFields_fillsWithNil() {
        let pod = K8sPod(
            metadata: K8sObjectMeta(name: "bare-pod", namespace: "default", creationTimestamp: nil),
            spec: nil,
            status: nil
        )

        let info = pod.toPodInfo()

        XCTAssertNil(info.nodeName)
        XCTAssertNil(info.podIP)
        XCTAssertNil(info.cpuRequest)
        XCTAssertNil(info.memoryRequest)
    }

    // MARK: - toPodInfo: restarts across multiple containers

    func testToPodInfo_multipleContainers_sumRestarts() {
        let statuses = [
            K8sContainerStatus(ready: true, restartCount: 3),
            K8sContainerStatus(ready: true, restartCount: 7),
        ]
        let pod = K8sPod(
            metadata: K8sObjectMeta(name: "multi-pod", namespace: "default", creationTimestamp: nil),
            spec: nil,
            status: K8sPodStatus(phase: "Running", podIP: nil, hostIP: nil, containerStatuses: statuses)
        )

        let info = pod.toPodInfo()

        XCTAssertEqual(info.restarts, 10)
        XCTAssertTrue(info.ready)
    }

    // MARK: - toPodInfo: CPU only set for first container

    func testToPodInfo_multipleContainers_cpuFromFirstContainerOnly() {
        let pod = K8sPod(
            metadata: K8sObjectMeta(name: "multi-container", namespace: "default", creationTimestamp: nil),
            spec: K8sPodSpec(
                nodeName: nil,
                containers: [
                    K8sContainer(resources: K8sResourceRequirements(requests: ["cpu": "100m"])),
                    K8sContainer(resources: K8sResourceRequirements(requests: ["cpu": "500m"])),
                ]
            ),
            status: K8sPodStatus(phase: "Running", podIP: nil, hostIP: nil, containerStatuses: nil)
        )

        let info = pod.toPodInfo()

        XCTAssertEqual(info.cpuRequest, "100m", "CPU request should reflect the first container only")
    }

    // MARK: - Pod Count Badge Logic

    func testNamespacePodCounts_groupsByNamespace() {
        let pods: [PodInfo] = [
            PodInfo(name: "a", namespace: "default", phase: "Running", ready: true, restarts: 0, creationTimestamp: nil),
            PodInfo(name: "b", namespace: "default", phase: "Running", ready: true, restarts: 0, creationTimestamp: nil),
            PodInfo(name: "c", namespace: "kube-system", phase: "Running", ready: true, restarts: 0, creationTimestamp: nil),
        ]

        let counts = Dictionary(grouping: pods, by: { $0.namespace }).mapValues { $0.count }

        XCTAssertEqual(counts["default"], 2)
        XCTAssertEqual(counts["kube-system"], 1)
        XCTAssertNil(counts["monitoring"])
    }

    func testNamespacePodCounts_emptyPods_returnsEmptyDictionary() {
        let pods: [PodInfo] = []

        let counts = Dictionary(grouping: pods, by: { $0.namespace }).mapValues { $0.count }

        XCTAssertTrue(counts.isEmpty)
    }

    func testNamespacePodCounts_allPodsInSameNamespace() {
        let pods: [PodInfo] = [
            PodInfo(name: "p1", namespace: "prod", phase: "Running", ready: true, restarts: 0, creationTimestamp: nil),
            PodInfo(name: "p2", namespace: "prod", phase: "Running", ready: true, restarts: 0, creationTimestamp: nil),
            PodInfo(name: "p3", namespace: "prod", phase: "Pending", ready: false, restarts: 1, creationTimestamp: nil),
        ]

        let counts = Dictionary(grouping: pods, by: { $0.namespace }).mapValues { $0.count }

        XCTAssertEqual(counts["prod"], 3)
        XCTAssertEqual(counts.keys.count, 1)
    }
}
