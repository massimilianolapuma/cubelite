import AppKit
import SwiftUI

/// Primary application window — three-column Apple Notes-pattern layout.
///
/// Uses a three-column ``NavigationSplitView``:
/// - **Sidebar** (left): kubeconfig contexts (cluster list).
/// - **Content** (middle): namespace browser for the selected cluster.
/// - **Detail** (right): resource browse pane (Pods / Deployments tabs) and,
///   when a resource is selected, a trailing detail panel.
///
/// Layout:
/// ```
/// ┌──────────────────────────────────────────────────────────┐
/// │  Toolbar: CubeLite logo + status + reload                │
/// ├──────────────┬───────────────────┬───────────────────────┤
/// │  Sidebar     │  Content          │  Detail               │
/// │              │                   │                       │
/// │  my-cluster  │  All Namespaces   │  [Pods|Deployments]   │
/// │  dev-cluster │  • default ←      │  ┌────────────────┐   │
/// │              │  • kube-system    │  │ nginx    Run   │   │
/// │              │  • monitoring     │  │ worker   Pend  │   │
/// │              │                   │  └────────────────┘   │
/// └──────────────┴───────────────────┴───────────────────────┘
/// ```
struct MainView: View {

    let kubeconfigService: KubeconfigService
    let kubeAPIService: KubeAPIService

    @Environment(ClusterState.self) private var clusterState
    @Environment(LogStore.self) private var logStore

    // MARK: - Navigation State

    /// Controls sidebar column visibility, enabling native macOS sidebar collapse.
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    /// Whether the sidebar is in icon-only collapsed mode.
    @State private var isSidebarCollapsed: Bool = false

    // MARK: - Cross-Cluster State

    /// Observable state for the aggregated cross-cluster dashboard.
    @State private var crossClusterState = CrossClusterState()
    /// Whether the "All Clusters" dashboard is currently shown.
    @State private var showAllClusters = false

    // MARK: - Sidebar State

    /// The context (cluster) currently selected in the sidebar.
    @State private var selectedContext: String?
    /// The (context, namespace) pair the user has selected in the sidebar.
    @State private var sidebarSelection: SidebarSelection?
    /// Whether the namespaces disclosure group is expanded.
    @State private var namespacesExpanded: Bool = true
    /// Whether namespaces for `selectedContext` are currently being fetched.
    @State private var isLoadingNamespaces: Bool = false
    /// Namespace fetch error, if any.
    @State private var namespaceError: String?
    /// Whether the Logs & Errors sheet is presented.
    @State private var showingLogs = false
    /// Text for the inline namespace input field when namespace listing is forbidden.
    @State private var manualNamespaceInput: String = ""

    // MARK: - Resource Browse State

    /// Active resource type in the content column.
    @State private var selectedResourceType: ResourceType? = .dashboard
    /// Row ID of the selected pod.
    @State private var selectedPodID: PodInfo.ID?
    /// Row ID of the selected deployment.
    @State private var selectedDeploymentID: DeploymentInfo.ID?
    /// Row ID of the selected service.
    @State private var selectedServiceID: ServiceInfo.ID?
    /// Row ID of the selected secret.
    @State private var selectedSecretID: SecretInfo.ID?
    /// Row ID of the selected config map.
    @State private var selectedConfigMapID: ConfigMapInfo.ID?
    /// Row ID of the selected ingress.
    @State private var selectedIngressID: IngressInfo.ID?
    /// Row ID of the selected Helm release.
    @State private var selectedHelmReleaseID: HelmReleaseInfo.ID?

