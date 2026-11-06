import AppKit
import SwiftUI

// Shared pieces of "Group by namespace" (#551, spec
// docs/superpowers/specs/2026-11-06-namespace-grouping-design.md): the rows
// of every resource table, the group header row, and the list toolbar toggle.

/// The rows of a resource `Table`: flat, or one section per namespace whose
/// header collapses it. Collapsing never touches the table's selection.
struct NamespaceTableRows<Row: Identifiable>: TableRowContent {
    let layout: ListLayout<Row>
    let type: ResourceType
    let preferences: ResourcePreferences

    // Explicit `ForEach` generics: with Swift Charts in the module, older
    // toolchains (CI) otherwise pick the ChartContent overload.
    @TableRowBuilder<Row>
    var tableRowBody: some TableRowContent<Row> {
        switch layout {
        case .flat(let rows):
            ForEach<[Row], Row.ID, TableRow<Row>>(rows) { row in TableRow(row) }
        case .grouped(let groups):
            ForEach<[NamespaceGroup<Row>], String, NamespaceSectionRows<Row>>(groups) { group in
                NamespaceSectionRows(
                    group: group, collapsed: preferences.isCollapsed(group.namespace),
                    header: header(for: group, in: groups))
            }
        }
    }

    private func header(for group: NamespaceGroup<Row>, in groups: [NamespaceGroup<Row>])
        -> NamespaceGroupHeader
    {
        let expanded = !preferences.isCollapsed(group.namespace)
        let noun = type.groupNoun ?? ListNoun(singular: "item", plural: "items")
        return NamespaceGroupHeader(
            namespace: group.namespace, count: group.count, worst: group.worst,
            problems: group.problems, expanded: expanded,
            accessibilityLabel: group.accessibilityLabel(noun: noun, expanded: expanded),
            toggle: { [preferences] all in
                preferences.toggleCollapsed(group.namespace, all: all ? groups.map(\.namespace) : nil)
            })
    }
}

/// One namespace's section: its header, then its rows unless collapsed.
struct NamespaceSectionRows<Row: Identifiable>: TableRowContent {
    let group: NamespaceGroup<Row>
    let collapsed: Bool
    let header: NamespaceGroupHeader

    @TableRowBuilder<Row>
    var tableRowBody: some TableRowContent<Row> {
        Section {
            if !collapsed {
                ForEach<[Row], Row.ID, TableRow<Row>>(group.rows) { row in TableRow(row) }
            }
        } header: {
            header
        }
    }
}

/// Full-width group header: chevron, namespace, row count and, on lists with
/// a status, the worst tone's dot plus the count of rows not ok. Count and
/// marker follow the name rather than the far edge, which a wide table can
/// scroll out of view. The whole row is one button; Option-click sets every
/// group to the new state.
struct NamespaceGroupHeader: View {
    let namespace: String
    let count: Int
    let worst: StatusTone?
    let problems: Int
    let expanded: Bool
    let accessibilityLabel: String
    /// Called with `true` when Option is held (collapse/expand all).
    let toggle: (_ all: Bool) -> Void

    var body: some View {
        Button {
            toggle(NSEvent.modifierFlags.contains(.option))
        } label: {
            HStack(spacing: DesignTokens.spacing2) {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
                    .frame(width: DesignTokens.iconLg)
                Text(namespace)
                    .typeStyle(DesignTokens.Typography.data, color: DesignTokens.textDataBright)
                    .lineLimit(1)
                    .padding(.trailing, DesignTokens.spacing1)
                Text("\(count)")
                    .typeStyle(DesignTokens.Typography.dataSm, color: DesignTokens.textSecondary)
                if let worst, problems > 0 {
                    HStack(spacing: DesignTokens.spacing1) {
                        Circle()
                            .fill(worst.color)
                            .frame(width: DesignTokens.iconXs, height: DesignTokens.iconXs)
                        Text("\(problems)")
                            .typeStyle(DesignTokens.Typography.dataSm, color: DesignTokens.textSecondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Option-click to collapse or expand every namespace")
        .accessibilityLabel(accessibilityLabel)
        .accessibilityIdentifier("namespace-group.\(namespace)")
    }
}

/// List toolbar toggle for "Group by namespace"; only shown where grouping
/// applies (a namespaced list with All Namespaces selected).
struct GroupByNamespaceToggle: View {
    @Environment(ResourcePreferences.self) private var preferences

    var body: some View {
        Toggle(isOn: Bindable(preferences).groupByNamespace) {
            Image(systemName: "rectangle.grid.1x2")
        }
        .toggleStyle(.button)
        .help("Group by namespace")
        .accessibilityLabel("Group by namespace")
        .accessibilityIdentifier("list.group-by-namespace")
    }

    /// Whether the toggle is shown for `type` while `namespace` is selected.
    static func isShown(for type: ResourceType?, namespace: String?) -> Bool {
        namespace == nil && (type?.groupsByNamespace ?? false)
    }
}

/// The Namespace column of every namespaced list; a list leaves it out
/// while grouped, where the group header names the namespace.
@MainActor
enum NamespaceColumn {
    static func column<Row: SortableRow & Identifiable>(_: Row.Type)
        -> some TableColumnContent<Row, KeyPathComparator<Row>>
    {
        TableColumn("Namespace", value: \Row.sortKeyNamespace) { row in
            Text(row.sortKeyNamespace)
                .typeStyle(DesignTokens.Typography.dataSm)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .width(min: 80, ideal: 120)
    }
}

extension StatusTone {
    /// The status dot colour of a tone.
    var color: Color {
        switch self {
        case .err: DesignTokens.statusErr
        case .warn: DesignTokens.statusWarn
        case .neutral: DesignTokens.textTertiary
        case .ok: DesignTokens.statusOk
        }
    }
}
