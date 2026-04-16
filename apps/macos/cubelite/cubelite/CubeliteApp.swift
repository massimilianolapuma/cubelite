import SwiftUI
import AppKit

@main
struct CubeliteApp: App {

    @State private var clusterState = ClusterState()
    @State private var appSettings = AppSettings()
    private let kubeconfigService: KubeconfigService
    private let kubeAPIService: KubeAPIService

    /// Persists whether the user has completed the first-launch onboarding flow.
    @AppStorage("hasCompletedOnboarding") private var hasCompletedOnboarding = false
    @State private var logStore = LogStore()

    init() {
        let ks = KubeconfigService()
        self.kubeconfigService = ks
        self.kubeAPIService = KubeAPIService(kubeconfigService: ks)
    }

    var body: some Scene {
        WindowGroup("CubeLite") {
            if hasCompletedOnboarding {
                MainView(kubeconfigService: kubeconfigService, kubeAPIService: kubeAPIService)
                    .environment(clusterState)
                    .environment(appSettings)
                    .environment(logStore)
            } else {
                FirstLaunchView(
                    kubeconfigService: kubeconfigService,
                    onComplete: { hasCompletedOnboarding = true }
                )
            }
        }
        .defaultSize(
            width: hasCompletedOnboarding ? 1200 : 600,
            height: hasCompletedOnboarding ? 700 : 400
        )

        MenuBarExtra("CubeLite", systemImage: "square.3.layers.3d") {
            MenuBarContextView(
                clusterState: clusterState,
                kubeconfigService: kubeconfigService,
                onShowDetails: {
                    NSApplication.shared.activate()
                }
            )
        }

        Settings {
            PreferencesView()
                .environment(appSettings)
        }
    }
}
