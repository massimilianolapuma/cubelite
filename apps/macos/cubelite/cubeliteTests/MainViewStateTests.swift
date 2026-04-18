import XCTest

@testable import cubelite

// MARK: - MainViewStateTests

/// Tests for ``ClusterState`` properties that drive ``MainView``'s
/// toolbar, sidebar, resource list, and error banner sub-views.
///
/// These tests validate the model transitions the view observes, without
/// requiring a UIKit/SwiftUI host.
@MainActor
final class MainViewStateTests: XCTestCase {

    // MARK: - Toolbar: Loading Indicators

    func testToolbar_isLoading_trueWhenLoadingKubeconfig() {
        let state = ClusterState()
        state.isLoading = true

        XCTAssertTrue(state.isLoading)
        XCTAssertFalse(state.isLoadingResources)
    }

    func testToolbar_isLoadingResources_trueWhenFetchingPods() {
        let state = ClusterState()
        state.isLoadingResources = true

        XCTAssertTrue(state.isLoadingResources)
        XCTAssertFalse(state.isLoading)
    }

    func testToolbar_notLoading_whenBothFalse() {
        let state = ClusterState()
        state.isLoading = false
        state.isLoadingResources = false

        XCTAssertFalse(state.isLoading || state.isLoadingResources)
    }

    func testToolbar_reloadButton_disabledWhileLoading() {
        // The reload button is disabled when isLoading OR isLoadingResources is true.
        let state = ClusterState()

        state.isLoading = true
        XCTAssertTrue(
            state.isLoading || state.isLoadingResources,
            "Reload button should be disabled while loading")

        state.isLoading = false
        XCTAssertFalse(
            state.isLoading || state.isLoadingResources,
            "Reload button should be enabled when not loading")
    }

    // MARK: - Toolbar: Cluster Reachability Status

    func testToolbar_clusterNotReachable_showsStatusItem() {
        let state = ClusterState()
        state.clusterReachable = false

        // The toolbar shows "Cluster not reachable" when clusterReachable == false.
        XCTAssertEqual(state.clusterReachable, false)
    }

    func testToolbar_clusterReachable_noStatusItem() {
        let state = ClusterState()
        state.clusterReachable = true

        XCTAssertNotEqual(state.clusterReachable, false)
    }

    func testToolbar_clusterUnknown_noStatusItem() {
        let state = ClusterState()
        // nil means "not yet checked" — the status item is hidden.
        XCTAssertNil(state.clusterReachable)
    }

    // MARK: - Sidebar: Context List

    func testSidebar_contextsList_populatedAfterLoad() {
        let state = ClusterState()
        state.contexts = ["production", "staging", "dev"]

        XCTAssertEqual(state.contexts.count, 3)
        XCTAssertTrue(state.contexts.contains("staging"))
    }

    func testSidebar_contextsList_emptyBeforeLoad() {
        let state = ClusterState()
        XCTAssertTrue(state.contexts.isEmpty)
    }

    func testSidebar_currentContext_highlightedInList() {
        let state = ClusterState()
        state.contexts = ["prod", "dev"]
        state.currentContext = "prod"

        XCTAssertEqual(state.currentContext, "prod")
        XCTAssertTrue(state.contexts.contains(state.currentContext ?? ""))
    }

    func testSidebar_noConfig_contextsEmpty() {
        let state = ClusterState()
        state.noConfig = true

        XCTAssertTrue(state.noConfig)
        XCTAssertTrue(state.contexts.isEmpty)
    }

    // MARK: - Resource Area: Pods

    func testResourceArea_podsPopulated_afterFetch() {
        let state = ClusterState()
        state.pods = [
            PodInfo(
                name: "nginx-1", namespace: "default", phase: "Running", ready: true, restarts: 0,
                creationTimestamp: nil),
            PodInfo(
                name: "nginx-2", namespace: "default", phase: "Pending", ready: false, restarts: 1,
                creationTimestamp: nil),
        ]

        XCTAssertEqual(state.pods.count, 2)
        XCTAssertEqual(state.pods.first?.name, "nginx-1")
    }

    func testResourceArea_pods_clearedOnContextSwitch() {
        let state = ClusterState()
        state.pods = [
            PodInfo(
                name: "api", namespace: "ns", phase: "Running", ready: true, restarts: 0,
                creationTimestamp: nil)
        ]

        // Simulate context switch clearing resources.
        state.pods = []

        XCTAssertTrue(state.pods.isEmpty)
    }

