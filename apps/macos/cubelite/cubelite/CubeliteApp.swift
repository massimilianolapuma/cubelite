import SwiftUI
import AppKit

@main
struct CubeliteApp: App {

    @State private var clusterState = ClusterState()
    private let kubeconfigService = KubeconfigService()

    var body: some Scene {
        WindowGroup("CubeLite") {
            MainView(kubeconfigService: kubeconfigService)
                .environment(clusterState)
        }
        .defaultSize(width: 1000, height: 600)

        MenuBarExtra("CubeLite", systemImage: "square.3.layers.3d") {
            MenuBarContextView(
                clusterState: clusterState,
                kubeconfigService: kubeconfigService,
                onShowDetails: {
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }
            )
        }
    }
}
