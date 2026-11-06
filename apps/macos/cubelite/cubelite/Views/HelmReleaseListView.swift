import SwiftUI

/// Table listing Helm releases for the selected context and namespace.
///
/// Helm releases are discovered by querying Kubernetes Secrets labelled `owner=helm`.
/// Only the latest revision per release is shown.
/// Columns: Name, Namespace, Revision, Status, Age.
struct HelmReleaseListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Environment(ResourcePreferences.self) private var resourcePreferences

    /// Preferences default sort or this session's header sort (#497),
    /// grouped by namespace when that applies (#551).
    private var layout: ListLayout<HelmReleaseInfo> {
        resourcePreferences.layout(
            clusterState.helmReleases, for: .helmReleases, namespace: clusterState.selectedNamespace)
    }
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
        let layout = self.layout
        return Table(of: HelmReleaseInfo.self, selection: $selectedHelmReleaseID, sortOrder: resourcePreferences.sortOrder(for: "helm", of: HelmReleaseInfo.self)) {
            TableColumn("Name", value: \.sortKeyName) { release in
                Text(release.name)
                    .typeStyle(DesignTokens.Typography.data)
                    .lineLimit(1)
            }
            .width(min: 120, ideal: 200)

            if layout.showsNamespaceColumn { NamespaceColumn.column(HelmReleaseInfo.self) }

            TableColumn("Revision") { release in
                Text("\(release.revision)")
                    .typeStyle(DesignTokens.Typography.dataSm)
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 70)

            TableColumn("Status", value: \.sortKeyStatus) { release in
                HelmStatusBadge(status: release.status)
            }
            .width(min: 80, ideal: 110)

            TableColumn("Age", value: \.sortKeyAge) { release in
                Text(release.creationTimestamp.k8sAge)
                    .typeStyle(DesignTokens.Typography.dataSm)
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 60)
        } rows: {
            NamespaceTableRows(layout: layout, type: .helmReleases, preferences: resourcePreferences)
        }
        .unifiedTableBackground()
        .namespaceGroupKeys(layout, selection: selectedHelmReleaseID, preferences: resourcePreferences)
    }
}

// MARK: - Helm Status Badge

/// Color-coded badge for a Helm release status string.
private struct HelmStatusBadge: View {

    let status: String?

    var body: some View {
        Text(status ?? "unknown")
            .typeStyle(DesignTokens.Typography.caption.weighted(.medium))
            .foregroundStyle(badgeColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(badgeColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
    }

    private var badgeColor: Color {
        switch status?.lowercased() {
        case "deployed":
            return DesignTokens.statusOk
        case "failed":
            return DesignTokens.statusErr
        case let s where s?.hasPrefix("pending") == true:
            return DesignTokens.statusWarn
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
        .environment(ResourcePreferences())
        .frame(width: 700, height: 400)
}
