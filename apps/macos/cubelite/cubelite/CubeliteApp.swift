import AppKit
import SwiftUI

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
                    .preferredColorScheme(appSettings.colorScheme)
                    .onChange(of: appSettings.appearanceMode) { _, newMode in
                        applyNSAppearance(newMode)
                    }
                    .onChange(of: appSettings.kubeconfigPaths) { _, newPaths in
                        let urls = newPaths.map { URL(fileURLWithPath: $0) }
                        Task {
                            await kubeconfigService.configure(paths: urls)
                            await kubeAPIService.invalidateSession()
                        }
                    }
                    .task {
                        applyNSAppearance(appSettings.appearanceMode)
                        let urls = appSettings.kubeconfigPaths.map { URL(fileURLWithPath: $0) }
                        await kubeconfigService.configure(paths: urls)
                    }
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

    /// Applies `NSAppearance` to the whole application so that window chrome,
    /// menus, and AppKit elements match the user's selected theme.
    ///
    /// - Parameter mode: The `AppearanceMode` selected in Preferences.
    @MainActor
    private func applyNSAppearance(_ mode: AppSettings.AppearanceMode) {
        switch mode {
        case .system:
            NSApp.appearance = nil
        case .light:
            NSApp.appearance = NSAppearance(named: .aqua)
        case .dark:
            NSApp.appearance = NSAppearance(named: .darkAqua)
        }
    }
}
