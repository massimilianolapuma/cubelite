import XCTest

@testable import cubelite

// MARK: - ClusterState Tests

@MainActor
final class ClusterStateTests: XCTestCase {

    // MARK: Default Values

    func testInitialState_contextsIsEmpty() {
        let sut = ClusterState()
        XCTAssertTrue(sut.contexts.isEmpty)
    }

    func testInitialState_currentContextIsNil() {
        let sut = ClusterState()
        XCTAssertNil(sut.currentContext)
    }

    func testInitialState_podsIsEmpty() {
        let sut = ClusterState()
        XCTAssertTrue(sut.pods.isEmpty)
    }

    func testInitialState_namespacesIsEmpty() {
        let sut = ClusterState()
        XCTAssertTrue(sut.namespaces.isEmpty)
    }

    func testInitialState_deploymentsIsEmpty() {
        let sut = ClusterState()
        XCTAssertTrue(sut.deployments.isEmpty)
    }

    func testInitialState_selectedNamespaceIsNil() {
        let sut = ClusterState()
        XCTAssertNil(sut.selectedNamespace)
    }

    func testInitialState_isLoadingIsFalse() {
        let sut = ClusterState()
        XCTAssertFalse(sut.isLoading)
    }

    func testInitialState_isLoadingResourcesIsFalse() {
        let sut = ClusterState()
        XCTAssertFalse(sut.isLoadingResources)
    }

    func testInitialState_noConfigIsFalse() {
        let sut = ClusterState()
        XCTAssertFalse(sut.noConfig)
    }

    func testInitialState_errorMessageIsNil() {
        let sut = ClusterState()
        XCTAssertNil(sut.errorMessage)
    }

    func testInitialState_resourceErrorIsNil() {
        let sut = ClusterState()
        XCTAssertNil(sut.resourceError)
    }

    func testInitialState_namespacePodCountsIsEmpty() {
        let sut = ClusterState()
        XCTAssertTrue(sut.namespacePodCounts.isEmpty)
    }

    func testInitialState_clusterReachableIsNil() {
        let sut = ClusterState()
        XCTAssertNil(sut.clusterReachable)
    }

    // MARK: Mutation

    func testSetContexts_updatesCorrectly() {
        let sut = ClusterState()
        sut.contexts = ["ctx-a", "ctx-b", "ctx-c"]
        XCTAssertEqual(sut.contexts.count, 3)
        XCTAssertEqual(sut.contexts, ["ctx-a", "ctx-b", "ctx-c"])
    }

    func testSetCurrentContext_updatesCorrectly() {
        let sut = ClusterState()
        sut.currentContext = "minikube"
        XCTAssertEqual(sut.currentContext, "minikube")
    }

    func testSetErrorMessage_updatesCorrectly() {
        let sut = ClusterState()
        sut.errorMessage = "Connection refused"
        XCTAssertEqual(sut.errorMessage, "Connection refused")
    }

    func testSetClusterReachable_true() {
        let sut = ClusterState()
        sut.clusterReachable = true
        XCTAssertEqual(sut.clusterReachable, true)
    }

    func testSetClusterReachable_false() {
        let sut = ClusterState()
        sut.clusterReachable = false
        XCTAssertEqual(sut.clusterReachable, false)
    }

    func testNamespacePodCounts_aggregation() {
        let sut = ClusterState()
        sut.namespacePodCounts = [
            "default": 5,
            "kube-system": 12,
            "monitoring": 3,
        ]
        XCTAssertEqual(sut.namespacePodCounts["default"], 5)
        XCTAssertEqual(sut.namespacePodCounts["kube-system"], 12)
        XCTAssertEqual(sut.namespacePodCounts.count, 3)
    }
}

// MARK: - ResourceType Tests

final class ResourceTypeTests: XCTestCase {

    func testPods_rawValue() {
        XCTAssertEqual(ResourceType.pods.rawValue, "Pods")
    }

    func testDeployments_rawValue() {
        XCTAssertEqual(ResourceType.deployments.rawValue, "Deployments")
    }

    func testPods_systemImage() {
        XCTAssertEqual(ResourceType.pods.systemImage, "cube.box")
    }

    func testDeployments_systemImage() {
        XCTAssertEqual(ResourceType.deployments.systemImage, "arrow.triangle.2.circlepath")
    }

    func testIdentifiable_id() {
        XCTAssertEqual(ResourceType.pods.id, "Pods")
        XCTAssertEqual(ResourceType.deployments.id, "Deployments")
    }

    func testCaseIterable_containsAllCases() {
        let all = ResourceType.allCases
        XCTAssertEqual(all.count, 8)
        XCTAssertTrue(all.contains(.dashboard))
        XCTAssertTrue(all.contains(.pods))
        XCTAssertTrue(all.contains(.deployments))
        XCTAssertTrue(all.contains(.services))
        XCTAssertTrue(all.contains(.secrets))
        XCTAssertTrue(all.contains(.configMaps))
        XCTAssertTrue(all.contains(.ingresses))
        XCTAssertTrue(all.contains(.helmReleases))
    }
}
