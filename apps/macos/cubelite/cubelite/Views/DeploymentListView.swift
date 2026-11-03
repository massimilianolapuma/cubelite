import SwiftUI

/// Table listing Kubernetes deployments for the selected context and namespace.
///
/// Columns: Name, Ready (ready/desired replicas), Namespace.
/// Selecting a row updates `selectedDeploymentID` for ``ResourceDetailView``.
struct DeploymentListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Environment(ResourcePreferences.self) private var resourcePreferences
    @Environment(PrometheusStore.self) private var prometheus: PrometheusStore?

    /// Preferences default sort or this session's header sort (#497).
    private var sortedRows: [DeploymentInfo] {
        ListSort.sorted(clusterState.deployments, by: resourcePreferences.spec(for: "deployments"))
    }
    @Binding var selectedDeploymentID: DeploymentInfo.ID?

    var body: some View {
        Group {
            if clusterState.isLoadingResources {
                loadingView
            } else if let error = clusterState.resourceError {
                errorView(error)
            } else if clusterState.deployments.isEmpty {
                emptyView
            } else {
                deploymentTable
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: "\(clusterState.currentContext ?? "")|\(clusterState.selectedNamespace ?? "*")|\(clusterState.deployments.count)") {
            await prometheus?.loadSparklines(
                context: clusterState.currentContext, namespace: clusterState.selectedNamespace)
        }
    }

    // MARK: - States

    private var loadingView: some View {
        UnifiedLoadingState(label: "Loading deployments…")
    }

    private func errorView(_ message: String) -> some View {
        UnifiedErrorState(title: "Failed to load deployments", message: message)
    }

    private var emptyView: some View {
        UnifiedEmptyState(message: "There are no deployments in this namespace.")
    }

    // MARK: - Table

    private var deploymentTable: some View {
        Table(sortedRows, selection: $selectedDeploymentID, sortOrder: resourcePreferences.sortOrder(for: "deployments", of: DeploymentInfo.self)) {
            TableColumn("") { dep in
                DeploymentStatusDot(ready: dep.readyReplicas, desired: dep.replicas)
            }
            .width(16)

            TableColumn("Name", value: \.sortKeyName) { dep in
                Text(dep.name)
                    .typeStyle(DesignTokens.Typography.data)
                    .lineLimit(1)
            }
            .width(min: 120, ideal: 220)

            TableColumn("Namespace", value: \.sortKeyNamespace) { dep in
                Text(dep.namespace)
                    .typeStyle(DesignTokens.Typography.dataSm)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 120)

            TableColumn("Ready", value: \.sortKeyStatus) { dep in
                HStack(spacing: 6) {
                    replicasBadge(ready: dep.readyReplicas, desired: dep.replicas)
                    SparklineView(points: cpu(of: dep), label: "CPU, last hour")
                        .help("CPU of the current pods, last hour, from Prometheus")
                }
            }
            .width(ideal: 120)

        }
        .unifiedTableBackground()
    }

    // MARK: - Helpers

    /// Last hour of CPU summed over the deployment's current pods (#512).
    private func cpu(of dep: DeploymentInfo) -> [MetricPoint]? {
        guard let prometheus, prometheus.sparklines != nil, let selector = dep.selector,
            !selector.isEmpty
        else { return nil }
        let series = clusterState.pods
            .filter { pod in
                pod.namespace == dep.namespace && selector.allSatisfy { pod.labels?[$0.key] == $0.value }
            }
            .compactMap { prometheus.cpu(namespace: $0.namespace, pod: $0.name) }
        return series.isEmpty ? nil : MetricsMath.sum(series)
    }

    private func replicasBadge(ready: Int, desired: Int) -> some View {
        let allReady = ready == desired && desired > 0
        return HStack(spacing: 3) {
            Text("\(ready)/\(desired)")
                .typeStyle(DesignTokens.Typography.dataSm)
                .foregroundStyle(allReady ? DesignTokens.statusOk : DesignTokens.statusWarn)
        }
    }
}

// MARK: - Deployment Status Dot

/// Coloured circle reflecting replica health.
private struct DeploymentStatusDot: View {
    let ready: Int
    let desired: Int

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .help(helpText)
            .accessibilityHidden(true)
    }

    private var color: Color {
        if desired == 0 { return .secondary }
        return ready == desired ? DesignTokens.statusOk : DesignTokens.statusWarn
    }

    private var helpText: String {
        "\(ready)/\(desired) replicas ready"
    }
}

// MARK: - Preview

#Preview {
    DeploymentListPreview()
        .frame(width: 600, height: 260)
}

@MainActor
private struct DeploymentListPreview: View {
    @State private var selectedID: String?
    @State private var state = ClusterState()

    var body: some View {
        DeploymentListView(selectedDeploymentID: $selectedID)
            .environment(state)
            .environment(ResourcePreferences())
            .task {
                guard state.deployments.isEmpty else { return }
                state.deployments = previewDeployments()
            }
    }

    private func previewDeployments() -> [DeploymentInfo] {
        [
            DeploymentInfo(name: "nginx", namespace: "default", replicas: 3, readyReplicas: 3),
            DeploymentInfo(name: "api-server", namespace: "backend", replicas: 2, readyReplicas: 1),
            DeploymentInfo(name: "worker", namespace: "jobs", replicas: 5, readyReplicas: 5),
            DeploymentInfo(name: "pending-dep", namespace: "default", replicas: 1, readyReplicas: 0),
        ]
    }
}
