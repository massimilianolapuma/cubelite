import SwiftUI
import XCTest

@testable import cubelite

// MARK: - Resource order and list sort (#497)
//
// Same vectors as the desktop `navigation.test.ts` / `list-sort.test.ts`
// (spec docs/superpowers/specs/2026-11-03-resource-order-design.md).

final class NavPrefsTests: XCTestCase {

    private func visible(_ prefs: NavPrefs) -> [String] { prefs.visibleTypes.map(\.navID) }

    func testNormalize_brokenStorageGivesDefaults() {
        XCTAssertEqual(NavPrefs(sections: [], order: [], hidden: []).normalized(), .defaults)
        XCTAssertEqual(NavPrefs.defaults.normalized(), .defaults)
    }

    func testNormalize_dropsUnknownAndInsertsNewAfterDefaultPredecessor() {
        let prefs = NavPrefs(
            sections: ["observe", "gone", "workloads"],
            order: ["deployments", "pods", "nope", "logs", "events"],
            hidden: ["nope", "helm"]
        ).normalized()
        XCTAssertEqual(prefs.sections, ["cluster", "observe", "workloads", "network", "config"])
        XCTAssertEqual(prefs.hidden, ["helm"])
        let workloads = prefs.arranged.first { $0.section == .workloads }!.types.map(\.navID)
        XCTAssertEqual(workloads, ["deployments", "statefulsets", "jobs", "cronjobs", "helm", "pods"])
        let observe = prefs.arranged.first { $0.section == .observe }!.types.map(\.navID)
        XCTAssertEqual(observe, ["logs", "events"])
    }

    func testNormalize_pinsClusterAndOverview() {
        let prefs = NavPrefs(
            sections: ["observe", "cluster"], order: ["nodes", "overview"], hidden: ["overview"]
        ).normalized()
        XCTAssertEqual(prefs.sections.first, "cluster")
        XCTAssertEqual(Array(visible(prefs).prefix(2)), ["overview", "nodes"])
        XCTAssertFalse(prefs.hidden.contains("overview"))
    }

    func testNormalize_keepsOneTypeBesidesOverviewVisible() {
        let all = NavPrefs.defaults.order.filter { $0 != "overview" }
        XCTAssertEqual(NavPrefs(sections: [], order: [], hidden: all).normalized().hidden.count, all.count - 1)
    }

    func testMoveType_withinSectionOnly() {
        let moved = NavPrefs.defaults.movingType(.deployments, by: -1)
        let workloads = moved.arranged.first { $0.section == .workloads }!.types
        XCTAssertEqual(workloads.prefix(2), [.deployments, .pods])
        XCTAssertEqual(moved.movingType(.deployments, by: -1), moved)
        XCTAssertEqual(NavPrefs.defaults.movingType(.nodes, by: -1), .defaults)
        XCTAssertEqual(NavPrefs.defaults.movingType(.dashboard, by: 1), .defaults)
    }

    func testMoveSection_neverAboveOrMovingCluster() {
        XCTAssertEqual(
            NavPrefs.defaults.movingSection(.observe, by: -1).sections,
            ["cluster", "workloads", "network", "observe", "config"])
        XCTAssertEqual(NavPrefs.defaults.movingSection(.workloads, by: -1), .defaults)
        XCTAssertEqual(NavPrefs.defaults.movingSection(.cluster, by: 1), .defaults)
        XCTAssertEqual(NavPrefs.defaults.movingSection(.observe, by: 1), .defaults)
    }

    func testHide_removesFromVisibleAndRefusesOverview() {
        let prefs = NavPrefs.defaults.settingHidden(.services, true).settingHidden(.ingresses, true)
        XCTAssertFalse(visible(prefs).contains("services"))
        XCTAssertEqual(prefs.settingHidden(.dashboard, true), prefs)
        XCTAssertFalse(prefs.canHide(.dashboard))
        XCTAssertTrue(visible(prefs.settingHidden(.services, false)).contains("services"))
    }
}

final class ListSortTests: XCTestCase {

    private func pod(_ name: String, ns: String, created: String?, phase: String, restarts: Int = 0)
        -> PodInfo
    {
        PodInfo(
            name: name, namespace: ns, phase: phase, ready: true, restarts: restarts,
            creationTimestamp: created)
    }

    private lazy var rows = [
        pod("pod-10", ns: "b", created: "2026-11-01T00:00:00Z", phase: "Running", restarts: 1),
        pod("pod-2", ns: "a", created: "2026-11-03T00:00:00Z", phase: "Failed", restarts: 5),
        pod("Pod-1", ns: "b", created: nil, phase: "Pending", restarts: 0),
        pod("pod-3", ns: "a", created: "2026-11-02T00:00:00.5Z", phase: "Running", restarts: 5),
    ]

