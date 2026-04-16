import SwiftUI

/// Primary application window — Lens-like Kubernetes IDE layout.
///
/// Uses a two-column ``NavigationSplitView``:
/// - **Sidebar** (left): kubeconfig contexts with expandable namespace browsers.
/// - **Detail** (right): resource browse pane (Pods / Deployments tabs) and,
///   when a resource is selected, a trailing detail panel.
///
/// Layout:
/// ```
/// ┌──────────────────────────────────────────────────────────┐
/// │  Toolbar: CubeLite logo + status + reload                │
/// ├──────────────────┬───────────────────────┬───────────────┤
/// │  Sidebar         │  Resource list        │  Detail panel │
/// │                  │                       │               │
/// │  ▼ my-cluster ✓  │  [Pods|Deployments]   │  name: …      │
/// │      All NS      │  ┌────────────────┐   │  namespace: … │
/// │    • default ←   │  │ nginx    Run   │   │  phase: …     │
/// │    • kube-sys    │  │ worker   Pend  │   │  restarts: …  │
/// │  ▶ dev-cluster   │  └────────────────┘   │               │
/// └──────────────────┴───────────────────────┴───────────────┘
/// ```
struct MainView: View {

    let kubeconfigService: KubeconfigService
    let kubeAPIService: KubeAPIService

    @Environment(ClusterState.self) private var clusterState
    @Environment(LogStore.self) private var logStore

    // MARK: - Sidebar State

    /// Which context is currently expanded to show its namespace list.
    @State private var expandedContext: String?
    /// The (context, namespace) pair the user has selected in the sidebar.
    @State private var sidebarSelection: SidebarSelection?
    /// Whether namespaces for `expandedContext` are currently being fetched.
    @State private var isLoadingNamespaces: Bool = false
    /// Namespace fetch error, if any.
    @State private var namespaceError: String?
    /// Whether the Logs & Errors sheet is presented.
    @State private var showingLogs = false

    // MARK: - Resource Browse State

    /// Active resource tab: Pods or Deployments.
    @State private var selectedResourceType: ResourceType = .pods
    /// Row ID of the selected pod.
    @State private var selectedPodID: PodInfo.ID?
    /// Row ID of the selected deployment.
    @State private var selectedDeploymentID: DeploymentInfo.ID?

    // MARK: - Body

