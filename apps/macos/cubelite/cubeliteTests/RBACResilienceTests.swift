import XCTest

@testable import cubelite

// MARK: - RBAC Resilience Tests
//
// Tests for Issue #73: RBAC-resilient resource loading.
//   - ClusterState.forbiddenResources tracking
//   - ClusterHealthSnapshot.isRBACLimited
//   - CrossClusterState.limitedClusters aggregation
//   - AppSettings.contextNamespaces persistence

// MARK: - ClusterState Forbidden Resources

@MainActor
final class ClusterStateForbiddenResourcesTests: XCTestCase {

    func testInitialState_forbiddenResourcesIsEmpty() {
        let sut = ClusterState()
        XCTAssertTrue(sut.forbiddenResources.isEmpty)
    }

    func testForbiddenResources_insertSingleResource() {
        let sut = ClusterState()
        sut.forbiddenResources.insert("secrets")
        XCTAssertTrue(sut.forbiddenResources.contains("secrets"))
        XCTAssertEqual(sut.forbiddenResources.count, 1)
    }

    func testForbiddenResources_insertMultipleResources() {
        let sut = ClusterState()
        sut.forbiddenResources.insert("secrets")
        sut.forbiddenResources.insert("configmaps")
        sut.forbiddenResources.insert("ingresses")
        XCTAssertEqual(sut.forbiddenResources.count, 3)
        XCTAssertTrue(sut.forbiddenResources.contains("secrets"))
        XCTAssertTrue(sut.forbiddenResources.contains("configmaps"))
        XCTAssertTrue(sut.forbiddenResources.contains("ingresses"))
    }

    func testForbiddenResources_duplicateInsertIsIdempotent() {
        let sut = ClusterState()
        sut.forbiddenResources.insert("pods")
        sut.forbiddenResources.insert("pods")
        XCTAssertEqual(sut.forbiddenResources.count, 1)
    }

    func testForbiddenResources_clearResetsToEmpty() {
        let sut = ClusterState()
        sut.forbiddenResources.insert("secrets")
        sut.forbiddenResources.insert("pods")
        sut.forbiddenResources = []
        XCTAssertTrue(sut.forbiddenResources.isEmpty)
    }
}

// MARK: - ClusterHealthSnapshot RBAC

final class ClusterHealthSnapshotRBACTests: XCTestCase {

    private func makeSnapshot(
        forbidden: [String] = [],
        reachable: Bool = true
    ) -> ClusterHealthSnapshot {
        ClusterHealthSnapshot(
            contextName: "test-cluster",
            isReachable: reachable,
            error: nil,
            totalPods: 5,
            runningPods: 5,
            failedPods: 0,
            totalDeployments: 2,
            healthyDeployments: 2,
            degradedDeployments: 0,
            totalServices: 1,
            totalNamespaces: 3,
            totalRestarts: 0,
            notReadyPods: 0,
            forbiddenResources: forbidden
        )
    }

    func testIsRBACLimited_noForbiddenResources_returnsFalse() {
        let sut = makeSnapshot(forbidden: [])
        XCTAssertFalse(sut.isRBACLimited)
    }

    func testIsRBACLimited_withForbiddenResources_returnsTrue() {
        let sut = makeSnapshot(forbidden: ["secrets", "configmaps"])
        XCTAssertTrue(sut.isRBACLimited)
    }

    func testIsRBACLimited_singleForbiddenResource_returnsTrue() {
        let sut = makeSnapshot(forbidden: ["helmreleases"])
        XCTAssertTrue(sut.isRBACLimited)
    }
}

// MARK: - CrossClusterState Limited Clusters

@MainActor
final class CrossClusterStateLimitedClustersTests: XCTestCase {

    private func makeSnapshot(
        name: String,
        reachable: Bool = true,
        forbidden: [String] = []
    ) -> ClusterHealthSnapshot {
        ClusterHealthSnapshot(
            contextName: name,
            isReachable: reachable,
            error: reachable ? nil : "unreachable",
            totalPods: 3,
            runningPods: 3,
            failedPods: 0,
            totalDeployments: 1,
            healthyDeployments: 1,
            degradedDeployments: 0,
            totalServices: 1,
            totalNamespaces: 2,
            totalRestarts: 0,
            notReadyPods: 0,
            forbiddenResources: forbidden
        )
    }

    func testLimitedClusters_noClusters_returnsZero() {
        let sut = CrossClusterState()
        XCTAssertEqual(sut.limitedClusters, 0)
    }

    func testLimitedClusters_allFullAccess_returnsZero() {
        let sut = CrossClusterState()
        sut.snapshots = [
            makeSnapshot(name: "prod"),
            makeSnapshot(name: "staging"),
        ]
        XCTAssertEqual(sut.limitedClusters, 0)
    }

