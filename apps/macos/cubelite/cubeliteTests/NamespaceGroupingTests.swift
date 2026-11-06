import XCTest

@testable import cubelite

// MARK: - Group by namespace (#551)
//
// Rules of docs/superpowers/specs/2026-11-06-namespace-grouping-design.md
// §4: ordering, problem marker, collapse state, where grouping applies.

final class NamespaceGroupingTests: XCTestCase {

    private func pod(_ name: String, ns: String, phase: String = "Running", ready: Bool = true)
        -> PodInfo
    {
        PodInfo(name: name, namespace: ns, phase: phase, ready: ready, restarts: 0, creationTimestamp: nil)
    }

    private lazy var pods = [
        pod("web-2", ns: "team-b"),
        pod("api-10", ns: "team-a", phase: "Failed"),
        pod("db", ns: "kube-system"),
        pod("api-2", ns: "team-a", phase: "Pending"),
        pod("worker", ns: "team-a", ready: false),
        pod("web-1", ns: "team-b"),
    ]

    private func shape(_ groups: [NamespaceGroup<PodInfo>]) -> [String] {
        groups.map { "\($0.namespace): \($0.rows.map(\.name).joined(separator: " "))" }
    }

    func testGroupsAToZWithRowsInTheCurrentSort() {
        let groups = ListSort.groupedByNamespace(pods, by: SortSpec(field: .name, ascending: false))
        XCTAssertEqual(
            shape(groups),
            ["kube-system: db", "team-a: worker api-10 api-2", "team-b: web-2 web-1"])
    }

    func testAPIOrderKeepsAPIOrderInsideGroups() {
        XCTAssertEqual(
            shape(ListSort.groupedByNamespace(pods, by: .api)),
            ["kube-system: db", "team-a: api-10 api-2 worker", "team-b: web-2 web-1"])
    }

    func testNamespaceSortOrdersGroupsAndSortsRowsByName() {
        XCTAssertEqual(
            shape(ListSort.groupedByNamespace(pods, by: SortSpec(field: .namespace, ascending: false))),
            ["team-b: web-1 web-2", "team-a: api-2 api-10 worker", "kube-system: db"])
        XCTAssertEqual(
            shape(ListSort.groupedByNamespace(pods, by: SortSpec(field: .namespace, ascending: true))),
            ["kube-system: db", "team-a: api-2 api-10 worker", "team-b: web-1 web-2"])
    }

    func testProblemMarkerIsWorstToneAndCountOfRowsNotOk() {
        let rows = [
            pod("pending", ns: "a", phase: "Pending"),  // warn, before the worst
            pod("ok", ns: "a"),
            pod("failed", ns: "a", phase: "Failed"),  // err
            pod("unknown", ns: "a", phase: "Unknown"),  // neutral counts as not ok
            pod("fine", ns: "b"),
        ]
        let groups = ListSort.groupedByNamespace(rows, by: .api)
        XCTAssertEqual(groups.first?.count, 4)
        XCTAssertEqual(groups.first?.problems, 3)
        XCTAssertEqual(groups.first?.worst, .err)
        XCTAssertEqual(groups.last?.problems, 0)
        XCTAssertNil(groups.last?.worst, "all ok: no marker")

        let neutralOnly = ListSort.groupedByNamespace([pod("x", ns: "c", phase: "Unknown")], by: .api)
        XCTAssertEqual(neutralOnly.first?.worst, .neutral)
        XCTAssertEqual(neutralOnly.first?.problems, 1)
    }

    func testListsWithoutStatusHaveNoMarker() {
        let maps = [
            ConfigMapInfo(name: "a", namespace: "x", dataCount: 1, creationTimestamp: nil),
            ConfigMapInfo(name: "b", namespace: "x", dataCount: 1, creationTimestamp: nil),
        ]
        let groups = ListSort.groupedByNamespace(maps, by: .api)
        XCTAssertEqual(groups.map(\.count), [2])
        XCTAssertEqual(groups.first?.problems, 0)
        XCTAssertNil(groups.first?.worst)
    }

