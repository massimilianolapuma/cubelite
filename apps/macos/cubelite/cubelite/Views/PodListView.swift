import SwiftUI

/// Table listing pods for the selected context and namespace.
///
/// Columns: Status indicator, Name, Namespace, Restarts, Age.
/// Selecting a row updates the `selectedPodID` binding, which the parent
/// view uses to show ``ResourceDetailView``.
struct PodListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Binding var selectedPodID: PodInfo.ID?

    var body: some View {
        Group {
            if clusterState.isLoadingResources {
                loadingView
            } else if let error = clusterState.resourceError {
                errorView(error)
            } else if clusterState.pods.isEmpty {
                emptyView
            } else {
                podTable
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - States

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading pods…")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 32))
                .foregroundStyle(.orange)
            Text("Failed to load pods")
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
            Image(systemName: "cube.box")
                .font(.system(size: 36))
                .foregroundStyle(.quinary)
            Text("No pods found")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text("There are no pods in this namespace.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Table

    private var podTable: some View {
        Table(clusterState.pods, selection: $selectedPodID) {
            TableColumn("") { pod in
                PodStatusDot(phase: pod.phase)
            }
            .width(16)

            TableColumn("Name") { pod in
                Text(pod.name)
                    .font(.callout.monospaced())
                    .lineLimit(1)
            }
            .width(min: 120, ideal: 200)

            TableColumn("Namespace") { pod in
                Text(pod.namespace)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 120)

            TableColumn("Status") { pod in
                Text(pod.phase ?? "—")
                    .font(.callout)
                    .foregroundStyle(Color.podPhase(pod.phase))
            }
            .width(min: 60, ideal: 90)

            TableColumn("Restarts") { pod in
                Text("\(pod.restarts)")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(pod.restarts > 5 ? Color.orange : Color.secondary)
            }
            .width(ideal: 70)

            TableColumn("Age") { pod in
                Text(pod.creationTimestamp.k8sAge)
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 60)

            TableColumn("CPU") { pod in
                Text(pod.cpuRequest ?? "—")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 60)

            TableColumn("Memory") { pod in
                Text(pod.memoryRequest ?? "—")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 70)

            TableColumn("IP") { pod in
                Text(pod.podIP ?? "—")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 90)
        }
    }

}

// MARK: - Pod Status Dot

/// Coloured circle reflecting pod phase.
private struct PodStatusDot: View {
    let phase: String?

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .help(phase ?? "Unknown")
    }

    private var color: Color { Color.podPhase(phase) }
}

// MARK: - Preview

#Preview {
    @Previewable @State var selectedID: PodInfo.ID? = nil
    let state = ClusterState()
    state.pods = [
        PodInfo(name: "nginx-abc12", namespace: "default", phase: "Running",
                ready: true, restarts: 0, creationTimestamp: "2024-01-10T08:00:00Z"),
        PodInfo(name: "api-xyz99", namespace: "default", phase: "Running",
                ready: true, restarts: 2, creationTimestamp: nil),
        PodInfo(name: "worker-pending", namespace: "jobs", phase: "Pending",
                ready: false, restarts: 0, creationTimestamp: nil),
        PodInfo(name: "crashed-pod", namespace: "default", phase: "Failed",
                ready: false, restarts: 12, creationTimestamp: nil),
    ]
    return PodListView(selectedPodID: $selectedID)
        .environment(state)
        .frame(width: 700, height: 300)
}
