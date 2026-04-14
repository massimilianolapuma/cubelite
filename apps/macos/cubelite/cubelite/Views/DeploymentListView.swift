import SwiftUI

/// Table listing Kubernetes deployments for the selected context and namespace.
///
/// Columns: Name, Ready (ready/desired replicas), Namespace.
/// Selecting a row updates `selectedDeploymentID` for ``ResourceDetailView``.
struct DeploymentListView: View {

    @Environment(ClusterState.self) private var clusterState
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
    }

    // MARK: - States

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading deployments…")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 32))
                .foregroundStyle(.orange)
            Text("Failed to load deployments")
                .font(.headline)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 20)
        }
    }

    private var emptyView: some View {
        VStack(spacing: 10) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 36))
                .foregroundStyle(.quinary)
            Text("No deployments found")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text("There are no deployments in this namespace.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Table

    private var deploymentTable: some View {
        Table(clusterState.deployments, selection: $selectedDeploymentID) {
            TableColumn("") { dep in
                DeploymentStatusDot(ready: dep.readyReplicas, desired: dep.replicas)
            }
            .width(16)

            TableColumn("Name") { dep in
                Text(dep.name)
                    .font(.callout.monospaced())
                    .lineLimit(1)
            }
            .width(min: 120, ideal: 220)

            TableColumn("Namespace") { dep in
                Text(dep.namespace)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 120)

            TableColumn("Ready") { dep in
                replicasBadge(ready: dep.readyReplicas, desired: dep.replicas)
            }
            .width(ideal: 80)

        }
    }

    // MARK: - Helpers

    private func replicasBadge(ready: Int, desired: Int) -> some View {
        let allReady = ready == desired && desired > 0
        return HStack(spacing: 3) {
            Text("\(ready)/\(desired)")
                .font(.callout.monospacedDigit())
                .foregroundStyle(allReady ? .green : .orange)
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
    }

    private var color: Color {
        if desired == 0 { return .secondary }
        return ready == desired ? .green : .orange
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
