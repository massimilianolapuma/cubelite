import SwiftUI

/// Table listing StatefulSets for the selected context and namespace.
///
/// Columns: Status, Name, Ready, Status label, Age.
struct StatefulSetListView: View {

    @Environment(ClusterState.self) private var clusterState

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
        Table(clusterState.statefulSets) {
            TableColumn("") { set in
                Circle()
                    .fill(isAvailable(set) ? DesignTokens.statusOk : DesignTokens.statusWarn)
                    .frame(width: 8, height: 8)
            }
            .width(16)

            TableColumn("Name") { set in
                Text(set.name)
                    .font(.callout.monospaced())
                    .lineLimit(1)
            }

            TableColumn("Ready") { set in
                Text("\(set.readyReplicas)/\(set.replicas)")
                    .foregroundStyle(DesignTokens.textSecondary)
            }
            .width(70)

            TableColumn("Status") { set in
                Text(isAvailable(set) ? "Available" : "Progressing")
                    .foregroundStyle(
                        isAvailable(set) ? DesignTokens.statusOk : DesignTokens.statusWarn)
            }
            .width(100)

            TableColumn("Age") { set in
                Text(set.creationTimestamp.k8sAge)
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .width(70)
        }
        .unifiedTableBackground()
    }
}
