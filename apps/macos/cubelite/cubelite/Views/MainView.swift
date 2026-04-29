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
///
/// > Implementation is split across multiple files to keep this composition
/// > root focused. See `MainView+Toolbar.swift`, `MainView+Sidebar.swift`,
/// > `MainView+ContentColumn.swift`, `MainView+DetailArea.swift`,
/// > `MainView+ConfigLoader.swift`, `MainView+ResourceLoader.swift`, and
/// > `MainView+CrossClusterLoader.swift`. State property visibility is
/// > intentionally `internal` (no `private`) so cross-file extensions can
/// > observe and mutate it without behavioral changes.
struct MainView: View {

    let kubeconfigService: KubeconfigService
    let kubeAPIService: KubeAPIService

    @Environment(ClusterState.self) var clusterState
    @Environment(LogStore.self) var logStore
    @Environment(AppSettings.self) var appSettings

    // MARK: - Navigation State

    /// Controls sidebar column visibility, enabling native macOS sidebar collapse.
    @State var columnVisibility: NavigationSplitViewVisibility = .all
    /// Whether the sidebar is in icon-only collapsed mode.
    @State var isSidebarCollapsed: Bool = false

    // MARK: - Cross-Cluster State

    /// Observable state for the aggregated cross-cluster dashboard.
    @State var crossClusterState = CrossClusterState()
    /// Whether the "All Clusters" dashboard is currently shown.
    @State var showAllClusters = false

    // MARK: - Sidebar State

    /// The context (cluster) currently selected in the sidebar.
    @State var selectedContext: String?
    /// The (context, namespace) pair the user has selected in the sidebar.
    @State var sidebarSelection: SidebarSelection?
    /// Whether the namespaces disclosure group is expanded.
    @State var namespacesExpanded: Bool = true
    /// Whether namespaces for `selectedContext` are currently being fetched.
    @State var isLoadingNamespaces: Bool = false
    /// Namespace fetch error, if any.
    @State var namespaceError: String?
    /// Whether the Logs & Errors sheet is presented.
    @State var showingLogs = false
    /// Text for the inline namespace input field when namespace listing is forbidden.
    @State var manualNamespaceInput: String = ""

    // MARK: - Resource Browse State

    /// Active resource type in the content column.
    @State var selectedResourceType: ResourceType? = .dashboard
    /// Row ID of the selected pod.
    @State var selectedPodID: PodInfo.ID?
    /// Row ID of the selected deployment.
    @State var selectedDeploymentID: DeploymentInfo.ID?
    /// Row ID of the selected service.
    @State var selectedServiceID: ServiceInfo.ID?
    /// Row ID of the selected secret.
    @State var selectedSecretID: SecretInfo.ID?
    /// Row ID of the selected config map.
    @State var selectedConfigMapID: ConfigMapInfo.ID?
    /// Row ID of the selected ingress.
    @State var selectedIngressID: IngressInfo.ID?
    /// Row ID of the selected Helm release.
    @State var selectedHelmReleaseID: HelmReleaseInfo.ID?

    // MARK: - Auto-Reload

    /// Box holding the FSEvents-based kubeconfig watcher. Wrapped in a class
    /// so the `@State` value is stable across view re-evaluations and the
    /// watcher's `start`/`stop` lifecycle ties to view appearance.
    @State var watcherBox = WatcherBox()

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
        .task(id: appSettings.kubeconfigPaths) { startKubeconfigWatcher() }
        .onDisappear { watcherBox.watcher?.stop() }
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
}

// MARK: - Watcher Box

/// Reference-typed wrapper around `KubeconfigWatcher` so it can be stored in
/// `@State` without being copied. Holding the watcher in a class also lets the
/// FSEvents stream live across SwiftUI body re-evaluations.
@MainActor
final class WatcherBox {
    var watcher: KubeconfigWatcher?
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
        .environment(AppSettings())
}

#Preview("No kubeconfig") {
    let state = ClusterState()
    state.noConfig = true
    let ks = KubeconfigService()
    return MainView(kubeconfigService: ks, kubeAPIService: KubeAPIService(kubeconfigService: ks))
        .environment(state)
        .environment(LogStore())
        .environment(AppSettings())
}

