import SwiftUI

/// Table listing Helm releases for the selected context and namespace.
///
/// Helm releases are discovered by querying Kubernetes Secrets labelled `owner=helm`.
/// Only the latest revision per release is shown.
/// Columns: Name, Namespace, Revision, Status, Age.
struct HelmReleaseListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Binding var selectedHelmReleaseID: HelmReleaseInfo.ID?

    var body: some View {
        Group {
            if clusterState.isLoadingResources {
                loadingView
            } else if let error = clusterState.resourceError {
                errorView(error)
            } else if clusterState.helmReleases.isEmpty {
                emptyView
            } else {
                helmReleaseTable
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - States

    private var loadingView: some View {
        UnifiedLoadingState(label: "Loading Helm releases\u{2026}")
    }

    private func errorView(_ message: String) -> some View {
        UnifiedErrorState(title: "Failed to load Helm releases", message: message)
    }

    private var emptyView: some View {
        UnifiedEmptyState(message: "No Helm releases were detected in this namespace.")
    }

    // MARK: - Table

    private var helmReleaseTable: some View {
        Table(clusterState.helmReleases, selection: $selectedHelmReleaseID) {
            TableColumn("Name") { release in
                Text(release.name)
                    .font(.callout.monospaced())
                    .lineLimit(1)
            }
            .width(min: 120, ideal: 200)

            TableColumn("Namespace") { release in
                Text(release.namespace)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 120)

            TableColumn("Revision") { release in
                Text("\(release.revision)")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 70)

            TableColumn("Status") { release in
                HelmStatusBadge(status: release.status)
            }
            .width(min: 80, ideal: 110)

            TableColumn("Age") { release in
                Text(release.creationTimestamp.k8sAge)
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 60)
        }
        .unifiedTableBackground()
    }
}

// MARK: - Helm Status Badge

/// Color-coded badge for a Helm release status string.
private struct HelmStatusBadge: View {

    let status: String?

    var body: some View {
        Text(status ?? "unknown")
            .font(.caption.weight(.medium))
            .foregroundStyle(badgeColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(badgeColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
    }

    private var badgeColor: Color {
        switch status?.lowercased() {
        case "deployed":
            return .green
        case "failed":
            return .red
        case let s where s?.hasPrefix("pending") == true:
            return .orange
        default:
            return .secondary
        }
    }
}

// MARK: - Preview

#Preview("Helm Releases") {
    let state = ClusterState()
    state.helmReleases = [
        HelmReleaseInfo(
            name: "nginx-ingress", namespace: "ingress-nginx",
            chart: nil, appVersion: nil, revision: 3,
            status: "deployed", creationTimestamp: nil),
        HelmReleaseInfo(
            name: "cert-manager", namespace: "cert-manager",
            chart: nil, appVersion: nil, revision: 1,
            status: "deployed", creationTimestamp: nil),
        HelmReleaseInfo(
            name: "prometheus", namespace: "monitoring",
            chart: nil, appVersion: nil, revision: 2,
            status: "failed", creationTimestamp: nil),
        HelmReleaseInfo(
            name: "redis", namespace: "default",
            chart: nil, appVersion: nil, revision: 1,
            status: "pending-install", creationTimestamp: nil),
    ]
    return HelmReleaseListView(selectedHelmReleaseID: .constant(nil))
        .environment(state)
        .frame(width: 700, height: 400)
}
