import SwiftUI

/// Aggregated dashboard showing health snapshots across all Kubernetes clusters.
struct CrossClusterDashboardView: View {

    let crossClusterState: CrossClusterState
    let onRefresh: () async -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerRow
                summaryGrid
                clusterListSection
            }
            .padding(20)
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    // MARK: - Header

    private var headerRow: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("All Clusters")
                    .font(.title2.bold())
                if let updated = crossClusterState.lastUpdated {
                    Text("Updated \(updated.formatted(.relative(presentation: .named)))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if crossClusterState.isLoading {
                ProgressView().controlSize(.small)
            } else {
                Button {
                    Task { await onRefresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh all clusters")
            }
        }
    }

    // MARK: - Summary Cards

    private var summaryGrid: some View {
        LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)],
            spacing: 16
        ) {
            DashboardCard(title: "Pods", icon: "cube.box", color: .blue) {
                podsSummaryContent
            }
            DashboardCard(title: "Deployments", icon: "arrow.triangle.2.circlepath", color: .purple)
            {
                deploymentsSummaryContent
            }
            DashboardCard(title: "Services", icon: "network", color: .indigo) {
                DashboardMetric(label: "Total", value: "\(crossClusterState.totalServices)")
            }
            DashboardCard(title: "Clusters", icon: "server.rack", color: .teal) {
                clustersSummaryContent
            }
        }
    }

    private var podsSummaryContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            DashboardMetric(label: "Total", value: "\(crossClusterState.totalPods)")
            DashboardMetric(
                label: "Running", value: "\(crossClusterState.runningPods)", color: .green)
            DashboardMetric(label: "Failed", value: "\(crossClusterState.failedPods)", color: .red)
        }
    }

    private var deploymentsSummaryContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            DashboardMetric(label: "Total", value: "\(crossClusterState.totalDeployments)")
            DashboardMetric(
                label: "Healthy", value: "\(crossClusterState.healthyDeployments)", color: .green)
        }
    }

    private var clustersSummaryContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            DashboardMetric(label: "Total", value: "\(crossClusterState.snapshots.count)")
            DashboardMetric(
                label: "Online", value: "\(crossClusterState.onlineClusters)", color: .green)
            DashboardMetric(
                label: "Limited", value: "\(crossClusterState.limitedClusters)", color: .orange)
            DashboardMetric(
                label: "Offline", value: "\(crossClusterState.offlineClusters)", color: .red)
        }
    }

    // MARK: - Per-Cluster List

    private var clusterListSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Cluster Details")
                .font(.headline)
                .foregroundStyle(.secondary)
            if crossClusterState.snapshots.isEmpty && !crossClusterState.isLoading {
                clusterEmptyState
            } else {
                ForEach(crossClusterState.snapshots, id: \.contextName) { snapshot in
                    ClusterSnapshotRow(snapshot: snapshot)
                }
            }
        }
    }

    private var clusterEmptyState: some View {
        ContentUnavailableView {
            Label("No Data", systemImage: "cloud.slash")
        } description: {
            Text("Tap refresh to load cluster data.")
        }
    }
}

// MARK: - Cluster Snapshot Row

/// Compact card showing health metrics for a single cluster.
private struct ClusterSnapshotRow: View {

    let snapshot: ClusterHealthSnapshot

    var body: some View {
        HStack(spacing: 12) {
            statusIndicator
            clusterInfo
            Spacer()
            if snapshot.isReachable {
                metricsGroup
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .windowBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.secondary.opacity(0.2), lineWidth: 1)
        )
    }

    private var statusIndicator: some View {
        Circle()
            .fill(
                snapshot.isReachable
                    ? (snapshot.isRBACLimited ? Color.orange : Color.green)
                    : Color.red
            )
            .frame(width: 10, height: 10)
    }

    private var clusterInfo: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(snapshot.contextName)
                .font(.body.weight(.medium))
                .lineLimit(1)
                .truncationMode(.middle)
            if let error = snapshot.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            } else if snapshot.isRBACLimited {
                Text(
                    "Limited: no access to \(snapshot.forbiddenResources.joined(separator: ", "))"
                )
                .font(.caption)
                .foregroundStyle(.orange)
                .lineLimit(2)
            } else {
                Text("\(snapshot.totalNamespaces) namespaces")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var metricsGroup: some View {
        HStack(spacing: 16) {
            metricBadge(label: "Pods", value: snapshot.totalPods, color: .blue)
            metricBadge(label: "Deploys", value: snapshot.totalDeployments, color: .purple)
            metricBadge(label: "Svc", value: snapshot.totalServices, color: .indigo)
        }
    }

    private func metricBadge(label: String, value: Int, color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(.system(.body, design: .monospaced).bold())
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(minWidth: 40)
    }
}

// MARK: - Preview

#Preview {
    let state = CrossClusterState()
    state.snapshots = [
        ClusterHealthSnapshot(
            contextName: "prod-us-east",
            isReachable: true, error: nil,
            totalPods: 42, runningPods: 40, failedPods: 2,
            totalDeployments: 12, healthyDeployments: 11, degradedDeployments: 1,
            totalServices: 8, totalNamespaces: 5, totalRestarts: 3, notReadyPods: 1,
            forbiddenResources: []
        ),
        ClusterHealthSnapshot(
            contextName: "staging-eu",
            isReachable: true, error: nil,
            totalPods: 18, runningPods: 18, failedPods: 0,
            totalDeployments: 6, healthyDeployments: 6, degradedDeployments: 0,
            totalServices: 4, totalNamespaces: 3, totalRestarts: 0, notReadyPods: 0,
            forbiddenResources: ["secrets", "configmaps"]
        ),
        ClusterHealthSnapshot(
            contextName: "dev-local",
            isReachable: false, error: "Connection refused",
            totalPods: 0, runningPods: 0, failedPods: 0,
            totalDeployments: 0, healthyDeployments: 0, degradedDeployments: 0,
            totalServices: 0, totalNamespaces: 0, totalRestarts: 0, notReadyPods: 0,
            forbiddenResources: []
        ),
    ]
    state.lastUpdated = Date()
    return CrossClusterDashboardView(crossClusterState: state, onRefresh: {})
        .frame(width: 700, height: 600)
}
