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
        didSet { UserDefaults.standard.set(showSystemNamespaces, forKey: Keys.showSystemNamespaces) }
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
        didSet { UserDefaults.standard.set(menuBarIconStyle.rawValue, forKey: Keys.menuBarIconStyle) }
    }

    // MARK: - Advanced

    /// Custom kubeconfig file path. Empty string means the default `~/.kube/config`.
    var kubeconfigPath: String = "" {
        didSet { UserDefaults.standard.set(kubeconfigPath, forKey: Keys.kubeconfigPath) }
    }

    /// Kubernetes API request timeout in seconds. Clamped to 5–120.
    var apiTimeout: Int = 30 {
        didSet { UserDefaults.standard.set(apiTimeout, forKey: Keys.apiTimeout) }
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
           let mode = AppearanceMode(rawValue: raw) { appearanceMode = mode }
        if let raw = d.string(forKey: Keys.menuBarIconStyle),
           let style = MenuBarIconStyle(rawValue: raw) { menuBarIconStyle = style }
        kubeconfigPath = d.string(forKey: Keys.kubeconfigPath) ?? ""
        if let v = d.object(forKey: Keys.apiTimeout) as? Int { apiTimeout = min(120, max(5, v)) }
        skipTLSVerification = d.bool(forKey: Keys.skipTLSVerification)
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
        case standard = "default", monochrome

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
        static let kubeconfigPath = "kubeconfigPath"
        static let apiTimeout = "apiTimeout"
        static let skipTLSVerification = "skipTLSVerification"
    }
}
