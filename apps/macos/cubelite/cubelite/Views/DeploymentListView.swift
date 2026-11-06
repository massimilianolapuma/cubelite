import SwiftUI

/// Table listing Kubernetes deployments for the selected context and namespace.
///
/// Columns: Name, Ready (ready/desired replicas), Namespace.
/// Selecting a row updates `selectedDeploymentID` for ``ResourceDetailView``.
struct DeploymentListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Environment(ResourcePreferences.self) private var resourcePreferences
    @Environment(PrometheusStore.self) private var prometheus: PrometheusStore?

    /// Preferences default sort or this session's header sort (#497),
    /// grouped by namespace when that applies (#551).
    private var layout: ListLayout<DeploymentInfo> {
        resourcePreferences.layout(
            clusterState.deployments, for: .deployments, namespace: clusterState.selectedNamespace)
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
        .task(id: prometheus?.scope(context: clusterState.currentContext, namespace: clusterState.selectedNamespace)) {
            await loadSparklines()
        }
        // A refresh re-asks; the store throttles to once every 30 s.
        .onChange(of: clusterState.deployments.map(\.id)) { Task { await loadSparklines() } }
    }

    private func loadSparklines() async {
        await prometheus?.loadSparklines(
            context: clusterState.currentContext, namespace: clusterState.selectedNamespace)
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
        let cpu = cpuByDeployment()
        let layout = self.layout
        return Table(of: DeploymentInfo.self, selection: $selectedDeploymentID, sortOrder: resourcePreferences.sortOrder(for: "deployments", of: DeploymentInfo.self)) {
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

            if layout.showsNamespaceColumn { NamespaceColumn.column(DeploymentInfo.self) }

            TableColumn("Ready", value: \.sortKeyStatus) { dep in
                HStack(spacing: 6) {
                    replicasBadge(ready: dep.readyReplicas, desired: dep.replicas)
                    SparklineView(points: cpu[dep.id], label: "CPU, last hour")
                        .help("CPU of the current pods, last hour, from Prometheus")
                }
            }
            .width(ideal: 120)
        } rows: {
            NamespaceTableRows(layout: layout, type: .deployments, preferences: resourcePreferences)
        }
        .unifiedTableBackground()
        .namespaceGroupKeys(layout, selection: selectedDeploymentID, preferences: resourcePreferences)
    }

    // MARK: - Helpers

    /// Last hour of CPU summed over each deployment's current pods (#512),
    /// computed once per render of the table.
    private func cpuByDeployment() -> [String: [MetricPoint]] {
        guard let prometheus, prometheus.sparklines != nil else { return [:] }
        var podsByNamespace: [String: [PodInfo]] = [:]
        for pod in clusterState.pods { podsByNamespace[pod.namespace, default: []].append(pod) }
        var out: [String: [MetricPoint]] = [:]
        for dep in clusterState.deployments {
            guard let selector = dep.selector, !selector.isEmpty else { continue }
            let series = (podsByNamespace[dep.namespace] ?? [])
                .filter { pod in selector.allSatisfy { pod.labels?[$0.key] == $0.value } }
                .compactMap { prometheus.cpu(namespace: $0.namespace, pod: $0.name) }
            if !series.isEmpty { out[dep.id] = MetricsMath.sum(series) }
        }
        return out
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
