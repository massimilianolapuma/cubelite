import SwiftUI
import AppKit

@main
struct CubeliteApp: App {

    @State private var clusterState = ClusterState()
    @State private var appSettings = AppSettings()
    private let kubeconfigService: KubeconfigService
    private let kubeAPIService: KubeAPIService

    init() {
        let ks = KubeconfigService()
        self.kubeconfigService = ks
        self.kubeAPIService = KubeAPIService(kubeconfigService: ks)
    }

    var body: some Scene {
        WindowGroup("CubeLite") {
            MainView(kubeconfigService: kubeconfigService, kubeAPIService: kubeAPIService)
                .environment(clusterState)
                .environment(appSettings)
        }
        .defaultSize(width: 1200, height: 700)

        MenuBarExtra("CubeLite", systemImage: "square.3.layers.3d") {
            MenuBarContextView(
                clusterState: clusterState,
                kubeconfigService: kubeconfigService,
                onShowDetails: {
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }
            )
        }

        Settings {
            PreferencesView()
                .environment(appSettings)
        }
    }
}
