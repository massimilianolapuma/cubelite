import SwiftUI

// MARK: - MainView Toolbar
//
// Toolbar content and the inline logs button. Extracted from `MainView` to
// keep the composition root focused on layout wiring. No behavior change.
extension MainView {

    @ToolbarContentBuilder
    var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                Task {
                    await loadKubeconfig()
                    if showAllClusters {
                        await loadCrossClusterData()
                    } else {
                        if let ctx = selectedContext {
                            await loadNamespaces(for: ctx)
                        }
                        if let sel = sidebarSelection {
                            await loadResources(context: sel.context, namespace: sel.namespace)
                        }
                    }
                }
            } label: {
                if clusterState.isLoading || clusterState.isLoadingResources || isLoadingNamespaces
                {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .help("Refresh all")
            .disabled(clusterState.isLoading || clusterState.isLoadingResources)
            .accessibilityLabel("Refresh all")
            .accessibilityIdentifier("toolbar.refresh")
        }
        if clusterState.clusterReachable == false {
            ToolbarItem(placement: .status) {
                Label("Cluster not reachable", systemImage: "network.slash")
                    .foregroundStyle(.secondary)
                    .typeStyle(DesignTokens.Typography.caption)
            }
        }
        ToolbarItem(placement: .primaryAction) {
            logsButton
        }
    }

    /// Toolbar button that opens the Logs panel, with a badge for unread errors.
    private var logsButton: some View {
        Button {
            showingLogs = true
        } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "bell")
                if logStore.unreadErrorCount > 0 {
                    Text(logStore.unreadErrorCount < 100 ? "\(logStore.unreadErrorCount)" : "99+")
                        .iconSize(DesignTokens.icon2xs, weight: .bold)
                        .foregroundStyle(.white)
                        .padding(2)
                        .background(DesignTokens.statusErr, in: Circle())
                        .offset(x: 5, y: -5)
                        .accessibilityHidden(true)
                }
            }
        }
        .help("View logs and errors")
        .accessibilityLabel("View logs and errors")
        .accessibilityValue(logStore.unreadErrorCount > 0 ? "\(logStore.unreadErrorCount) unread" : "")
        .accessibilityIdentifier("toolbar.logs")
    }
}