    func testLimitedClusters_oneReachableLimited_returnsOne() {
        let sut = CrossClusterState()
        sut.snapshots = [
            makeSnapshot(name: "prod"),
            makeSnapshot(name: "staging", forbidden: ["secrets"]),
        ]
        XCTAssertEqual(sut.limitedClusters, 1)
    }

    func testLimitedClusters_unreachableLimited_notCounted() {
        let sut = CrossClusterState()
        sut.snapshots = [
            makeSnapshot(name: "prod"),
            makeSnapshot(name: "staging", reachable: false, forbidden: ["secrets"]),
        ]
        XCTAssertEqual(sut.limitedClusters, 0)
    }

    func testLimitedClusters_allLimited_returnsAll() {
        let sut = CrossClusterState()
        sut.snapshots = [
            makeSnapshot(name: "prod", forbidden: ["secrets"]),
            makeSnapshot(name: "staging", forbidden: ["configmaps", "ingresses"]),
            makeSnapshot(name: "dev", forbidden: ["helmreleases"]),
        ]
        XCTAssertEqual(sut.limitedClusters, 3)
    }

    func testLimitedClusters_mixedStates() {
        let sut = CrossClusterState()
        sut.snapshots = [
            makeSnapshot(name: "prod"),                                             // full access
            makeSnapshot(name: "staging", forbidden: ["secrets"]),                  // limited
            makeSnapshot(name: "dev", reachable: false),                            // offline
            makeSnapshot(name: "test", reachable: false, forbidden: ["pods"]),      // offline+limited
        ]
        XCTAssertEqual(sut.limitedClusters, 1)
        XCTAssertEqual(sut.onlineClusters, 2)
        XCTAssertEqual(sut.offlineClusters, 2)
    }
}

// MARK: - AppSettings Context Namespaces

@MainActor
final class AppSettingsContextNamespacesTests: XCTestCase {

    private let testKey = "contextNamespaces"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: testKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: testKey)
        super.tearDown()
    }

    func testContextNamespaces_defaultIsEmpty() {
        let sut = AppSettings()
        XCTAssertTrue(sut.contextNamespaces.isEmpty)
    }

    func testContextNamespaces_setAndPersist() {
        let sut = AppSettings()
        sut.contextNamespaces["rancher-prod"] = ["default", "monitoring"]

        // Re-read from UserDefaults via a fresh instance
        let reloaded = AppSettings()
        XCTAssertEqual(reloaded.contextNamespaces["rancher-prod"], ["default", "monitoring"])
    }

    func testContextNamespaces_multipleContexts() {
        let sut = AppSettings()
        sut.contextNamespaces["prod"] = ["default"]
        sut.contextNamespaces["staging"] = ["default", "kube-system"]

        let reloaded = AppSettings()
        XCTAssertEqual(reloaded.contextNamespaces.count, 2)
        XCTAssertEqual(reloaded.contextNamespaces["prod"], ["default"])
        XCTAssertEqual(reloaded.contextNamespaces["staging"], ["default", "kube-system"])
    }

    func testContextNamespaces_overwriteExisting() {
        let sut = AppSettings()
        sut.contextNamespaces["prod"] = ["default"]
        sut.contextNamespaces["prod"] = ["monitoring", "app"]

        let reloaded = AppSettings()
        XCTAssertEqual(reloaded.contextNamespaces["prod"], ["monitoring", "app"])
    }

    func testContextNamespaces_removeContext() {
        let sut = AppSettings()
        sut.contextNamespaces["prod"] = ["default"]
        sut.contextNamespaces["prod"] = nil

        let reloaded = AppSettings()
        XCTAssertNil(reloaded.contextNamespaces["prod"])
    }
}

// MARK: - AppSettings Skip TLS Verification Persistence

@MainActor
final class AppSettingsSkipTLSTests: XCTestCase {

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: AppSettings.Keys.skipTLSVerification)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: AppSettings.Keys.skipTLSVerification)
        super.tearDown()
    }

    func testSkipTLS_defaultIsFalse() {
        let sut = AppSettings()
        XCTAssertFalse(sut.skipTLSVerification)
    }

    func testSkipTLS_enablePersistsAcrossInstances() {
        let sut = AppSettings()
        sut.skipTLSVerification = true

        let reloaded = AppSettings()
        XCTAssertTrue(reloaded.skipTLSVerification, "skipTLSVerification must survive a fresh AppSettings init")
    }

    func testSkipTLS_disablePersistsAcrossInstances() {
        let sut = AppSettings()
        sut.skipTLSVerification = true
        sut.skipTLSVerification = false

        let reloaded = AppSettings()
        XCTAssertFalse(reloaded.skipTLSVerification)
    }

    func testSkipTLS_userDefaultsRawValue_matchesProperty() {
        let sut = AppSettings()
        sut.skipTLSVerification = true

        let raw = UserDefaults.standard.bool(forKey: AppSettings.Keys.skipTLSVerification)
        XCTAssertTrue(raw, "UserDefaults must contain the updated value")
    }
}
