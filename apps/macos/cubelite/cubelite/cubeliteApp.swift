import SwiftUI

@main
struct cubeliteApp: App {

    @State private var clusterState = ClusterState()
    private let kubeconfigService = KubeconfigService()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(clusterState)
                .task {
                    await loadKubeconfig()
                }
        }

        MenuBarExtra("CubeLite", systemImage: "square.3.layers.3d") {
            MenuBarContextView(
                clusterState: clusterState,
                kubeconfigService: kubeconfigService
            )
        }
    }

    // MARK: - Private

    @MainActor
    private func loadKubeconfig() async {
        clusterState.isLoading = true
        defer { clusterState.isLoading = false }
        do {
            let config = try await kubeconfigService.load()
            clusterState.noConfig = false
            clusterState.contexts = config.contexts
            clusterState.currentContext = config.currentContext
        } catch CubeliteError.fileNotFound {
            // No kubeconfig present — normal state for a fresh install.
            // The app remains functional; the user will be prompted to configure.
            clusterState.noConfig = true
        } catch {
            clusterState.errorMessage = error.localizedDescription
        }
    }
}
