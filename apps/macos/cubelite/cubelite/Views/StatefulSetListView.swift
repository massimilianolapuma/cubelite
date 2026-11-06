import SwiftUI

/// Table listing StatefulSets for the selected context and namespace.
///
/// Columns: Status, Name, Ready, Status label, Age.
struct StatefulSetListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Environment(ResourcePreferences.self) private var resourcePreferences

    /// Preferences default sort or this session's header sort (#497),
    /// grouped by namespace when that applies (#551).
    private var layout: ListLayout<StatefulSetInfo> {
        resourcePreferences.layout(
            clusterState.statefulSets, for: .statefulSets, namespace: clusterState.selectedNamespace)
    }

    var body: some View {
        Group {
            if clusterState.isLoadingResources {
                UnifiedLoadingState(label: "Loading stateful sets…")
            } else if let error = clusterState.resourceError {
                UnifiedErrorState(title: "Failed to load stateful sets", message: error)
            } else if clusterState.statefulSets.isEmpty {
                UnifiedEmptyState(message: "There are no stateful sets in this namespace.")
            } else {
                table
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func isAvailable(_ set: StatefulSetInfo) -> Bool {
        set.replicas > 0 && set.readyReplicas >= set.replicas
    }

    private var table: some View {
        let layout = self.layout
        return Table(of: StatefulSetInfo.self, sortOrder: resourcePreferences.sortOrder(for: "statefulsets", of: StatefulSetInfo.self)) {
            TableColumn("") { set in
                Circle()
                    .fill(isAvailable(set) ? DesignTokens.statusOk : DesignTokens.statusWarn)
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
            }
            .width(16)

            TableColumn("Name", value: \.sortKeyName) { set in
                Text(set.name)
                    .typeStyle(DesignTokens.Typography.data)
                    .lineLimit(1)
            }

            TableColumn("Ready") { set in
                Text("\(set.readyReplicas)/\(set.replicas)")
                    .foregroundStyle(DesignTokens.textSecondary)
            }
            .width(70)

            TableColumn("Status", value: \.sortKeyStatus) { set in
                Text(isAvailable(set) ? "Available" : "Progressing")
                    .foregroundStyle(
                        isAvailable(set) ? DesignTokens.statusOk : DesignTokens.statusWarn)
            }
            .width(100)

            TableColumn("Age", value: \.sortKeyAge) { set in
                Text(set.creationTimestamp.k8sAge)
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .width(70)
        } rows: {
            NamespaceTableRows(layout: layout, type: .statefulSets, preferences: resourcePreferences)
        }
        .unifiedTableBackground()
    }
}