    func testEmptyListHasNoGroups() {
        XCTAssertTrue(ListSort.groupedByNamespace([PodInfo](), by: .api).isEmpty)
    }

    func testAccessibleNameOfTheHeader() {
        let groups = ListSort.groupedByNamespace(pods, by: .api)
        let noun = ResourceType.pods.groupNoun!
        XCTAssertEqual(
            groups[1].accessibilityLabel(noun: noun, expanded: true),
            "team-a, 3 pods, 3 with problems, expanded")
        XCTAssertEqual(
            groups[0].accessibilityLabel(noun: noun, expanded: false), "kube-system, 1 pod, collapsed")
        let single = ListSort.groupedByNamespace([pod("x", ns: "n", phase: "Failed")], by: .api)
        XCTAssertEqual(
            single[0].accessibilityLabel(noun: noun, expanded: true),
            "n, 1 pod, 1 with problems, expanded", "as the desktop: no singular for problems")
    }

    func testNounsMatchTheDesktop() {
        let nouns = ResourceType.allCases.compactMap { type in type.groupNoun.map { (type, $0) } }
        let expected: [ResourceType: (String, String)] = [
            .pods: ("pod", "pods"), .deployments: ("deployment", "deployments"),
            .statefulSets: ("stateful set", "stateful sets"), .jobs: ("job", "jobs"),
            .cronJobs: ("cron job", "cron jobs"), .services: ("service", "services"),
            .ingresses: ("ingress", "ingresses"), .configMaps: ("config map", "config maps"),
            .secrets: ("secret", "secrets"),
            .pvcs: ("persistent volume claim", "persistent volume claims"),
            .helmReleases: ("Helm release", "Helm releases"),
        ]
        XCTAssertEqual(nouns.count, expected.count)
        for (type, noun) in nouns {
            XCTAssertEqual(noun.singular, expected[type]?.0, "\(type)")
            XCTAssertEqual(noun.plural, expected[type]?.1, "\(type)")
        }
    }

    func testNamespaceColumnOnlyWhenFlat() {
        XCTAssertTrue(ListLayout<PodInfo>.flat(pods).showsNamespaceColumn)
        XCTAssertFalse(
            ListLayout.grouped(ListSort.groupedByNamespace(pods, by: .api)).showsNamespaceColumn)
    }

    func testKeysActOnTheSelectedRowsGroup() {
        let grouped = ListLayout.grouped(ListSort.groupedByNamespace(pods, by: .api))
        XCTAssertEqual(grouped.namespace(ofRow: "team-a/worker"), "team-a")
        XCTAssertEqual(grouped.namespace(ofRow: "kube-system/db"), "kube-system")
        XCTAssertNil(grouped.namespace(ofRow: nil), "no selection: keys pass through")
        XCTAssertNil(grouped.namespace(ofRow: "gone/x"))
        XCTAssertNil(ListLayout.flat(pods).namespace(ofRow: "team-a/worker"), "flat: keys pass through")
    }

    func testGroupingAppliesToTheNamespacedListsOnly() {
        let grouped: Set<ResourceType> = [
            .pods, .deployments, .statefulSets, .jobs, .cronJobs, .services, .ingresses,
            .configMaps, .secrets, .pvcs, .helmReleases,
        ]
        XCTAssertEqual(Set(ResourceType.allCases.filter(\.groupsByNamespace)), grouped)
    }

    @MainActor
    func testToolbarToggleOnlyWithAllNamespacesOnANamespacedList() {
        XCTAssertTrue(GroupByNamespaceToggle.isShown(for: .pods, namespace: nil))
        XCTAssertFalse(GroupByNamespaceToggle.isShown(for: .pods, namespace: "team-a"))
        XCTAssertFalse(GroupByNamespaceToggle.isShown(for: .nodes, namespace: nil))
        XCTAssertFalse(GroupByNamespaceToggle.isShown(for: .events, namespace: nil))
        XCTAssertFalse(GroupByNamespaceToggle.isShown(for: nil, namespace: nil))
    }
}

