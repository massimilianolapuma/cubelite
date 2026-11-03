import SwiftUI

/// Table listing Kubernetes Ingresses for the selected context and namespace.
///
/// Columns: Name, Namespace, Class, Hosts, Address, TLS, Age.
struct IngressListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Environment(ResourcePreferences.self) private var resourcePreferences

    /// Preferences default sort or this session's header sort (#497).
    private var sortedRows: [IngressInfo] {
        ListSort.sorted(clusterState.ingresses, by: resourcePreferences.spec(for: "ingresses"))
    }
    @Binding var selectedIngressID: IngressInfo.ID?

    var body: some View {
        Group {
            if clusterState.isLoadingResources {
                loadingView
            } else if let error = clusterState.resourceError {
                errorView(error)
            } else if clusterState.ingresses.isEmpty {
                emptyView
            } else {
                ingressTable
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - States

    private var loadingView: some View {
        UnifiedLoadingState(label: "Loading ingresses…")
    }

    private func errorView(_ message: String) -> some View {
        UnifiedErrorState(title: "Failed to load ingresses", message: message)
    }

    private var emptyView: some View {
        UnifiedEmptyState(message: "There are no ingresses in this namespace.")
    }

    // MARK: - Table

    private var ingressTable: some View {
        Table(sortedRows, selection: $selectedIngressID, sortOrder: resourcePreferences.sortOrder(for: "ingresses", of: IngressInfo.self)) {
            TableColumn("Name", value: \.sortKeyName) { ingress in
                Text(ingress.name)
                    .typeStyle(DesignTokens.Typography.data)
                    .lineLimit(1)
            }
            .width(min: 120, ideal: 200)

            TableColumn("Namespace", value: \.sortKeyNamespace) { ingress in
                Text(ingress.namespace)
                    .typeStyle(DesignTokens.Typography.dataSm)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 120)

            TableColumn("Class") { ingress in
                Text(ingress.ingressClass ?? "—")
                    .typeStyle(DesignTokens.Typography.dataSm)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 60, ideal: 100)

            TableColumn("Hosts") { ingress in
                Text(ingress.hosts ?? "—")
                    .typeStyle(DesignTokens.Typography.dataSm)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 120, ideal: 200)

            TableColumn("Address") { ingress in
                Text(ingress.address ?? "—")
                    .typeStyle(DesignTokens.Typography.dataSm)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 140)

            TableColumn("TLS") { ingress in
                if ingress.tlsEnabled {
                    Image(systemName: "lock.fill")
                        .foregroundStyle(DesignTokens.statusOk)
                        .help("TLS enabled")
                        .accessibilityLabel("TLS enabled")
                } else {
                    Image(systemName: "lock.open")
                        .foregroundStyle(.secondary)
                        .help("No TLS")
                        .accessibilityLabel("No TLS")
                }
            }
            .width(ideal: 40)

            TableColumn("Age", value: \.sortKeyAge) { ingress in
                Text(ingress.creationTimestamp.k8sAge)
                    .typeStyle(DesignTokens.Typography.dataSm)
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 60)
        }
        .unifiedTableBackground()
    }
}
