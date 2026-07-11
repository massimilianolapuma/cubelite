import SwiftUI

/// Table listing Kubernetes ConfigMaps for the selected context and namespace.
///
/// Columns: Name, Namespace, Data Keys, Age.
struct ConfigMapListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Binding var selectedConfigMapID: ConfigMapInfo.ID?

    var body: some View {
        Group {
            if clusterState.isLoadingResources {
                loadingView
            } else if let error = clusterState.resourceError {
                errorView(error)
            } else if clusterState.configMaps.isEmpty {
                emptyView
            } else {
                configMapTable
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - States

    private var loadingView: some View {
        UnifiedLoadingState(label: "Loading config maps…")
    }

    private func errorView(_ message: String) -> some View {
        UnifiedErrorState(title: "Failed to load config maps", message: message)
    }

    private var emptyView: some View {
        UnifiedEmptyState(message: "There are no config maps in this namespace.")
    }

    // MARK: - Table

    private var configMapTable: some View {
        Table(clusterState.configMaps, selection: $selectedConfigMapID) {
            TableColumn("Name") { configMap in
                Text(configMap.name)
                    .font(.callout.monospaced())
                    .lineLimit(1)
            }
            .width(min: 120, ideal: 220)

            TableColumn("Namespace") { configMap in
                Text(configMap.namespace)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 120)

            TableColumn("Data Keys") { configMap in
                Text("\(configMap.dataCount)")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 80)

            TableColumn("Age") { configMap in
                Text(configMap.creationTimestamp.k8sAge)
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 60)
        }
        .unifiedTableBackground()
    }
}

// MARK: - Preview

#Preview {
    let state = ClusterState()
    state.configMaps = [
        ConfigMapInfo(
            name: "kube-proxy",
            namespace: "kube-system",
            dataCount: 3,
            creationTimestamp: nil
        ),
        ConfigMapInfo(
            name: "app-config",
            namespace: "default",
            dataCount: 8,
            creationTimestamp: nil
        ),
        ConfigMapInfo(
            name: "nginx-conf",
            namespace: "ingress-nginx",
            dataCount: 1,
            creationTimestamp: nil
        ),
    ]
    return ConfigMapListView(selectedConfigMapID: .constant(nil))
        .environment(state)
        .frame(width: 800, height: 400)
}
