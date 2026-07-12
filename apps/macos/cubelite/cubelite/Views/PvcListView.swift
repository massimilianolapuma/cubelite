import SwiftUI

/// Table listing PersistentVolumeClaims for the selected context/namespace.
///
/// Columns: Status, Name, Volume, Capacity, Access modes, StorageClass, Age.
struct PvcListView: View {

    @Environment(ClusterState.self) private var clusterState

    var body: some View {
        Group {
            if clusterState.isLoadingResources {
                UnifiedLoadingState(label: "Loading persistent volume claims…")
            } else if let error = clusterState.resourceError {
                UnifiedErrorState(title: "Failed to load claims", message: error)
            } else if clusterState.pvcs.isEmpty {
                UnifiedEmptyState(message: "There are no persistent volume claims in this namespace.")
            } else {
                table
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func tone(_ status: String?) -> Color {
        switch status {
        case "Bound": DesignTokens.statusOk
        case "Lost": DesignTokens.statusErr
        default: DesignTokens.statusWarn
        }
    }

    private var table: some View {
        Table(clusterState.pvcs) {
            TableColumn("") { pvc in
                Circle()
                    .fill(tone(pvc.status))
                    .frame(width: 8, height: 8)
                    .help(pvc.status ?? "Unknown")
            }
            .width(16)

            TableColumn("Name") { pvc in
                Text(pvc.name)
                    .font(.callout.monospaced())
                    .lineLimit(1)
            }

            TableColumn("Status") { pvc in
                Text(pvc.status ?? "—")
                    .foregroundStyle(tone(pvc.status))
            }
            .width(70)

            TableColumn("Volume") { pvc in
                Text(pvc.volume ?? "—")
                    .font(.callout.monospaced())
                    .foregroundStyle(DesignTokens.textSecondary)
                    .lineLimit(1)
            }

            TableColumn("Capacity") { pvc in
                Text(pvc.capacity ?? "—")
                    .foregroundStyle(DesignTokens.textSecondary)
            }
            .width(70)

            TableColumn("Access") { pvc in
                Text(pvc.accessModes.isEmpty ? "—" : pvc.accessModes.joined(separator: ", "))
                    .foregroundStyle(DesignTokens.textSecondary)
                    .lineLimit(1)
            }
            .width(110)

            TableColumn("Class") { pvc in
                Text(pvc.storageClass ?? "—")
                    .foregroundStyle(DesignTokens.textSecondary)
            }
            .width(80)

            TableColumn("Age") { pvc in
                Text(pvc.creationTimestamp.k8sAge)
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .width(60)
        }
        .unifiedTableBackground()
    }
}
