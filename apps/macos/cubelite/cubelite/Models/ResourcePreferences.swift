import Foundation
import Observation
import SwiftUI

// Resource-type order/visibility and the default list sort (#497; same
// rules as the desktop `navigation.ts` / `list-sort.ts`, spec
// docs/superpowers/specs/2026-11-03-resource-order-design.md).

// MARK: - Navigation

extension ResourceType {
    /// Stable id shared with the desktop app's view ids.
    var navID: String {
        switch self {
        case .dashboard: "overview"
        case .pods: "pods"
        case .deployments: "deployments"
        case .services: "services"
        case .secrets: "secrets"
        case .configMaps: "configmaps"
        case .ingresses: "ingresses"
        case .helmReleases: "helm"
        case .statefulSets: "statefulsets"
        case .jobs: "jobs"
        case .cronJobs: "cronjobs"
        case .pvcs: "pvcs"
        case .nodes: "nodes"
        case .events: "events"
        case .logs: "logs"
        }
    }
}

/// Navigation groups, as the desktop sidebar sections.
enum NavSection: String, CaseIterable, Identifiable, Sendable {
    case cluster, workloads, network, config, observe

    var id: String { rawValue }

    var label: String {
        switch self {
        case .cluster: "Cluster"
        case .workloads: "Workloads"
        case .network: "Network"
        case .config: "Config"
        case .observe: "Observe"
        }
    }

    /// Default members, in default order.
    var types: [ResourceType] {
        switch self {
        case .cluster: [.dashboard, .nodes]
        case .workloads: [.pods, .deployments, .statefulSets, .jobs, .cronJobs, .helmReleases]
        case .network: [.services, .ingresses]
        case .config: [.configMaps, .secrets, .pvcs]
        case .observe: [.events, .logs]
        }
    }
}

/// Stored navigation preferences (ids, so unknown/new types survive releases).
struct NavPrefs: Codable, Equatable, Sendable {
    var sections: [String]
    var order: [String]
    var hidden: [String]

    static let pinnedType = ResourceType.dashboard
    static let pinnedSection = NavSection.cluster

    static let defaults = NavPrefs(
        sections: NavSection.allCases.map(\.rawValue),
        order: NavSection.allCases.flatMap(\.types).map(\.navID),
        hidden: [])

    private static let allIDs = NavSection.allCases.flatMap(\.types).map(\.navID)

    /// Keeps known ids once, then inserts missing defaults after their default predecessor.
    private static func merge(_ stored: [String], defaults: [String]) -> [String] {
        var out: [String] = []
        for id in stored where defaults.contains(id) && !out.contains(id) { out.append(id) }
        for (i, id) in defaults.enumerated() where !out.contains(id) {
            let before = i == 0 ? -1 : (out.firstIndex(of: defaults[i - 1]) ?? -1)
            out.insert(id, at: before + 1)
        }
        return out
    }

    /// Repairs stored preferences: unknown ids dropped, new ids at their default
    /// place, Cluster first, Overview first and visible, one other type visible.
    func normalized() -> NavPrefs {
        let pinnedSection = Self.pinnedSection.rawValue
        let pinned = Self.pinnedType.navID
        let sections =
            [pinnedSection]
            + Self.merge(self.sections, defaults: NavSection.allCases.map(\.rawValue))
            .filter { $0 != pinnedSection }
        var order: [String] = []
        for section in NavSection.allCases {
            let own = section.types.map(\.navID)
            var items = Self.merge(self.order.filter { own.contains($0) }, defaults: own)
                .filter { $0 != pinned }
            if own.contains(pinned) { items.insert(pinned, at: 0) }
            order += items
        }
        var hidden: [String] = []
        for id in self.hidden where Self.allIDs.contains(id) && id != pinned && !hidden.contains(id) {
            hidden.append(id)
        }
        if Self.allIDs.allSatisfy({ $0 == pinned || hidden.contains($0) }) { hidden.removeLast() }
        return NavPrefs(sections: sections, order: order, hidden: hidden)
    }