    // MARK: - Body

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar
                .navigationSplitViewColumnWidth(
                    min: 52,
                    ideal: isSidebarCollapsed ? 52 : 240,
                    max: isSidebarCollapsed ? 60 : 300
                )
        } content: {
            resourceTypeList
                .navigationTitle("Resources")
                .navigationSplitViewColumnWidth(min: 160, ideal: 180, max: 220)
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
        .onChange(of: selectedContext) { _, newValue in
            // Only exit All Clusters mode when selecting a specific context.
            // When All Clusters sets selectedContext = nil, preserve showAllClusters.
            if newValue != nil {
                showAllClusters = false
            }
            clusterState.namespaces = []
            namespaceError = nil
            sidebarSelection = nil
            clusterState.pods = []
            clusterState.deployments = []
            clusterState.namespacePodCounts = [:]
            if let context = newValue {
                Task {
                    await loadNamespaces(for: context)
                    // Use the kubeconfig default namespace for this context, if set.
                    // This avoids cluster-scope requests that fail with 403 when RBAC
                    // only grants namespace-scoped access.
                    let defaultNS = await resolveDefaultNamespace(for: context)
                    sidebarSelection = SidebarSelection(context: context, namespace: defaultNS)
                }
            }
        }
        .onChange(of: sidebarSelection) { _, newValue in
            clusterState.pods = []
            clusterState.deployments = []
            clusterState.services = []
            clusterState.secrets = []
            clusterState.configMaps = []
            clusterState.ingresses = []
            clusterState.helmReleases = []
            selectedPodID = nil
            selectedDeploymentID = nil
            selectedServiceID = nil
            selectedSecretID = nil
            selectedConfigMapID = nil
            selectedIngressID = nil
            selectedHelmReleaseID = nil
            if let sel = newValue {
                Task { await loadResources(context: sel.context, namespace: sel.namespace) }
            }
        }
        .onChange(of: columnVisibility) { _, newValue in
            if newValue != .all {
                columnVisibility = .all
                isSidebarCollapsed.toggle()
            }
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
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
            let message =
                clusterState.errorMessage
                ?? clusterState.resourceError
                ?? "Application errors occurred."
            ErrorBannerView(message: message) { showingLogs = true }
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
        } else if isSidebarCollapsed {
            compactSidebar
        } else {
            sidebarContent
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
        .navigationTitle("CubeLite")
    }

    /// Narrow icon-only sidebar strip shown when the sidebar is in collapsed mode.
    private var compactSidebar: some View {
        VStack(spacing: 4) {
            Button {
                showAllClusters = true
                selectedContext = nil
                sidebarSelection = nil
                Task { await loadCrossClusterData() }
            } label: {
                Image(systemName: "rectangle.stack")
                    .font(.system(size: 16))
                    .foregroundStyle(showAllClusters ? Color.accentColor : .secondary)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(
                showAllClusters
                    ? RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.15))
                    : nil
            )
            .help("All Clusters")
            .padding(.top, 8)

            Divider()
                .padding(.vertical, 4)

            ForEach(clusterState.contexts, id: \.self) { context in
                Button {
                    showAllClusters = false
                    selectedContext = context
                } label: {
                    Image(systemName: "server.rack")
                        .font(.system(size: 14))
                        .foregroundStyle(
                            (context == selectedContext && !showAllClusters)
                                ? Color.accentColor : .secondary
                        )
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(
                    (context == selectedContext && !showAllClusters)
                        ? RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.15))
                        : nil
                )
                .help(context)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 8)
        .navigationTitle("CubeLite")
    }

    private var sidebarContent: some View {
        List {
            allClustersRow
            ForEach(clusterState.contexts, id: \.self) { context in
                Section {
                    // "All Namespaces" row — tap selects context and toggles namespace list
                    sidebarNamespaceRow(
                        context: context,
                        namespace: nil,
                        label: "All Namespaces",
                        icon: "square.grid.2x2",
                        count: context == selectedContext
                            ? clusterState.namespacePodCounts.values.reduce(0, +)
                            : nil,
                        additionalAction: {
                            withAnimation(.easeInOut(duration: 0.2)) { namespacesExpanded.toggle() }
                        }
                    )
                    .fontWeight(.medium)

                    // Collapsible namespace children under All Namespaces
                    if context == selectedContext, namespacesExpanded {
                        if isLoadingNamespaces {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text("Loading\u{2026}")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.leading, 8)
                            .padding(.vertical, 2)
                        } else if let error = namespaceError {
                            Label(error, systemImage: "exclamationmark.triangle")
                                .font(.subheadline)
                                .foregroundStyle(.orange)
                                .lineLimit(2)
                                .padding(.leading, 8)
                            // Show existing fallback namespaces if any
                            ForEach(clusterState.namespaces) { ns in
                                sidebarNamespaceRow(
                                    context: context,
                                    namespace: ns.name,
                                    label: ns.name,
                                    icon: "folder",
                                    count: clusterState.namespacePodCounts[ns.name]
                                )
                                .padding(.leading, 8)
                            }
                            // Inline namespace entry
                            HStack(spacing: 4) {
                                TextField("Add namespace…", text: $manualNamespaceInput)
                                    .textFieldStyle(.roundedBorder)
                                    .font(.subheadline)
                                    .onSubmit {
                                        addManualNamespace(for: context)
                                    }
                                Button {
                                    addManualNamespace(for: context)
                                } label: {
                                    Image(systemName: "plus.circle.fill")
                                        .foregroundStyle(.secondary)
                                }
                                .buttonStyle(.borderless)
                                .disabled(manualNamespaceInput.trimmingCharacters(
                                    in: .whitespaces
                                ).isEmpty)
                            }
                            .padding(.leading, 8)
                            .padding(.trailing, 4)
                        } else {
                            ForEach(clusterState.namespaces) { ns in
                                sidebarNamespaceRow(
                                    context: context,
                                    namespace: ns.name,
                                    label: ns.name,
                                    icon: "folder",
                                    count: clusterState.namespacePodCounts[ns.name]
                                )
                                .padding(.leading, 8)
                            }
                        }
                    }
                } header: {
                    clusterHeader(for: context)
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("CubeLite")
    }

    /// Sidebar row for the aggregated cross-cluster dashboard.
    private var allClustersRow: some View {
        Button {
            showAllClusters = true
            selectedContext = nil
            sidebarSelection = nil
            Task { await loadCrossClusterData() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.stack")
                    .font(.system(size: 14))
                    .frame(width: 20, height: 20)
                    .foregroundStyle(showAllClusters ? Color.accentColor : .secondary)
                Text("All Clusters")
                    .font(.body)
                Spacer(minLength: 0)
                if !clusterState.contexts.isEmpty {
                    Text("\(clusterState.contexts.count)")
                        .font(.caption)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.6), in: Capsule())
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            showAllClusters
                ? RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.15))
                : nil
        )
    }

    private func clusterHeader(for context: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "server.rack")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(context == selectedContext ? Color.accentColor : .secondary)
            Text(context)
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.middle)
            if context == clusterState.currentContext {
                Circle()
                    .fill(clusterState.clusterReachable == true ? Color.green : Color.secondary)
                    .frame(width: 8, height: 8)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            selectedContext = context
        }
    }

    private func sidebarNamespaceRow(
        context: String,
        namespace: String?,
        label: String,
        icon: String,
        count: Int?,
        additionalAction: (() -> Void)? = nil
    ) -> some View {
        let item = SidebarSelection(context: context, namespace: namespace)
        let isSelected = sidebarSelection == item

        return Button {
            selectedContext = context
            sidebarSelection = item
            additionalAction?()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .frame(width: 20, height: 20)
                    .foregroundStyle(isSelected ? Color.accentColor : .secondary)
                Text(label)
                    .font(.body)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                if additionalAction != nil, context == selectedContext {
                    Image(systemName: namespacesExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .animation(.easeInOut(duration: 0.2), value: namespacesExpanded)
                }
                if let count, count > 0 {
                    Text("\(count)")
                        .font(.caption)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.6), in: Capsule())
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            isSelected
                ? RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.15))
                : nil
        )
        .foregroundStyle(isSelected ? Color.primary : .primary)
    }

    // MARK: - Content Column

    /// Middle column: resource type browser for the selected cluster/namespace.
    @ViewBuilder
    private var resourceTypeList: some View {
        if showAllClusters {
            ContentUnavailableView {
                Label("All Clusters", systemImage: "rectangle.stack")
            } description: {
                Text("Select a cluster to browse its resources.")
            }
        } else if sidebarSelection != nil {
            List(selection: $selectedResourceType) {
                ForEach(ResourceType.allCases) { type in
                    Label(type.rawValue, systemImage: type.systemImage)
                        .font(.body)
                        .tag(type)
                }
            }
            .listStyle(.sidebar)
        } else {
            ContentUnavailableView {
                Label("Select a Namespace", systemImage: "tray.2")
            } description: {
                Text("Choose a cluster and namespace from the sidebar.")
            }
        }
    }

    // MARK: - Detail Area

    @ViewBuilder
    private var detailArea: some View {
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

    // MARK: - Data Loading

    @MainActor
    private func loadCrossClusterData() async {
        crossClusterState.isLoading = true
        defer { crossClusterState.isLoading = false }
        let contextNames = clusterState.contexts
        let apiService = kubeAPIService
        var results: [ClusterHealthSnapshot] = []
        await withTaskGroup(of: ClusterHealthSnapshot.self) { group in
            for ctx in contextNames {
                group.addTask {
                    var pods: [PodInfo] = []
                    var deployments: [DeploymentInfo] = []
                    var services: [ServiceInfo] = []
                    var namespaces: [NamespaceInfo] = []
                    var forbidden: [String] = []
                    var anySucceeded = false
                    var fatalErr: String?

                    // Pods
                    do {
                        pods = try await apiService.listPods(inContext: ctx)
                        anySucceeded = true
                    } catch CubeliteError.forbidden {
                        forbidden.append("pods")
                    } catch {
                        fatalErr = error.localizedDescription
                    }

                    // Deployments
                    if fatalErr == nil {
                        do {
                            deployments = try await apiService.listDeployments(inContext: ctx)
                            anySucceeded = true
                        } catch CubeliteError.forbidden {
                            forbidden.append("deployments")
                        } catch {
                            if fatalErr == nil { fatalErr = error.localizedDescription }
                        }
                    }

                    // Services
                    if fatalErr == nil {
                        do {
                            services = try await apiService.listServices(inContext: ctx)
                            anySucceeded = true
                        } catch CubeliteError.forbidden {
                            forbidden.append("services")
                        } catch {
                            if fatalErr == nil { fatalErr = error.localizedDescription }
                        }
                    }

                    // Namespaces
                    if fatalErr == nil {
                        do {
                            namespaces = try await apiService.listNamespaces(inContext: ctx)
                            anySucceeded = true
                        } catch CubeliteError.forbidden {
                            forbidden.append("namespaces")
                        } catch {
                            if fatalErr == nil { fatalErr = error.localizedDescription }
                        }
                    }

                    let isReachable = anySucceeded || (fatalErr == nil && !forbidden.isEmpty)
                    return ClusterHealthSnapshot(
                        contextName: ctx,
                        isReachable: isReachable,
                        error: fatalErr,
                        totalPods: pods.count,
                        runningPods: pods.filter { $0.phase == "Running" }.count,
                        failedPods: pods.filter { $0.phase == "Failed" }.count,
                        totalDeployments: deployments.count,
                        healthyDeployments: deployments.filter {
                            $0.readyReplicas == $0.replicas
                        }.count,
                        degradedDeployments: deployments.filter {
                            $0.readyReplicas != $0.replicas
                        }.count,
                        totalServices: services.count,
                        totalNamespaces: namespaces.count,
                        totalRestarts: pods.reduce(0) { $0 + $1.restarts },
                        notReadyPods: pods.filter { !$0.ready }.count,
                        forbiddenResources: forbidden
                    )
                }
            }
            for await snapshot in group {
                results.append(snapshot)
            }
        }
        crossClusterState.snapshots = results.sorted { $0.contextName < $1.contextName }
        crossClusterState.lastUpdated = Date()
    }

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
            // Auto-select the active context on first load;
            // onChange(of: selectedContext) will trigger namespace loading.
            // Guard: skip auto-selection when All Clusters view is active.
            if selectedContext == nil, !showAllClusters, let active = config.currentContext {
                selectedContext = active
            }
        } catch CubeliteError.fileNotFound {
            clusterState.noConfig = true
        } catch {
            clusterState.errorMessage = error.localizedDescription
            logStore.append(
                LogEntry(
                    severity: .error,
                    source: "Config",
                    message: error.localizedDescription,
                    details: String(describing: error),
                    suggestedAction: "Check your kubeconfig file for syntax errors."
                ))
        }
    }

    /// Looks up the default namespace for a context from the kubeconfig.
    ///
    /// Returns `nil` if the context has no namespace set, allowing cluster-scope queries.
    private func resolveDefaultNamespace(for context: String) async -> String? {
        guard let config = try? await kubeconfigService.load() else { return nil }
        return config.defaultNamespace(for: context)
    }

    /// Adds a user-entered namespace to the sidebar for RBAC-restricted clusters.
    @MainActor
    private func addManualNamespace(for context: String) {
        let ns = manualNamespaceInput.trimmingCharacters(in: .whitespaces)
        guard !ns.isEmpty else { return }
        // Avoid duplicates
        guard !clusterState.namespaces.contains(where: { $0.name == ns }) else {
            manualNamespaceInput = ""
            return
        }
        clusterState.namespaces.append(NamespaceInfo(name: ns, phase: nil))
        // Persist to AppSettings
        var settings = AppSettings()
        var saved = settings.contextNamespaces[context] ?? []
        if !saved.contains(ns) {
            saved.append(ns)
            settings.contextNamespaces[context] = saved
        }
        manualNamespaceInput = ""
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
            logStore.append(
                LogEntry(
                    severity: .warning,
                    source: "KubeAPI",
                    message: CubeliteError.clusterUnreachable.localizedDescription,
                    suggestedAction: "Check cluster connectivity and VPN/network settings."
                ))
        } catch let cubeliteError as CubeliteError {
            if case .tlsError = cubeliteError { clusterState.clusterReachable = false }
            // When namespace listing is forbidden, build a fallback list from:
            // 1. User-configured namespaces for this context (AppSettings)
            // 2. Kubeconfig default namespace
            // 3. Empty list (user can manually enter a namespace in the sidebar)
            if case .forbidden = cubeliteError {
                clusterState.clusterReachable = true
                var fallbackNamespaces: [NamespaceInfo] = []
                let settings = AppSettings()
                if let saved = settings.contextNamespaces[context], !saved.isEmpty {
                    fallbackNamespaces = saved.map { NamespaceInfo(name: $0, phase: nil) }
                } else {
                    let defaultNS = await resolveDefaultNamespace(for: context)
                    if let ns = defaultNS {
                        fallbackNamespaces = [NamespaceInfo(name: ns, phase: nil)]
                    }
                }
                clusterState.namespaces = fallbackNamespaces
            }
            namespaceError = cubeliteError.localizedDescription
            let suggestedAction: String? = {
                if case .forbidden = cubeliteError {
                    return
                        "Your RBAC role cannot list namespaces. Set a default namespace in kubeconfig: kubectl config set-context \(context) --namespace=<name>"
                }
                return nil
            }()
            logStore.append(
                LogEntry(
                    severity: .error,
                    source: "KubeAPI",
                    message: cubeliteError.localizedDescription,
                    details: String(describing: cubeliteError),
                    suggestedAction: suggestedAction
                ))
        } catch {
            namespaceError = error.localizedDescription
            logStore.append(
                LogEntry(
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
        clusterState.forbiddenResources = []
        defer { clusterState.isLoadingResources = false }

        var forbidden: Set<String> = []
        var fatalError: (any Error)?

        // Helper: attempt a single resource fetch, returning nil on 403.
        func fetchResource<T: Sendable>(
            _ kind: String,
            _ fetch: @Sendable () async throws -> [T]
        ) async -> [T]? {
            do {
                return try await fetch()
            } catch CubeliteError.forbidden {
                forbidden.insert(kind)
                logStore.append(
                    LogEntry(
                        severity: .warning,
                        source: "KubeAPI",
                        message: "Access denied for \(kind)",
                        suggestedAction:
                            "Your RBAC role lacks permissions. Select a specific namespace in the sidebar."
                    ))
                return nil
            } catch CubeliteError.clusterUnreachable {
                fatalError = CubeliteError.clusterUnreachable
                return nil
            } catch let tlsErr as CubeliteError where {
                if case .tlsError = tlsErr { return true }; return false
            }() {
                fatalError = tlsErr
                return nil
            } catch {
                fatalError = error
                return nil
            }
        }

        // Pods
        if let pods = await fetchResource("pods", {
            try await kubeAPIService.listPods(namespace: namespace, inContext: context)
        }) {
            clusterState.pods = pods
            if namespace == nil {
                clusterState.namespacePodCounts = Dictionary(
                    grouping: pods, by: { $0.namespace }
                ).mapValues { $0.count }
            }
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        // Deployments
        if let deployments = await fetchResource("deployments", {
            try await kubeAPIService.listDeployments(namespace: namespace, inContext: context)
        }) {
            clusterState.deployments = deployments
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        // Services
        if let services = await fetchResource("services", {
            try await kubeAPIService.listServices(namespace: namespace, inContext: context)
        }) {
            clusterState.services = services
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        // Secrets
        if let secrets = await fetchResource("secrets", {
            try await kubeAPIService.listSecrets(namespace: namespace, inContext: context)
        }) {
            clusterState.secrets = secrets
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        // ConfigMaps
        if let configMaps = await fetchResource("configmaps", {
            try await kubeAPIService.listConfigMaps(namespace: namespace, inContext: context)
        }) {
            clusterState.configMaps = configMaps
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        // Ingresses
        if let ingresses = await fetchResource("ingresses", {
            try await kubeAPIService.listIngresses(namespace: namespace, inContext: context)
        }) {
            clusterState.ingresses = ingresses
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        // Helm Releases
        if let helmReleases = await fetchResource("helmreleases", {
            try await kubeAPIService.listHelmReleases(namespace: namespace, inContext: context)
        }) {
            clusterState.helmReleases = helmReleases
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        finishResourceLoad(fatalError: nil, forbidden: forbidden, namespace: namespace)
    }

    /// Finalises resource load state after all individual fetches complete.
    @MainActor
    private func finishResourceLoad(
        fatalError: (any Error)?,
        forbidden: Set<String>,
        namespace: String?
    ) {
        clusterState.forbiddenResources = forbidden
        clusterState.selectedNamespace = namespace

        if let error = fatalError {
            if error is CubeliteError {
                let cubeliteError = error as! CubeliteError
                if case .clusterUnreachable = cubeliteError {
                    clusterState.clusterReachable = false
                    clusterState.resourceError = cubeliteError.localizedDescription
                    logStore.append(
                        LogEntry(
                            severity: .warning,
                            source: "KubeAPI",
                            message: cubeliteError.localizedDescription,
                            suggestedAction: "Check cluster connectivity and VPN/network settings."
                        ))
                } else {
                    if case .tlsError = cubeliteError { clusterState.clusterReachable = false }
                    clusterState.resourceError = cubeliteError.localizedDescription
                    logStore.append(
                        LogEntry(
                            severity: .error,
                            source: "KubeAPI",
                            message: cubeliteError.localizedDescription,
                            details: String(describing: cubeliteError)
                        ))
                }
            } else {
                clusterState.resourceError = error.localizedDescription
                logStore.append(
                    LogEntry(
                        severity: .error,
                        source: "KubeAPI",
                        message: error.localizedDescription,
                        details: String(describing: error)
                    ))
            }
        } else {
            clusterState.clusterReachable = true
            if !forbidden.isEmpty {
                clusterState.resourceError =
                    "Limited access: cannot read \(forbidden.sorted().joined(separator: ", "))"
            }
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
        PodInfo(
            name: "nginx-abc", namespace: "default", phase: "Running",
            ready: true, restarts: 0, creationTimestamp: nil),
        PodInfo(
            name: "api-xyz", namespace: "default", phase: "Pending",
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