    private func names(_ field: SortField, _ ascending: Bool = true) -> [String] {
        ListSort.sorted(rows, by: SortSpec(field: field, ascending: ascending)).map(\.name)
    }

    func testAPIOrderUnchanged() {
        XCTAssertEqual(names(.api, false), ["pod-10", "pod-2", "Pod-1", "pod-3"])
    }

    func testNaturalCaseInsensitiveNames() {
        XCTAssertEqual(names(.name), ["Pod-1", "pod-2", "pod-3", "pod-10"])
        XCTAssertEqual(names(.name, false), ["pod-10", "pod-3", "pod-2", "Pod-1"])
    }

    func testNamespaceThenName() {
        XCTAssertEqual(names(.namespace), ["pod-2", "pod-3", "Pod-1", "pod-10"])
    }

    func testAgeNewestFirstMissingLast() {
        XCTAssertEqual(names(.age), ["pod-2", "pod-3", "pod-10", "Pod-1"])
    }

    func testStatusProblemsFirst() {
        XCTAssertEqual(names(.status), ["pod-2", "Pod-1", "pod-3", "pod-10"])
    }

    func testRestartsWithNameTieBreak() {
        XCTAssertEqual(names(.restarts, false), ["pod-3", "pod-2", "pod-10", "Pod-1"])
    }

    func testMissingFieldFallsBackToName() {
        let nodes = [
            NodeInfo.fixture(name: "node-10"), NodeInfo.fixture(name: "node-2"),
        ]
        XCTAssertEqual(
            ListSort.sorted(nodes, by: SortSpec(field: .restarts, ascending: true)).map(\.name),
            ["node-2", "node-10"])
    }

    func testStableTies() {
        let same = [pod("x", ns: "a", created: nil, phase: "Running"), pod("x", ns: "b", created: nil, phase: "Running")]
        XCTAssertEqual(
            ListSort.sorted(same, by: SortSpec(field: .name, ascending: false)).map(\.namespace), ["a", "b"])
    }
}

@MainActor
final class ResourcePreferencesStoreTests: XCTestCase {

    nonisolated private static let suite = "ResourcePreferencesStoreTests"
    private let defaults = UserDefaults(suiteName: ResourcePreferencesStoreTests.suite)!

    override func setUp() {
        super.setUp()
        UserDefaults(suiteName: Self.suite)?.removePersistentDomain(forName: Self.suite)
    }

    override func tearDown() {
        UserDefaults(suiteName: Self.suite)?.removePersistentDomain(forName: Self.suite)
        super.tearDown()
    }

    func testPersistsNavigationAndSort() {
        let prefs = ResourcePreferences(defaults: defaults)
        XCTAssertEqual(prefs.defaultSort, .api)
        prefs.setHidden(.helmReleases, true)
        prefs.moveType(.deployments, by: -1)
        prefs.defaultSort = SortSpec(field: .age, ascending: false)

        let reopened = ResourcePreferences(defaults: defaults)
        XCTAssertTrue(reopened.navigation.isHidden(.helmReleases))
        XCTAssertEqual(reopened.visibleTypes.firstIndex(of: .deployments)! < reopened.visibleTypes.firstIndex(of: .pods)!, true)
        XCTAssertEqual(reopened.defaultSort, SortSpec(field: .age, ascending: false))

        reopened.resetNavigation()
        XCTAssertEqual(reopened.navigation, .defaults)
        XCTAssertNil(defaults.data(forKey: ResourcePreferences.navigationKey))
    }

    func testHeaderBindingMapsColumnsToSessionOverrides() {
        let prefs = ResourcePreferences(defaults: defaults)
        let binding = prefs.sortOrder(for: "pods", of: PodInfo.self)
        XCTAssertTrue(binding.wrappedValue.isEmpty, "API order shows no indicator")

        // What a click on a `TableColumn("Age", value: \.sortKeyAge)` header sets.
        binding.wrappedValue = [KeyPathComparator(\PodInfo.sortKeyAge, order: .reverse)]
        XCTAssertEqual(prefs.spec(for: "pods"), SortSpec(field: .age, ascending: false))
        XCTAssertEqual(prefs.spec(for: "services"), .api, "overrides are per list")
        XCTAssertEqual(binding.wrappedValue.first?.order, .reverse)

        binding.wrappedValue = [KeyPathComparator(\PodInfo.sortKeyRestarts, order: .forward)]
        XCTAssertEqual(prefs.spec(for: "pods"), SortSpec(field: .restarts, ascending: true))

        prefs.resetSession()
        XCTAssertEqual(prefs.spec(for: "pods"), .api)
    }
}

extension NodeInfo {
    fileprivate static func fixture(name: String) -> NodeInfo {
        NodeInfo(name: name, status: "Ready", roles: [], version: nil, creationTimestamp: nil)
    }
}
