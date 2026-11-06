import SwiftUI

/// Table listing Kubernetes ConfigMaps for the selected context and namespace.
///
/// Columns: Name, Namespace, Data Keys, Age.
struct ConfigMapListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Environment(ResourcePreferences.self) private var resourcePreferences

    /// Preferences default sort or this session's header sort (#497),
    /// grouped by namespace when that applies (#551).
    private var layout: ListLayout<ConfigMapInfo> {
        resourcePreferences.layout(
            clusterState.configMaps, for: .configMaps, namespace: clusterState.selectedNamespace)
    }
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
        let layout = self.layout
        return Table(of: ConfigMapInfo.self, selection: $selectedConfigMapID, sortOrder: resourcePreferences.sortOrder(for: "configmaps", of: ConfigMapInfo.self)) {
            TableColumn("Name", value: \.sortKeyName) { configMap in
                Text(configMap.name)
                    .typeStyle(DesignTokens.Typography.data)
                    .lineLimit(1)
            }
            .width(min: 120, ideal: 220)

            if layout.showsNamespaceColumn { NamespaceColumn.column(ConfigMapInfo.self) }

            TableColumn("Data Keys") { configMap in
                Text("\(configMap.dataCount)")
                    .typeStyle(DesignTokens.Typography.dataSm)
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 80)

            TableColumn("Age", value: \.sortKeyAge) { configMap in
                Text(configMap.creationTimestamp.k8sAge)
                    .typeStyle(DesignTokens.Typography.dataSm)
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 60)
        } rows: {
            NamespaceTableRows(layout: layout, type: .configMaps, preferences: resourcePreferences)
        }
        .unifiedTableBackground()
        .namespaceGroupKeys(layout, selection: selectedConfigMapID, preferences: resourcePreferences)
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
        .environment(ResourcePreferences())
        .frame(width: 800, height: 400)
}
