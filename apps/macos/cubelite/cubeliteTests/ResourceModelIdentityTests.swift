import XCTest

@testable import cubelite

// MARK: - ResourceModelIdentityTests

/// Tests for the Identifiable identities and core properties of
/// ``PodInfo``, ``DeploymentInfo``, ``NamespaceInfo``, and ``DeploymentCondition``.
final class ResourceModelIdentityTests: XCTestCase {

    // MARK: - PodInfo

    func testPodInfo_id_isNamespacePlusName() {
        let pod = PodInfo(
            name: "nginx-abc",
            namespace: "default",
            phase: "Running",
            ready: true,
            restarts: 0,
            creationTimestamp: nil
        )
        XCTAssertEqual(pod.id, "default/nginx-abc")
    }

    func testPodInfo_id_distinguishesSameNameInDifferentNamespaces() {
        let pod1 = PodInfo(
            name: "api", namespace: "staging",
            phase: "Running", ready: true, restarts: 0, creationTimestamp: nil
        )
        let pod2 = PodInfo(
            name: "api", namespace: "production",
            phase: "Running", ready: true, restarts: 0, creationTimestamp: nil
        )
        XCTAssertNotEqual(pod1.id, pod2.id)
    }

    func testPodInfo_ready_true() {
        let pod = PodInfo(
            name: "p", namespace: "ns",
            phase: "Running", ready: true, restarts: 0, creationTimestamp: nil
        )
        XCTAssertTrue(pod.ready)
    }

    func testPodInfo_ready_false() {
        let pod = PodInfo(
            name: "p", namespace: "ns",
            phase: "Pending", ready: false, restarts: 0, creationTimestamp: nil
        )
        XCTAssertFalse(pod.ready)
    }

    func testPodInfo_restarts_preserved() {
        let pod = PodInfo(
            name: "p", namespace: "ns",
            phase: "Running", ready: true, restarts: 42, creationTimestamp: nil
        )
        XCTAssertEqual(pod.restarts, 42)
    }

    func testPodInfo_phase_nil_allowed() {
        let pod = PodInfo(
            name: "p", namespace: "ns",
            phase: nil, ready: false, restarts: 0, creationTimestamp: nil
        )
        XCTAssertNil(pod.phase)
    }

    func testPodInfo_optionalFields_defaultToNil() {
        let pod = PodInfo(
            name: "p", namespace: "ns",
            phase: "Running", ready: true, restarts: 0, creationTimestamp: nil
        )
        XCTAssertNil(pod.nodeName)
        XCTAssertNil(pod.podIP)
        XCTAssertNil(pod.cpuRequest)
        XCTAssertNil(pod.memoryRequest)
    }

    func testPodInfo_mutableFields_canBeAssigned() {
        var pod = PodInfo(
            name: "p", namespace: "ns",
            phase: "Running", ready: true, restarts: 0, creationTimestamp: nil
        )
        pod.nodeName = "worker-1"
        pod.podIP = "10.0.0.5" // NOSONAR — mock pod IP in test fixture
        pod.cpuRequest = "500m"
        pod.memoryRequest = "256Mi"
        XCTAssertEqual(pod.nodeName, "worker-1")
        XCTAssertEqual(pod.podIP, "10.0.0.5") // NOSONAR
        XCTAssertEqual(pod.cpuRequest, "500m")
        XCTAssertEqual(pod.memoryRequest, "256Mi")
    }

    // MARK: - PodInfo Codable

    func testPodInfo_codableRoundTrip() throws {
        let original = PodInfo(
            name: "my-pod", namespace: "default",
            phase: "Running", ready: true, restarts: 3,
            creationTimestamp: "2024-01-01T00:00:00Z"
        )
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(PodInfo.self, from: data)
        XCTAssertEqual(decoded.name, original.name)
        XCTAssertEqual(decoded.namespace, original.namespace)
        XCTAssertEqual(decoded.phase, original.phase)
        XCTAssertEqual(decoded.ready, original.ready)
        XCTAssertEqual(decoded.restarts, original.restarts)
        XCTAssertEqual(decoded.creationTimestamp, original.creationTimestamp)
        XCTAssertEqual(decoded.id, original.id)
    }

    // MARK: - NamespaceInfo

