import AppKit
import SwiftUI

@main
struct CubeliteApp: App {

    @State private var clusterState = ClusterState()
    @State private var appSettings = AppSettings()
    @State private var loginItemController: LoginItemController
    private let kubeconfigService: KubeconfigService
    private let kubeAPIService: KubeAPIService

    /// Persists whether the user has completed the first-launch onboarding flow.
    @AppStorage("hasCompletedOnboarding") private var hasCompletedOnboarding = false
    @State private var logStore = LogStore()
    @State private var portForwardService: PortForwardService

    init() {
        let ks = KubeconfigService()
        self.kubeconfigService = ks
        let api = KubeAPIService(kubeconfigService: ks)
        self.kubeAPIService = api
        self._portForwardService = State(initialValue: PortForwardService(kubeAPIService: api))
        // Default-initialised; the real `onError` closure is bound in `.task`
        // once `logStore` and `appSettings` are available in scope.
        self._loginItemController = State(initialValue: LoginItemController())
    }

    var body: some Scene {
        WindowGroup("CubeLite") {
            if hasCompletedOnboarding {
                MainView(
                    kubeconfigService: kubeconfigService,
                    kubeAPIService: kubeAPIService,
                    portForwardService: portForwardService
                )
                    .environment(clusterState)
                    .environment(appSettings)
                    .environment(logStore)
                    .environment(loginItemController)
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
                    .onChange(of: appSettings.skipTLSVerification) { _, newValue in
                        // Defensive: persist explicitly in case @Observable didSet
                        // does not fire for all binding paths.
                        UserDefaults.standard.set(newValue, forKey: AppSettings.Keys.skipTLSVerification)
                        Task { await kubeAPIService.updateSkipTLS(newValue) }
                    }
                    .task {
                        applyNSAppearance(appSettings.appearanceMode)
                        // Sync the TLS-skip flag into the API service before any
                        // network calls happen. This is the authoritative hand-off
                        // from the persisted setting to the in-memory actor state.
                        await kubeAPIService.updateSkipTLS(appSettings.skipTLSVerification)
                        let urls = appSettings.kubeconfigPaths.map { URL(fileURLWithPath: $0) }
                        await kubeconfigService.configure(paths: urls)
                        configureLoginItem()
                    }
            } else {
                FirstLaunchView(
                    kubeconfigService: kubeconfigService,
                    onComplete: { hasCompletedOnboarding = true }
                )
            }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(
            width: hasCompletedOnboarding ? 1200 : 600,
            height: hasCompletedOnboarding ? 700 : 400
        )

        MenuBarExtra("CubeLite", image: "TrayIcon") {
            MenuBarContextView(
                clusterState: clusterState,
                kubeconfigService: kubeconfigService,
                onShowDetails: {
                    NSApplication.shared.activate()
                }
            )
        }

        Settings {
            PreferencesView(kubeAPIService: kubeAPIService)
                .environment(appSettings)
                .environment(loginItemController)
        }
    }

    /// Wires the login-item controller's error reporter into the shared
    /// `LogStore` and reconciles the persisted `launchAtLogin` setting with
    /// the live `SMAppService` status.
    ///
    /// - If the user previously enabled "Launch at login" but the system
    ///   reports the app is no longer registered (e.g. the app bundle was
    ///   moved, or the user disabled it from System Settings), this attempts
    ///   to re-register. On failure, the persisted flag is set back to `false`
    ///   so the UI reflects reality.
    /// - If the persisted flag is `false` we just refresh status without
    ///   forcing an unregister, to avoid clobbering a fresh first-launch
    ///   registration the user might have just toggled on.
    @MainActor
    private func configureLoginItem() {
        loginItemController.onError = { [logStore] message, details in
            logStore.append(
                LogEntry(
                    severity: .error,
                    source: "LoginItem",
                    message: message,
                    details: details
                )
            )
        }
        loginItemController.refresh()

        if appSettings.launchAtLogin, !loginItemController.status.isEnabled {
            let ok = loginItemController.setEnabled(true)
            if !ok { appSettings.launchAtLogin = false }
        } else {
            // Keep the persisted flag in sync with reality so a stale `true`
            // doesn't survive an external unregister.
            appSettings.launchAtLogin = loginItemController.status.isEnabled
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