@MainActor
final class NamespaceGroupingPreferencesTests: XCTestCase {

    /// Fresh per test: XCTest makes one instance per test method.
    private lazy var defaults = TestDefaults.fresh(for: Self.self)

    private let pods = [
        PodInfo(name: "b", namespace: "y", phase: "Running", ready: true, restarts: 0, creationTimestamp: nil),
        PodInfo(name: "a", namespace: "x", phase: "Running", ready: true, restarts: 0, creationTimestamp: nil),
    ]

    func testOffByDefaultAndPersisted() {
        let prefs = ResourcePreferences(defaults: defaults)
        XCTAssertFalse(prefs.groupByNamespace)
        prefs.groupByNamespace = true
        XCTAssertTrue(ResourcePreferences(defaults: defaults).groupByNamespace)
    }

    func testLayoutIsFlatUnlessGroupingAppliesAndUsesTheListSort() {
        let prefs = ResourcePreferences(defaults: defaults)
        prefs.defaultSort = SortSpec(field: .name, ascending: true)
        guard case .flat(let off) = prefs.layout(pods, for: .pods, namespace: nil) else {
            return XCTFail("off: flat")
        }
        XCTAssertEqual(off.map(\.name), ["a", "b"])

        prefs.groupByNamespace = true
        XCTAssertFalse(prefs.layout(pods, for: .pods, namespace: "x").isGrouped, "one namespace: flat")
        XCTAssertFalse(prefs.isGrouping(.nodes, namespace: nil), "cluster-scoped: flat")
        guard case .grouped(let groups) = prefs.layout(pods, for: .pods, namespace: nil) else {
            return XCTFail("all namespaces: grouped")
        }
        XCTAssertEqual(groups.map(\.namespace), ["x", "y"])

        prefs.setOverride(SortSpec(field: .namespace, ascending: false), for: "pods")
        guard case .grouped(let reversed) = prefs.layout(pods, for: .pods, namespace: nil) else {
            return XCTFail("grouped")
        }
        XCTAssertEqual(reversed.map(\.namespace), ["y", "x"], "the header sort applies")
    }

    func testCollapseByNameSharedAcrossListsAndResetWithTheSession() {
        let prefs = ResourcePreferences(defaults: defaults)
        XCTAssertFalse(prefs.isCollapsed("kube-system"), "new namespaces show expanded")
        prefs.toggleCollapsed("kube-system")
        XCTAssertTrue(prefs.isCollapsed("kube-system"))
        prefs.toggleCollapsed("kube-system")
        XCTAssertFalse(prefs.isCollapsed("kube-system"))

        prefs.toggleCollapsed("kube-system")
        prefs.resetSession()
        XCTAssertFalse(prefs.isCollapsed("kube-system"), "cluster switch expands again")
        XCTAssertFalse(
            ResourcePreferences(defaults: defaults).isCollapsed("kube-system"), "not persisted")
    }

    func testOptionClickSetsEveryGroupToTheClickedGroupsNewState() {
        let prefs = ResourcePreferences(defaults: defaults)
        let all = ["a", "b", "c"]
        prefs.toggleCollapsed("b")
        prefs.toggleCollapsed("a", all: all)
        XCTAssertEqual(prefs.collapsedNamespaces, ["a", "b", "c"], "a was expanded: collapse all")
        prefs.toggleCollapsed("c", all: all)
        XCTAssertTrue(prefs.collapsedNamespaces.isEmpty, "c was collapsed: expand all")
    }

    func testKeySetsTheStateRatherThanToggling() {
        let prefs = ResourcePreferences(defaults: defaults)
        prefs.setCollapsed("a", true)
        prefs.setCollapsed("a", true)
        XCTAssertTrue(prefs.isCollapsed("a"), "← twice stays collapsed")
        prefs.setCollapsed("a", false)
        XCTAssertFalse(prefs.isCollapsed("a"))
    }
}