    func testNamespaceInfo_id_equalsName() {
        let ns = NamespaceInfo(name: "kube-system", phase: "Active")
        XCTAssertEqual(ns.id, "kube-system")
    }

    func testNamespaceInfo_phase_preserved() {
        let ns = NamespaceInfo(name: "ns", phase: "Terminating")
        XCTAssertEqual(ns.phase, "Terminating")
    }

    func testNamespaceInfo_phase_canBeNil() {
        let ns = NamespaceInfo(name: "ns", phase: nil)
        XCTAssertNil(ns.phase)
    }

    func testNamespaceInfo_differentNames_haveDistinctIDs() {
        let ns1 = NamespaceInfo(name: "default", phase: "Active")
        let ns2 = NamespaceInfo(name: "production", phase: "Active")
        XCTAssertNotEqual(ns1.id, ns2.id)
    }

    // MARK: - DeploymentInfo

    func testDeploymentInfo_id_isNamespacePlusName() {
        let dep = DeploymentInfo(
            name: "api-server", namespace: "production",
            replicas: 3, readyReplicas: 3
        )
        XCTAssertEqual(dep.id, "production/api-server")
    }

    func testDeploymentInfo_id_distinguishesSameNameAcrossNamespaces() {
        let dep1 = DeploymentInfo(
            name: "backend", namespace: "staging", replicas: 1, readyReplicas: 1)
        let dep2 = DeploymentInfo(
            name: "backend", namespace: "production", replicas: 3, readyReplicas: 3)
        XCTAssertNotEqual(dep1.id, dep2.id)
    }

    func testDeploymentInfo_replicas_preserved() {
        let dep = DeploymentInfo(name: "d", namespace: "ns", replicas: 5, readyReplicas: 4)
        XCTAssertEqual(dep.replicas, 5)
        XCTAssertEqual(dep.readyReplicas, 4)
    }

    func testDeploymentInfo_optionalFieldsDefaultToNil() {
        let dep = DeploymentInfo(name: "d", namespace: "ns", replicas: 1, readyReplicas: 1)
        XCTAssertNil(dep.strategy)
        XCTAssertNil(dep.selector)
        XCTAssertNil(dep.creationTimestamp)
        XCTAssertNil(dep.conditions)
        XCTAssertNil(dep.availableReplicas)
        XCTAssertNil(dep.unavailableReplicas)
    }

    func testDeploymentInfo_codableRoundTrip() throws {
        let original = DeploymentInfo(
            name: "web", namespace: "default",
            replicas: 2, readyReplicas: 2,
            strategy: "RollingUpdate",
            creationTimestamp: "2024-06-01T12:00:00Z"
        )
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(DeploymentInfo.self, from: data)
        XCTAssertEqual(decoded.name, original.name)
        XCTAssertEqual(decoded.namespace, original.namespace)
        XCTAssertEqual(decoded.strategy, original.strategy)
        XCTAssertEqual(decoded.id, original.id)
    }

    // MARK: - DeploymentCondition

    func testDeploymentCondition_id_equalsType() {
        let cond = DeploymentCondition(
            type: "Available",
            status: "True",
            reason: nil,
            message: nil,
            lastTransitionTime: nil
        )
        XCTAssertEqual(cond.id, "Available")
    }

    func testDeploymentCondition_preservesAllFields() {
        let cond = DeploymentCondition(
            type: "Progressing",
            status: "True",
            reason: "NewReplicaSet",
            message: "Deployment has minimum availability.",
            lastTransitionTime: "2024-01-01T00:00:00Z"
        )
        XCTAssertEqual(cond.type, "Progressing")
        XCTAssertEqual(cond.status, "True")
        XCTAssertEqual(cond.reason, "NewReplicaSet")
        XCTAssertEqual(cond.message, "Deployment has minimum availability.")
        XCTAssertEqual(cond.lastTransitionTime, "2024-01-01T00:00:00Z")
    }

    func testDeploymentCondition_optionalFieldsCanBeNil() {
        let cond = DeploymentCondition(
            type: "Available",
            status: "Unknown",
            reason: nil,
            message: nil,
            lastTransitionTime: nil
        )
        XCTAssertNil(cond.reason)
        XCTAssertNil(cond.message)
        XCTAssertNil(cond.lastTransitionTime)
    }
}
