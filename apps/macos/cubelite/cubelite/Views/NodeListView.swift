import SwiftUI

/// Table listing cluster nodes (read-only inventory).
///
/// Columns: Status, Name, Roles, Version, Age. Nodes are cluster-scoped and
/// loaded best-effort: when RBAC denies them the list is simply empty.
struct NodeListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Environment(ResourcePreferences.self) private var resourcePreferences

    /// Preferences default sort or this session's header sort (#497).
    private var sortedRows: [NodeInfo] {
        ListSort.sorted(clusterState.nodes, by: resourcePreferences.spec(for: "nodes"))
    }

    var body: some View {
        Group {
            if clusterState.isLoadingResources {
                UnifiedLoadingState(label: "Loading nodes…")
            } else if clusterState.nodes.isEmpty {
                UnifiedEmptyState(
                    message: "No nodes visible — the cluster may deny node listing.")
            } else {
                nodeTable
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var nodeTable: some View {
        Table(sortedRows, sortOrder: resourcePreferences.sortOrder(for: "nodes", of: NodeInfo.self)) {
            TableColumn("") { node in
                Circle()
                    .fill(
                        node.status == "Ready"
                            ? DesignTokens.statusOk : DesignTokens.statusErr
                    )
                    .frame(width: 8, height: 8)
                    .help(node.status)
                    .accessibilityHidden(true)
            }
            .width(16)

            TableColumn("Name", value: \.sortKeyName) { node in
                Text(node.name)
                    .typeStyle(DesignTokens.Typography.data)
                    .lineLimit(1)
            }

            TableColumn("Status", value: \.sortKeyStatus) { node in
                Text(node.status)
                    .foregroundStyle(
                        node.status == "Ready"
                            ? DesignTokens.statusOk : DesignTokens.statusErr)
            }
            .width(90)

            TableColumn("Roles") { node in
                Text(node.roles.isEmpty ? "—" : node.roles.joined(separator: ", "))
                    .foregroundStyle(DesignTokens.textSecondary)
                    .lineLimit(1)
            }

            TableColumn("Version") { node in
                Text(node.version ?? "—")
                    .typeStyle(DesignTokens.Typography.dataSm)
                    .foregroundStyle(DesignTokens.textSecondary)
            }
            .width(110)

            TableColumn("Age", value: \.sortKeyAge) { node in
                Text(node.creationTimestamp.k8sAge)
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .width(70)
        }
        .unifiedTableBackground()
    }
}