    /// Sections in the user's order with every type (hidden included).
    var arranged: [(section: NavSection, types: [ResourceType])] {
        sections.compactMap(NavSection.init(rawValue:)).map { section in
            let members = section.types
            return (section, order.compactMap { id in members.first { $0.navID == id } })
        }
    }

    /// The resource-type column: visible types, flattened in section order.
    var visibleTypes: [ResourceType] {
        arranged.flatMap(\.types).filter { !hidden.contains($0.navID) }
    }

    func isHidden(_ type: ResourceType) -> Bool { hidden.contains(type.navID) }

    func canHide(_ type: ResourceType) -> Bool {
        let pinned = Self.pinnedType.navID
        guard type != Self.pinnedType, !isHidden(type) else { return false }
        return Self.allIDs.contains { $0 != pinned && $0 != type.navID && !hidden.contains($0) }
    }

    func settingHidden(_ type: ResourceType, _ hide: Bool) -> NavPrefs {
        var copy = self
        if hide {
            guard canHide(type) else { return self }
            copy.hidden.append(type.navID)
        } else {
            copy.hidden.removeAll { $0 == type.navID }
        }
        return copy
    }

    /// Moves a section up (-1) or down (+1); Cluster never moves and stays first.
    func movingSection(_ section: NavSection, by delta: Int) -> NavPrefs {
        guard section != Self.pinnedSection, let i = sections.firstIndex(of: section.rawValue)
        else { return self }
        let j = i + delta
        guard j >= 1, j < sections.count else { return self }
        var copy = self
        copy.sections.swapAt(i, j)
        return copy
    }

    /// Moves a type within its section; Overview stays first in Cluster.
    func movingType(_ type: ResourceType, by delta: Int) -> NavPrefs {
        guard type != Self.pinnedType,
            let section = NavSection.allCases.first(where: { $0.types.contains(type) })
        else { return self }
        let siblings = order.filter { id in section.types.contains { $0.navID == id } }
        guard let k = siblings.firstIndex(of: type.navID), siblings.indices.contains(k + delta)
        else { return self }
        let target = siblings[k + delta]
        guard target != Self.pinnedType.navID,
            let a = order.firstIndex(of: type.navID), let b = order.firstIndex(of: target)
        else { return self }
        var copy = self
        copy.order.swapAt(a, b)
        return copy
    }
}

// MARK: - List sort

enum SortField: String, CaseIterable, Codable, Sendable {
    case api, name, namespace, age, status, restarts

    var label: String {
        switch self {
        case .api: "API order"
        case .name: "Name"
        case .namespace: "Namespace"
        case .age: "Age"
        case .status: "Status"
        case .restarts: "Restarts"
        }
    }

    /// Direction a header click starts with (restarts: most first).
    var firstAscending: Bool { self != .restarts }
}

struct SortSpec: Codable, Equatable, Sendable {
    var field: SortField
    var ascending: Bool

    static let api = SortSpec(field: .api, ascending: true)
}

/// Status ranking for the Status sort: problems first.
enum StatusTone: Int, Sendable {
    case err = 0, warn, neutral, ok
}

/// Row constraint for the native sort binding: Swift 6.2 needs a sendable
/// metatype to use `T` inside the binding's closures; older compilers (CI)
/// have no `SendableMetatype`.
#if compiler(>=6.2)
    typealias SortableRow = SortableResource & SendableMetatype
#else
    typealias SortableRow = SortableResource
#endif

/// What a resource row exposes to the sort; nil means the list lacks the field.
protocol SortableResource {
    var name: String { get }
    var sortNamespace: String? { get }
    var sortCreated: String? { get }
    var sortStatus: StatusTone? { get }
    var sortRestarts: Int? { get }
}

extension SortableResource {
    var sortNamespace: String? { nil }
    var sortStatus: StatusTone? { nil }
    var sortRestarts: Int? { nil }

