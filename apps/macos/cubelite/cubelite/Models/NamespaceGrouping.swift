import Foundation

// Optional grouping of the resource lists by namespace (#551, part of #547;
// same rules as the desktop `list-group.ts`, spec
// docs/superpowers/specs/2026-11-06-namespace-grouping-design.md).

/// One namespace's rows in a grouped list, with what its header shows.
struct NamespaceGroup<Row> {
    let namespace: String
    /// The rows, in the list's current order.
    let rows: [Row]
    /// Worst tone among the rows that are not ok; nil when every row is ok
    /// or the list has no status.
    let worst: StatusTone?
    /// Rows whose status is not ok (0 on lists without a status).
    let problems: Int

    var count: Int { rows.count }

    /// "team-a, 12 pods, 2 with problems, expanded".
    func accessibilityLabel(noun: ListNoun, expanded: Bool) -> String {
        var parts = [namespace, noun.count(count)]
        if problems > 0 { parts.append("\(problems) with problems") }
        parts.append(expanded ? "expanded" : "collapsed")
        return parts.joined(separator: ", ")
    }
}

extension NamespaceGroup: Identifiable {
    var id: String { namespace }
}

extension NamespaceGroup: Sendable where Row: Sendable {}

/// What a list's rows are called in a group header ("1 pod", "12 pods").
struct ListNoun: Equatable, Sendable {
    let singular: String
    let plural: String

    func count(_ n: Int) -> String { "\(n) \(n == 1 ? singular : plural)" }
}

/// A list's rows as the table shows them: flat, or one group per namespace.
enum ListLayout<Row> {
    case flat([Row])
    case grouped([NamespaceGroup<Row>])

    var isGrouped: Bool {
        if case .grouped = self { return true }
        return false
    }

    /// The Namespace column repeats the group header, so it is left out
    /// while grouped.
    var showsNamespaceColumn: Bool { !isGrouped }
}

extension ListLayout where Row: Identifiable {
    /// Namespace of the group holding the row `id` (keyboard ←/→ collapse
    /// and expand the selected row's group); nil when flat or not found.
    func namespace(ofRow id: Row.ID?) -> String? {
        guard case .grouped(let groups) = self, let id else { return nil }
        return groups.first { group in group.rows.contains { $0.id == id } }?.namespace
    }
}

extension ListLayout: Sendable where Row: Sendable {}

extension ResourceType {
    /// Row noun of the lists that can group by namespace (spec §3: every
    /// namespaced list); nil for Overview, Nodes, Events and Logs.
    var groupNoun: ListNoun? {
        switch self {
        case .pods: ListNoun(singular: "pod", plural: "pods")
        case .deployments: ListNoun(singular: "deployment", plural: "deployments")
        case .statefulSets: ListNoun(singular: "stateful set", plural: "stateful sets")
        case .jobs: ListNoun(singular: "job", plural: "jobs")
        case .cronJobs: ListNoun(singular: "cron job", plural: "cron jobs")
        case .services: ListNoun(singular: "service", plural: "services")
        case .ingresses: ListNoun(singular: "ingress", plural: "ingresses")
        case .configMaps: ListNoun(singular: "config map", plural: "config maps")
        case .secrets: ListNoun(singular: "secret", plural: "secrets")
        case .pvcs: ListNoun(singular: "persistent volume claim", plural: "persistent volume claims")
        case .helmReleases: ListNoun(singular: "Helm release", plural: "Helm releases")
        case .dashboard, .nodes, .events, .logs: nil
        }
    }

    var groupsByNamespace: Bool { groupNoun != nil }
}

extension ListSort {

    /// Groups by namespace: groups A→Z (Z→A when the sort is Namespace
    /// descending); rows inside a group follow `spec`, by name when `spec`
    /// is Namespace, in API order when it is API order. Empty namespaces
    /// never appear (there is no row to make them).
    static func groupedByNamespace<T: SortableResource>(_ rows: [T], by spec: SortSpec)
        -> [NamespaceGroup<T>]
    {
        let inner = spec.field == .namespace ? SortSpec(field: .name, ascending: true) : spec
        var names: [String] = []
        var buckets: [String: [T]] = [:]
        for row in sorted(rows, by: inner) {
            let namespace = row.sortKeyNamespace
            if buckets[namespace] == nil { names.append(namespace) }
            buckets[namespace, default: []].append(row)
        }
        let descending = spec.field == .namespace && !spec.ascending
        func before(_ a: String, _ b: String) -> Bool {
            let r = compareNames(a, b)
            return r == .orderedSame ? a < b : r == .orderedAscending
        }
        names.sort { descending ? before($1, $0) : before($0, $1) }
        return names.map { namespace in
            let members = buckets[namespace] ?? []
            let tones = members.compactMap(\.sortStatus).filter { $0 != .ok }
            return NamespaceGroup(
                namespace: namespace, rows: members,
                worst: tones.min { $0.rawValue < $1.rawValue }, problems: tones.count)
        }
    }
}