    var body: some View {
        NavigationSplitView(columnVisibility: .constant(.all)) {
            sidebar
                .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 260)
        } detail: {
            VStack(spacing: 0) {
                errorBannerInset
                detailArea
            }
        }
        .frame(minWidth: 900, minHeight: 550)
        .toolbar { toolbarContent }
        .sheet(isPresented: $showingLogs) {
            LogsView()
                .environment(logStore)
        }
        .task { await loadKubeconfig() }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Image(systemName: "square.3.layers.3d")
                .foregroundStyle(.tint)
        }
        ToolbarItem(placement: .primaryAction) {
            Button {
                Task {
                    await loadKubeconfig()
                    if let ctx = expandedContext {
                        await loadNamespaces(for: ctx)
                    }
                    if let sel = sidebarSelection {
                        await loadResources(context: sel.context, namespace: sel.namespace)
                    }
                }
            } label: {
                if clusterState.isLoading || clusterState.isLoadingResources || isLoadingNamespaces {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .help("Refresh all")
            .disabled(clusterState.isLoading || clusterState.isLoadingResources)
        }
        if clusterState.clusterReachable == false {
            ToolbarItem(placement: .status) {
                Label("Cluster not reachable", systemImage: "network.slash")
                    .foregroundStyle(.secondary)
                    .font(.caption)
            }
        }
        ToolbarItem(placement: .primaryAction) {
            logsButton
        }
    }

    // MARK: - Banner & Logs Button

    /// Inline error banner shown below the toolbar when unread errors exist.
    @ViewBuilder
    private var errorBannerInset: some View {
        if logStore.unreadErrorCount > 0 {
            let message = clusterState.errorMessage
                ?? clusterState.resourceError
                ?? "Application errors occurred."
            ErrorBannerView(message: message) { showingLogs = true }
        }
    }

    /// Toolbar button that opens the Logs panel, with a badge for unread errors.
    private var logsButton: some View {
        Button { showingLogs = true } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "bell")
                if logStore.unreadErrorCount > 0 {
                    Text(logStore.unreadErrorCount < 100 ? "\(logStore.unreadErrorCount)" : "99+")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(2)
                        .background(Color.red, in: Circle())
                        .offset(x: 5, y: -5)
                }
            }
        }
        .help("View logs and errors")
    }

    // MARK: - Sidebar

    @ViewBuilder
    private var sidebar: some View {
        if clusterState.noConfig {
            noConfigSidebar
        } else {
            contextList
        }
    }

    private var noConfigSidebar: some View {
        VStack(spacing: 16) {
            Image(systemName: "doc.badge.questionmark")
                .font(.system(size: 36))
                .foregroundStyle(.secondary)
            Text("No kubeconfig found")
                .font(.headline)
                .multilineTextAlignment(.center)
            Text("Place your config at\n~/.kube/config\nor set KUBECONFIG.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("Contexts")
    }

    private var contextList: some View {
        List {
            ForEach(clusterState.contexts, id: \.self) { context in
                contextSection(context)
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Clusters")
    }

    // MARK: - Context DisclosureGroup

    private func contextSection(_ context: String) -> some View {
        DisclosureGroup(
            isExpanded: expandedBinding(for: context),
            content: {
                NamespaceListView(
                    contextName: context,
                    namespaces: context == expandedContext ? clusterState.namespaces : [],
                    isLoading: context == expandedContext && isLoadingNamespaces,
                    error: context == expandedContext ? namespaceError : nil,
                    selection: $sidebarSelection
                )
            },
            label: {
                contextRow(for: context)
            }
        )
    }

    private func expandedBinding(for context: String) -> Binding<Bool> {
        Binding(
            get: { expandedContext == context },
            set: { isExpanded in
                if isExpanded {
                    if expandedContext != context {
                        expandedContext = context
                        clusterState.namespaces = []
                        namespaceError = nil
                        Task { await loadNamespaces(for: context) }
                    }
                } else if expandedContext == context {
                    expandedContext = nil
                }
            }
        )
    }

    private func contextRow(for context: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "server.rack")
                .foregroundStyle(.secondary)
                .frame(width: 16)
            Text(context)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            if context == clusterState.currentContext {
                Circle()
                    .fill(clusterState.clusterReachable == true ? Color.green : Color.secondary)
                    .frame(width: 8, height: 8)
                    .help(clusterState.clusterReachable == true ? "Connected" : "Not reachable")
            }
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 6)
        .background(
            expandedContext == context
                ? Color.accentColor.opacity(0.12)
                : Color.clear,
            in: RoundedRectangle(cornerRadius: 5)
        )
        .contentShape(Rectangle())
    }

    // MARK: - Detail Area

    @ViewBuilder
    private var detailArea: some View {
        if let sel = sidebarSelection {
            resourceBrowserView(context: sel.context, namespace: sel.namespace)
                .task(id: selectionKey) { @MainActor in
                    selectedPodID = nil
                    selectedDeploymentID = nil
                    await loadResources(context: sel.context, namespace: sel.namespace)
                }
        } else if expandedContext != nil {
            selectNamespacePlaceholder
        } else {
            emptyDetail
        }
    }

    private var selectNamespacePlaceholder: some View {
        VStack(spacing: 12) {
            Image(systemName: "tray.2")
                .font(.system(size: 40))
                .foregroundStyle(.quinary)
            Text("Select a namespace")
                .font(.title2)
                .foregroundStyle(.primary)
            Text("Choose a namespace from the sidebar to browse resources.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyDetail: some View {
        VStack(spacing: 12) {
            Image(systemName: "square.3.layers.3d")
                .font(.system(size: 40))
                .foregroundStyle(.quinary)
            Text("Select a context to begin")
                .font(.title2)
                .foregroundStyle(.primary)
            Text("Expand a cluster in the sidebar to browse its namespaces.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Resource Browser

    private var selectionKey: String {
        guard let sel = sidebarSelection else { return "" }
        return "\(sel.context)/\(sel.namespace ?? "*")"
    }

    private func resourceBrowserView(context: String, namespace: String?) -> some View {
        HStack(spacing: 0) {
            // Left column: resource type picker + resource list
            VStack(spacing: 0) {
                resourceBrowserHeader(context: context, namespace: namespace)
                Divider()
                resourceList
            }

            // Right column: detail panel (shown when a resource is selected)
            if let detail = currentSelectedResource {
                Divider()
                detailPanel(for: detail)
            }
        }
    }

    /// Selects between the narrow ``ResourceDetailView`` (pods) and the
    /// full ``DeploymentDetailView`` based on the selected resource type.
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

    private func resourceBrowserHeader(context: String, namespace: String?) -> some View {
        HStack(spacing: 12) {
            Label {
                HStack(spacing: 4) {
                    Text(context)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let ns = namespace {
                        Image(systemName: "chevron.compact.right")
                            .imageScale(.small)
                            .foregroundStyle(.tertiary)
                        Text(ns)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    } else {
                        Image(systemName: "chevron.compact.right")
                            .imageScale(.small)
                            .foregroundStyle(.tertiary)
                        Text("All Namespaces")
                            .foregroundStyle(.secondary)
                    }
                }
            } icon: {
                Image(systemName: "server.rack")
                    .foregroundStyle(.secondary)
            }
            .font(.callout)

            Spacer()

            Picker("Resource type", selection: $selectedResourceType) {
                ForEach(ResourceType.allCases) { type in
                    Label(type.rawValue, systemImage: type.systemImage)
                        .tag(type)
                }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 220)
            .labelsHidden()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var resourceList: some View {
        switch selectedResourceType {
        case .pods:
            PodListView(selectedPodID: $selectedPodID)
                .onChange(of: selectedPodID) { _, _ in
                    selectedDeploymentID = nil
                }
        case .deployments:
            DeploymentListView(selectedDeploymentID: $selectedDeploymentID)
                .onChange(of: selectedDeploymentID) { _, _ in
                    selectedPodID = nil
                }
        }
    }

    private var currentSelectedResource: SelectedResource? {
        if let podID = selectedPodID,
           let pod = clusterState.pods.first(where: { $0.id == podID }) {
            return .pod(pod)
        }
        if let depID = selectedDeploymentID,
           let dep = clusterState.deployments.first(where: { $0.id == depID }) {
            return .deployment(dep)
        }
        return nil
    }

    // MARK: - Data Loading

    @MainActor
    private func loadKubeconfig() async {
        clusterState.isLoading = true
        clusterState.errorMessage = nil
        clusterState.clusterReachable = nil
        defer { clusterState.isLoading = false }
        do {
            let config = try await kubeconfigService.load()
            clusterState.noConfig = false
            clusterState.contexts = config.contexts
            clusterState.currentContext = config.currentContext
            // Auto-expand the active context on first load
            if expandedContext == nil, let active = config.currentContext {
                expandedContext = active
                Task { await loadNamespaces(for: active) }
            }
        } catch CubeliteError.fileNotFound {
            clusterState.noConfig = true
        } catch {
            clusterState.errorMessage = error.localizedDescription
            logStore.append(LogEntry(
                severity: .error,
                source: "Config",
                message: error.localizedDescription,
                details: String(describing: error),
                suggestedAction: "Check your kubeconfig file for syntax errors."
            ))
        }
    }

    @MainActor
    private func loadNamespaces(for context: String) async {
        isLoadingNamespaces = true
        namespaceError = nil
        defer { isLoadingNamespaces = false }
        do {
            let namespaces = try await kubeAPIService.listNamespaces(inContext: context)
            clusterState.namespaces = namespaces.sorted { $0.name < $1.name }
            clusterState.clusterReachable = true
        } catch CubeliteError.clusterUnreachable {
            clusterState.clusterReachable = false
            namespaceError = CubeliteError.clusterUnreachable.localizedDescription
            logStore.append(LogEntry(
                severity: .warning,
                source: "KubeAPI",
                message: CubeliteError.clusterUnreachable.localizedDescription,
                suggestedAction: "Check cluster connectivity and VPN/network settings."
            ))
        } catch {
            namespaceError = error.localizedDescription
            logStore.append(LogEntry(
                severity: .error,
                source: "KubeAPI",
                message: error.localizedDescription,
                details: String(describing: error)
            ))
        }
    }

    @MainActor
    private func loadResources(context: String, namespace: String?) async {
        clusterState.isLoadingResources = true
        clusterState.resourceError = nil
        defer { clusterState.isLoadingResources = false }
        do {
            let pods = try await kubeAPIService.listPods(
                namespace: namespace,
                inContext: context
            )
            clusterState.pods = pods
            let deployments = try await kubeAPIService.listDeployments(
                namespace: namespace,
                inContext: context
            )
            clusterState.deployments = deployments
            clusterState.selectedNamespace = namespace
            clusterState.clusterReachable = true
        } catch CubeliteError.clusterUnreachable {
            clusterState.clusterReachable = false
            clusterState.resourceError = CubeliteError.clusterUnreachable.localizedDescription
            logStore.append(LogEntry(
                severity: .warning,
                source: "KubeAPI",
                message: CubeliteError.clusterUnreachable.localizedDescription,
                suggestedAction: "Check cluster connectivity and VPN/network settings."
            ))
        } catch {
            clusterState.resourceError = error.localizedDescription
            logStore.append(LogEntry(
                severity: .error,
                source: "KubeAPI",
                message: error.localizedDescription,
                details: String(describing: error)
            ))
        }
    }
}

// MARK: - Preview

#Preview("With contexts") {
    let state = ClusterState()
    state.contexts = ["prod-us-east", "staging-eu", "dev-local"]
    state.currentContext = "staging-eu"
    state.namespaces = [
        NamespaceInfo(name: "default", phase: "Active"),
        NamespaceInfo(name: "kube-system", phase: "Active"),
    ]
    state.pods = [
        PodInfo(name: "nginx-abc", namespace: "default", phase: "Running",
                ready: true, restarts: 0, creationTimestamp: nil),
        PodInfo(name: "api-xyz", namespace: "default", phase: "Pending",
                ready: false, restarts: 1, creationTimestamp: nil),
    ]
    let ks = KubeconfigService()
    return MainView(kubeconfigService: ks, kubeAPIService: KubeAPIService(kubeconfigService: ks))
        .environment(state)
        .environment(LogStore())
}

#Preview("No kubeconfig") {
    let state = ClusterState()
    state.noConfig = true
    let ks = KubeconfigService()
    return MainView(kubeconfigService: ks, kubeAPIService: KubeAPIService(kubeconfigService: ks))
        .environment(state)
        .environment(LogStore())
}