    // Comparable keys for native `Table` sort indicators (the order itself
    // comes from `ListSort.sorted`).
    var sortKeyName: String { name }
    var sortKeyNamespace: String { sortNamespace ?? "" }
    var sortKeyAge: Double { ListSort.time(sortCreated) }
    var sortKeyStatus: Int { sortStatus?.rawValue ?? 0 }
    var sortKeyRestarts: Int { sortRestarts ?? 0 }
}

enum ListSort {

    nonisolated(unsafe) private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    nonisolated(unsafe) private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Seconds since 1970, or -infinity when missing/unparseable.
    static func time(_ iso8601: String?) -> Double {
        guard let iso8601,
            let date = iso.date(from: iso8601) ?? isoFractional.date(from: iso8601)
        else { return -.infinity }
        return date.timeIntervalSince1970
    }

    /// Natural, case-insensitive (`pod-2` before `pod-10`).
    static func compareNames(_ a: String, _ b: String) -> ComparisonResult {
        a.compare(b, options: [.numeric, .caseInsensitive])
    }

    static func supports(_ field: SortField, sample: (some SortableResource)?) -> Bool {
        switch field {
        case .api, .name: return true
        case .namespace: return sample?.sortNamespace != nil
        case .age: return true
        case .status: return sample?.sortStatus != nil
        case .restarts: return sample?.sortRestarts != nil
        }
    }

    /// Stable sort (ties keep API order); a field the rows lack falls back to Name.
    static func sorted<T: SortableResource>(_ rows: [T], by spec: SortSpec) -> [T] {
        guard spec.field != .api, !rows.isEmpty else { return rows }
        let field = supports(spec.field, sample: rows.first) ? spec.field : .name
        func byName(_ a: T, _ b: T) -> ComparisonResult { compareNames(a.name, b.name) }
        func compare(_ a: T, _ b: T) -> ComparisonResult {
            switch field {
            case .namespace:
                let r = compareNames(a.sortKeyNamespace, b.sortKeyNamespace)
                return r == .orderedSame ? byName(a, b) : r
            case .age:
                // Ascending age = youngest first = latest creation first.
                let (x, y) = (a.sortKeyAge, b.sortKeyAge)
                return x == y ? .orderedSame : (x > y ? .orderedAscending : .orderedDescending)
            case .status:
                let (x, y) = (a.sortKeyStatus, b.sortKeyStatus)
                return x == y ? byName(a, b) : (x < y ? .orderedAscending : .orderedDescending)
            case .restarts:
                let (x, y) = (a.sortKeyRestarts, b.sortKeyRestarts)
                return x == y ? byName(a, b) : (x < y ? .orderedAscending : .orderedDescending)
            default:
                return byName(a, b)
            }
        }
        return rows.enumerated().sorted { l, r in
            var result = compare(l.element, r.element)
            if !spec.ascending {
                result =
                    result == .orderedAscending
                    ? .orderedDescending : result == .orderedDescending ? .orderedAscending : result
            }
            return result == .orderedSame ? l.offset < r.offset : result == .orderedAscending
        }.map(\.element)
    }
}

// MARK: - Store

/// Navigation order/visibility and list sort, persisted globally (all
/// clusters); header-click overrides live for the session only.
@MainActor
@Observable
final class ResourcePreferences {

    static let navigationKey = "navigation"
    static let sortKey = "lists.sort"
    static let groupKey = "lists.groupByNamespace"

    private let defaults: UserDefaults

    private(set) var navigation: NavPrefs {
        didSet { save(navigation, key: Self.navigationKey) }
    }

    var defaultSort: SortSpec {
        didSet { save(defaultSort, key: Self.sortKey) }
    }

    /// "Group by namespace" (#551): global, off by default; applies only
    /// with All Namespaces.
    var groupByNamespace: Bool {
        didSet { defaults.set(groupByNamespace, forKey: Self.groupKey) }
    }

