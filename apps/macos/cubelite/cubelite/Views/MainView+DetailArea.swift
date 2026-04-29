import SwiftUI

// MARK: - MainView Detail Area
//
// Right column router: dashboards, resource browser, and trailing detail
// panel selection. Extracted from `MainView` with no behavior change.
extension MainView {

    /// Inline error banner shown below the toolbar when unread errors exist.
    @ViewBuilder
    var errorBannerInset: some View {
        if logStore.unreadErrorCount > 0 {
            let message =
                clusterState.errorMessage
                ?? clusterState.resourceError
                ?? "Application errors occurred."
            ErrorBannerView(message: message) { showingLogs = true }
        }
    }

    @ViewBuilder
    var detailArea: some View {
        if showAllClusters {
            CrossClusterDashboardView(
                crossClusterState: crossClusterState,
                onRefresh: { await loadCrossClusterData() }
            )
        } else if let sel = sidebarSelection {
            switch selectedResourceType ?? .dashboard {
            case .dashboard:
                DashboardView()
            case .pods, .deployments, .services, .secrets, .configMaps, .ingresses, .helmReleases:
                resourceBrowserView(context: sel.context, namespace: sel.namespace)
            }
        } else {
            ContentUnavailableView {
                Label("Welcome to CubeLite", systemImage: "rectangle.3.group")
            } description: {
                Text("Select a cluster and namespace, then choose a resource type.")
            }
        }
    }

    // MARK: - Resource Browser

    private func resourceBrowserView(context: String, namespace: String?) -> some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                // Breadcrumb header
                HStack(spacing: 12) {
                    Label {
                        HStack(spacing: 4) {
                            Text(context)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Image(systemName: "chevron.compact.right")
                                .imageScale(.small)
                                .foregroundStyle(.tertiary)
                            Text(namespace ?? "All Namespaces")
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .foregroundStyle(namespace == nil ? .secondary : .primary)
                        }
                    } icon: {
                        Image(systemName: "server.rack")
                            .foregroundStyle(.secondary)
                    }
                    .font(.callout)
                    Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                Divider()
                // Resource list based on selected type
                switch selectedResourceType ?? .dashboard {
                case .pods:
                    PodListView(selectedPodID: $selectedPodID)
                        .onChange(of: selectedPodID) { _, _ in
                            selectedDeploymentID = nil
                            selectedServiceID = nil
                        }
                case .deployments:
                    DeploymentListView(selectedDeploymentID: $selectedDeploymentID)
                        .onChange(of: selectedDeploymentID) { _, _ in
                            selectedPodID = nil
                            selectedServiceID = nil
                        }
                case .services:
                    ServiceListView(selectedServiceID: $selectedServiceID)
                        .onChange(of: selectedServiceID) { _, _ in
                            selectedPodID = nil
                            selectedDeploymentID = nil
                        }
                case .secrets:
                    SecretListView(selectedSecretID: $selectedSecretID)
                        .onChange(of: selectedSecretID) { _, _ in
                            selectedPodID = nil
                            selectedDeploymentID = nil
                        }
                case .configMaps:
                    ConfigMapListView(selectedConfigMapID: $selectedConfigMapID)
                        .onChange(of: selectedConfigMapID) { _, _ in
                            selectedPodID = nil
                            selectedDeploymentID = nil
                        }
                case .ingresses:
                    IngressListView(selectedIngressID: $selectedIngressID)
                        .onChange(of: selectedIngressID) { _, _ in
                            selectedPodID = nil
                            selectedDeploymentID = nil
                        }
                case .helmReleases:
                    HelmReleaseListView(selectedHelmReleaseID: $selectedHelmReleaseID)
                        .onChange(of: selectedHelmReleaseID) { _, _ in
                            selectedPodID = nil
                            selectedDeploymentID = nil
                        }
                case .dashboard:
                    EmptyView()
                }
            }
            if let detail = currentSelectedResource {
                Divider()
                detailPanel(for: detail)
            }
        }
    }

    /// Selects between the narrow ``ResourceDetailView`` (pods) and the
    /// full ``DeploymentDetailView`` based on the selected resource.
    @ViewBuilder
    private func detailPanel(for resource: SelectedResource) -> some View {
        switch resource {
        case .deployment(let dep):
            DeploymentDetailView(deployment: dep)
                .frame(minWidth: 320, idealWidth: 460, maxWidth: 600)
        case .pod:
            ResourceDetailView(resource: resource)
                .frame(minWidth: 260, idealWidth: 340, maxWidth: 420)
        }
    }

    private var currentSelectedResource: SelectedResource? {
        if let podID = selectedPodID,
            let pod = clusterState.pods.first(where: { $0.id == podID })
        {
            return .pod(pod)
        }
        if let depID = selectedDeploymentID,
            let dep = clusterState.deployments.first(where: { $0.id == depID })
        {
            return .deployment(dep)
        }
        return nil
    }
}