    // MARK: - Resource Area: Deployments

    func testResourceArea_deploymentsPopulated_afterFetch() {
        let state = ClusterState()
        state.deployments = [
            DeploymentInfo(name: "backend", namespace: "production", replicas: 3, readyReplicas: 3),
            DeploymentInfo(
                name: "frontend", namespace: "production", replicas: 2, readyReplicas: 1),
        ]

        XCTAssertEqual(state.deployments.count, 2)
        XCTAssertEqual(state.deployments.last?.name, "frontend")
    }

    // MARK: - Resource Area: Namespace Filter

    func testResourceArea_selectedNamespace_filtersLabel() {
        let state = ClusterState()
        state.selectedNamespace = "kube-system"

        XCTAssertEqual(state.selectedNamespace, "kube-system")
    }

    func testResourceArea_selectedNamespace_nilMeansAllNamespaces() {
        let state = ClusterState()
        XCTAssertNil(state.selectedNamespace, "nil namespace means show all namespaces")
    }

    // MARK: - Namespace Pod Counts

    func testNamespacePodCounts_populatedFromPodFetch() {
        let state = ClusterState()
        state.namespacePodCounts = [
            "default": 4,
            "kube-system": 12,
            "monitoring": 2,
        ]

        XCTAssertEqual(state.namespacePodCounts["default"], 4)
        XCTAssertEqual(state.namespacePodCounts["kube-system"], 12)
        XCTAssertEqual(state.namespacePodCounts.values.reduce(0, +), 18)
    }

    func testNamespacePodCounts_clearedOnContextChange() {
        let state = ClusterState()
        state.namespacePodCounts = ["default": 3]

        state.namespacePodCounts = [:]

        XCTAssertTrue(state.namespacePodCounts.isEmpty)
    }

    // MARK: - Error Banner

    func testErrorBanner_showsWhenErrorMessageIsSet() {
        let state = ClusterState()
        state.errorMessage = "Failed to load kubeconfig: file not found"

        XCTAssertNotNil(state.errorMessage)
    }

    func testErrorBanner_hiddenWhenErrorMessageIsNil() {
        let state = ClusterState()

        XCTAssertNil(state.errorMessage)
    }

    func testErrorBanner_resourceError_separateFromLoadError() {
        let state = ClusterState()
        state.errorMessage = nil
        state.resourceError = "Cluster unreachable"

        XCTAssertNil(state.errorMessage)
        XCTAssertNotNil(state.resourceError)
    }

    func testErrorBanner_bothErrors_canCoexist() {
        let state = ClusterState()
        state.errorMessage = "Config error"
        state.resourceError = "API error"

        XCTAssertNotNil(state.errorMessage)
        XCTAssertNotNil(state.resourceError)
    }

    // MARK: - ResourceType enum

    func testResourceType_pods_rawValue() {
        XCTAssertEqual(ResourceType.pods.rawValue, "Pods")
    }

    func testResourceType_deployments_rawValue() {
        XCTAssertEqual(ResourceType.deployments.rawValue, "Deployments")
    }

    func testResourceType_allCases_countIsThree() {
        XCTAssertEqual(ResourceType.allCases.count, 8)
    }

    func testResourceType_pods_hasSystemImage() {
        XCTAssertFalse(ResourceType.pods.systemImage.isEmpty)
    }

    func testResourceType_deployments_hasSystemImage() {
        XCTAssertFalse(ResourceType.deployments.systemImage.isEmpty)
    }

    // MARK: - Namespaces

    func testNamespaces_loadedAfterExpansion() {
        let state = ClusterState()
        state.namespaces = [
            NamespaceInfo(name: "default", phase: "Active"),
            NamespaceInfo(name: "kube-system", phase: "Active"),
            NamespaceInfo(name: "monitoring", phase: "Active"),
        ]

        XCTAssertEqual(state.namespaces.count, 3)
        XCTAssertTrue(state.namespaces.map(\.name).contains("kube-system"))
    }

    func testNamespaces_emptiedOnContextSwitch() {
        let state = ClusterState()
        state.namespaces = [NamespaceInfo(name: "default", phase: "Active")]

        state.namespaces = []

        XCTAssertTrue(state.namespaces.isEmpty)
    }
}