    /// List id → header-click override for this session.
    private(set) var overrides: [String: SortSpec] = [:]

    /// Collapsed namespace groups, by name and shared by every list, for
    /// the session (#551); new namespaces show expanded.
    private(set) var collapsedNamespaces: Set<String> = []

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.navigation =
            (Self.load(NavPrefs.self, key: Self.navigationKey, from: defaults) ?? .defaults)
            .normalized()
        self.defaultSort = Self.load(SortSpec.self, key: Self.sortKey, from: defaults) ?? .api
        self.groupByNamespace = defaults.bool(forKey: Self.groupKey)
    }

    private static func load<T: Decodable>(_ type: T.Type, key: String, from defaults: UserDefaults)
        -> T?
    {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(type, from: $0) }
    }

    private func save(_ value: some Encodable, key: String) {
        if let data = try? JSONEncoder().encode(value) { defaults.set(data, forKey: key) }
    }

    // Navigation

    var visibleTypes: [ResourceType] { navigation.visibleTypes }

    func moveSection(_ section: NavSection, by delta: Int) {
        navigation = navigation.movingSection(section, by: delta)
    }

    func moveType(_ type: ResourceType, by delta: Int) {
        navigation = navigation.movingType(type, by: delta)
    }

    func setHidden(_ type: ResourceType, _ hidden: Bool) {
        navigation = navigation.settingHidden(type, hidden)
    }

    func resetNavigation() {
        navigation = .defaults
        defaults.removeObject(forKey: Self.navigationKey)
    }

    // Sort

    func spec(for list: String) -> SortSpec { overrides[list] ?? defaultSort }

    /// Native table header click: a new field or direction becomes this
    /// session's sort for `list`.
    func setOverride(_ spec: SortSpec?, for list: String) {
        overrides[list] = spec
    }

    /// Header sorts and collapsed groups are per session and cluster.
    func resetSession() {
        overrides = [:]
        collapsedNamespaces = []
    }

    // Grouping (#551)

    /// Whether `type`'s list groups by namespace while `namespace` is shown
    /// (nil = All Namespaces).
    func isGrouping(_ type: ResourceType, namespace: String?) -> Bool {
        groupByNamespace && namespace == nil && type.groupsByNamespace
    }

    /// `rows` in the list's current sort, grouped when grouping applies.
    func layout<T: SortableResource>(_ rows: [T], for type: ResourceType, namespace: String?)
        -> ListLayout<T>
    {
        let current = spec(for: type.navID)
        return isGrouping(type, namespace: namespace)
            ? .grouped(ListSort.groupedByNamespace(rows, by: current))
            : .flat(ListSort.sorted(rows, by: current))
    }

    func isCollapsed(_ namespace: String) -> Bool { collapsedNamespaces.contains(namespace) }

    func setCollapsed(_ namespace: String, _ collapsed: Bool) {
        if collapsed {
            collapsedNamespaces.insert(namespace)
        } else {
            collapsedNamespaces.remove(namespace)
        }
    }

    /// Header click: toggles `namespace`'s group; Option-click passes the
    /// list's groups as `all`, which all take the clicked group's new state.
    func toggleCollapsed(_ namespace: String, all: [String]? = nil) {
        let collapse = !isCollapsed(namespace)
        for name in all ?? [namespace] { setCollapsed(name, collapse) }
    }

    /// Native `Table` sort binding for `list`: shows the effective sort as
    /// the header indicator and turns header clicks into session overrides.
    func sortOrder<T: SortableRow>(for list: String, of _: T.Type = T.self)
        -> Binding<[KeyPathComparator<T>]>
    {
        Binding(
            get: { Self.comparators(for: self.spec(for: list)) },
            set: { newValue in
                guard let first = newValue.first, let field = Self.field(of: first) else { return }
                self.setOverride(
                    SortSpec(field: field, ascending: first.order == .forward), for: list)
            })
    }

    static func comparators<T: SortableResource>(for spec: SortSpec) -> [KeyPathComparator<T>] {
        let order: SortOrder = spec.ascending ? .forward : .reverse
        switch spec.field {
        case .api: return []
        case .name: return [KeyPathComparator(\T.sortKeyName, order: order)]
        case .namespace: return [KeyPathComparator(\T.sortKeyNamespace, order: order)]
        case .age: return [KeyPathComparator(\T.sortKeyAge, order: order)]
        case .status: return [KeyPathComparator(\T.sortKeyStatus, order: order)]
        case .restarts: return [KeyPathComparator(\T.sortKeyRestarts, order: order)]
        }
    }

    static func field<T: SortableResource>(of comparator: KeyPathComparator<T>) -> SortField? {
        let keyPath = comparator.keyPath
        let known: [(SortField, PartialKeyPath<T>)] = [
            (.name, \T.sortKeyName), (.namespace, \T.sortKeyNamespace), (.age, \T.sortKeyAge),
            (.status, \T.sortKeyStatus), (.restarts, \T.sortKeyRestarts),
        ]
        return known.first { $0.1 == keyPath }?.0
    }
}

