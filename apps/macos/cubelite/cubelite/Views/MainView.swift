import SwiftUI

/// Primary application window — Lens-like Kubernetes IDE layout.
///
/// Uses a ``NavigationSplitView`` with a sidebar listing all kubeconfig contexts,
/// and a detail pane that shows information about the selected context.
/// Future iterations will replace the detail placeholder with resource views
/// (Pods, Deployments, Services, etc.).
///
/// Layout:
/// ```
/// ┌──────────────────────────────────────────────┐
/// │  Toolbar: CubeLite logo + status + reload     │
/// ├────────────┬─────────────────────────────────┤
/// │  Sidebar   │  Detail area                     │
/// │            │                                  │
/// │  Contexts: │  (context info / placeholder)   │
/// │  · ctx-1 ✓ │                                  │
/// │  · ctx-2   │  "Select a context to begin"    │
/// │  · ctx-3   │                                  │
/// └────────────┴─────────────────────────────────┘
/// ```
struct MainView: View {

    let kubeconfigService: KubeconfigService

    @Environment(ClusterState.self) private var clusterState
    @State private var selectedContext: String?

    var body: some View {
        NavigationSplitView(columnVisibility: .constant(.all)) {
            sidebar
                .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 320)
        } detail: {
            detailPane
        }
        .frame(minWidth: 800, minHeight: 500)
        .toolbar { toolbarContent }
        .task { await loadKubeconfig() }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            HStack(spacing: 6) {
                Image(systemName: "square.3.layers.3d")
                    .foregroundStyle(.tint)
                Text("CubeLite")
                    .font(.headline)
            }
        }
        ToolbarItem(placement: .primaryAction) {
            if clusterState.isLoading {
                ProgressView()
                    .controlSize(.small)
            } else {
                Button {
                    Task { await loadKubeconfig() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Reload kubeconfig")
            }
        }
        if let error = clusterState.errorMessage {
            ToolbarItem(placement: .status) {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .font(.caption)
                    .lineLimit(1)
            }
        }
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
        List(clusterState.contexts, id: \.self, selection: $selectedContext) { context in
            contextRow(for: context)
                .tag(context)
        }
        .navigationTitle("Contexts")
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
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .imageScale(.small)
            }
        }
        .contentShape(Rectangle())
    }

    // MARK: - Detail

    @ViewBuilder
    private var detailPane: some View {
        if let context = selectedContext {
            contextDetail(for: context)
        } else {
            emptyDetail
        }
    }

    private var emptyDetail: some View {
        VStack(spacing: 16) {
            Image(systemName: "square.3.layers.3d")
                .font(.system(size: 56))
                .foregroundStyle(.quinary)
            Text("Select a context to begin")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("Choose a Kubernetes context from the sidebar.")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func contextDetail(for context: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            contextDetailHeader(context)
            Divider()
            resourcePlaceholder
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .navigationTitle(context)
    }

    private func contextDetailHeader(_ context: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "server.rack")
                .font(.largeTitle)
                .foregroundStyle(.tint)

            VStack(alignment: .leading, spacing: 4) {
                Text(context)
                    .font(.title2.bold())
                if context == clusterState.currentContext {
                    Label("Active context", systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                }
            }

            Spacer()

            if context != clusterState.currentContext {
                Button("Switch to this context") {
                    Task { await switchContext(to: context) }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
            }
        }
        .padding(20)
    }

    private var resourcePlaceholder: some View {
        VStack(spacing: 12) {
            Image(systemName: "square.grid.2x2")
                .font(.system(size: 40))
                .foregroundStyle(.quinary)
            Text("Resource views coming soon")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text("Pods, Deployments, Services, ConfigMaps and more will appear here.")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Actions

    @MainActor
    private func loadKubeconfig() async {
        clusterState.isLoading = true
        defer { clusterState.isLoading = false }
        do {
            let config = try await kubeconfigService.load()
            clusterState.noConfig = false
            clusterState.contexts = config.contexts
            clusterState.currentContext = config.currentContext
            // Auto-select the active context on first load
            if selectedContext == nil {
                selectedContext = config.currentContext
            }
        } catch CubeliteError.fileNotFound {
            clusterState.noConfig = true
        } catch {
            clusterState.errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func switchContext(to context: String) async {
        do {
            var config = try await kubeconfigService.load()
            try await kubeconfigService.setActiveContext(context, in: &config)
            try await kubeconfigService.save(config)
            clusterState.currentContext = context
        } catch {
            clusterState.errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Preview

#Preview("With contexts") {
    let state = ClusterState()
    state.contexts = ["prod-us-east", "staging-eu", "dev-local"]
    state.currentContext = "staging-eu"
    return MainView(kubeconfigService: KubeconfigService())
        .environment(state)
}

#Preview("No kubeconfig") {
    let state = ClusterState()
    state.noConfig = true
    return MainView(kubeconfigService: KubeconfigService())
        .environment(state)
}
