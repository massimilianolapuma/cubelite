import Foundation
import Observation
import SwiftUI

/// Persistent app-wide settings backed by UserDefaults.
///
/// All properties are observed via the `@Observable` macro; changes are
/// automatically persisted to `UserDefaults.standard` through `didSet`.
/// Credentials and secrets must **never** be stored here — use `KeychainService`.
@Observable
@MainActor
final class AppSettings {

    // MARK: - General

    /// Auto-refresh interval in seconds. `0` means disabled.
    var autoRefreshInterval: Int = 30 {
        didSet { UserDefaults.standard.set(autoRefreshInterval, forKey: Keys.autoRefreshInterval) }
    }

    /// Whether CubeLite should launch at login.
    var launchAtLogin: Bool = false {
        didSet { UserDefaults.standard.set(launchAtLogin, forKey: Keys.launchAtLogin) }
    }

    /// Whether to show system namespaces (e.g. kube-system, kube-public).
    var showSystemNamespaces: Bool = false {
        didSet {
            UserDefaults.standard.set(showSystemNamespaces, forKey: Keys.showSystemNamespaces)
        }
    }

    // MARK: - Appearance

    /// Preferred color scheme.
    var appearanceMode: AppearanceMode = .system {
        didSet { UserDefaults.standard.set(appearanceMode.rawValue, forKey: Keys.appearanceMode) }
    }

    /// The SwiftUI `ColorScheme` corresponding to the current `appearanceMode`.
    ///
    /// Returns `nil` when the mode is `.system`, which defers colour scheme
    /// selection to the operating system.
    var colorScheme: ColorScheme? {
        switch appearanceMode {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    /// Menu bar icon style.
    var menuBarIconStyle: MenuBarIconStyle = .standard {
        didSet {
            UserDefaults.standard.set(menuBarIconStyle.rawValue, forKey: Keys.menuBarIconStyle)
        }
    }

    // MARK: - Advanced

    /// Custom kubeconfig file paths. When empty, default path resolution is used.
    var kubeconfigPaths: [String] = [] {
        didSet { UserDefaults.standard.set(kubeconfigPaths, forKey: Keys.kubeconfigPaths) }
    }

    /// Kubernetes API request timeout in seconds. Clamped to 5–120.
    var apiTimeout: Int = 30 {
        didSet { UserDefaults.standard.set(apiTimeout, forKey: Keys.apiTimeout) }
    }

    /// User-configured namespaces per context for RBAC-restricted clusters.
    ///
    /// When a cluster denies `list namespaces`, the app falls back to this map
    /// to determine which namespaces the user can access. Keyed by context name.
    var contextNamespaces: [String: [String]] = [:] {
        didSet {
            if let data = try? JSONEncoder().encode(contextNamespaces) {
                UserDefaults.standard.set(data, forKey: Keys.contextNamespaces)
            }
        }
    }

    /// Whether to skip TLS certificate verification for all clusters.
    /// When enabled, self-signed certificates (e.g., minikube) are accepted.
    /// ⚠️ Security risk — only enable for local development clusters.
    var skipTLSVerification: Bool = false {
        didSet { UserDefaults.standard.set(skipTLSVerification, forKey: Keys.skipTLSVerification) }
    }

    // MARK: - Init

    init() {
        let d = UserDefaults.standard
        // `didSet` is NOT called during initialisation, so we load manually.
        if let v = d.object(forKey: Keys.autoRefreshInterval) as? Int { autoRefreshInterval = v }
        launchAtLogin = d.bool(forKey: Keys.launchAtLogin)
        showSystemNamespaces = d.bool(forKey: Keys.showSystemNamespaces)
        if let raw = d.string(forKey: Keys.appearanceMode),
            let mode = AppearanceMode(rawValue: raw)
        {
            appearanceMode = mode
        }
        if let raw = d.string(forKey: Keys.menuBarIconStyle),
            let style = MenuBarIconStyle(rawValue: raw)
        {
            menuBarIconStyle = style
        }
        kubeconfigPaths = d.stringArray(forKey: Keys.kubeconfigPaths) ?? []
        // Migrate legacy single-path key to the new array key.
        if kubeconfigPaths.isEmpty, let legacy = d.string(forKey: Keys.kubeconfigPath),
            !legacy.isEmpty
        {
            kubeconfigPaths = [legacy]
            d.removeObject(forKey: Keys.kubeconfigPath)
        }
        if let v = d.object(forKey: Keys.apiTimeout) as? Int { apiTimeout = min(120, max(5, v)) }
        skipTLSVerification = d.bool(forKey: Keys.skipTLSVerification)
        if let data = d.data(forKey: Keys.contextNamespaces),
            let decoded = try? JSONDecoder().decode([String: [String]].self, from: data)
        {
            contextNamespaces = decoded
        }
    }

    // MARK: - Nested Types

    /// Color scheme preference.
    enum AppearanceMode: String, CaseIterable {
        case system, light, dark

        /// Human-readable label for display in UI.
        var label: String {
            switch self {
            case .system: "System"
            case .light: "Light"
            case .dark: "Dark"
            }
        }
    }

    /// Menu bar icon style.
    enum MenuBarIconStyle: String, CaseIterable {
        /// Standard full-colour icon. Raw value kept as "default" for UserDefaults back-compat.
        case standard = "default"
        case monochrome

        /// Human-readable label for display in UI.
        var label: String {
            switch self {
            case .standard: "Default"
            case .monochrome: "Monochrome"
            }
        }
    }

    // MARK: - Keys

    /// UserDefaults key constants for all persisted settings.
    enum Keys {
        static let autoRefreshInterval = "autoRefreshInterval"
        static let launchAtLogin = "launchAtLogin"
        static let showSystemNamespaces = "showSystemNamespaces"
        static let appearanceMode = "appearanceMode"
        static let menuBarIconStyle = "menuBarIconStyle"
        /// Legacy key — kept for one-time migration only.
        static let kubeconfigPath = "kubeconfigPath"
        static let kubeconfigPaths = "kubeconfigPaths"
        static let apiTimeout = "apiTimeout"
        static let skipTLSVerification = "skipTLSVerification"
        static let contextNamespaces = "contextNamespaces"
    }
}