// MARK: - Row conformances

extension PodInfo: SortableResource {
    var sortNamespace: String? { namespace }
    var sortCreated: String? { creationTimestamp }
    var sortRestarts: Int? { restarts }
    var sortStatus: StatusTone? {
        switch phase?.lowercased() {
        case "running": ready ? .ok : .warn
        case "succeeded": .ok
        case "pending": .warn
        case "failed", "error", "crashloopbackoff": .err
        default: .neutral
        }
    }
}

extension DeploymentInfo: SortableResource {
    var sortNamespace: String? { namespace }
    var sortCreated: String? { creationTimestamp }
    var sortStatus: StatusTone? { replicas > 0 && readyReplicas >= replicas ? .ok : .warn }
}

extension StatefulSetInfo: SortableResource {
    var sortNamespace: String? { namespace }
    var sortCreated: String? { creationTimestamp }
    var sortStatus: StatusTone? { replicas > 0 && readyReplicas >= replicas ? .ok : .warn }
}

extension JobInfo: SortableResource {
    var sortNamespace: String? { namespace }
    var sortCreated: String? { creationTimestamp }
}

extension CronJobInfo: SortableResource {
    var sortNamespace: String? { namespace }
    var sortCreated: String? { creationTimestamp }
}

extension ServiceInfo: SortableResource {
    var sortNamespace: String? { namespace }
    var sortCreated: String? { creationTimestamp }
}

extension IngressInfo: SortableResource {
    var sortNamespace: String? { namespace }
    var sortCreated: String? { creationTimestamp }
}

extension ConfigMapInfo: SortableResource {
    var sortNamespace: String? { namespace }
    var sortCreated: String? { creationTimestamp }
}

extension SecretInfo: SortableResource {
    var sortNamespace: String? { namespace }
    var sortCreated: String? { creationTimestamp }
}

extension PvcInfo: SortableResource {
    var sortNamespace: String? { namespace }
    var sortCreated: String? { creationTimestamp }
    /// Mirrors the row colour: Bound ok, Lost err, anything else warn.
    var sortStatus: StatusTone? { status == "Bound" ? .ok : status == "Lost" ? .err : .warn }
}

extension NodeInfo: SortableResource {
    var sortCreated: String? { creationTimestamp }
    var sortStatus: StatusTone? { status == "Ready" ? .ok : .err }
}

extension HelmReleaseInfo: SortableResource {
    var sortNamespace: String? { namespace }
    var sortCreated: String? { creationTimestamp }
    var sortStatus: StatusTone? {
        let s = status?.lowercased() ?? ""
        if s == "deployed" { return .ok }
        if s == "failed" { return .err }
        return s.hasPrefix("pending") ? .warn : .neutral
    }
}
