import Foundation
import Observation
import SwiftUI

/// Persistent app-wide settings backed by UserDefaults.
///
/// All properties are observed via the `@Observable` macro; changes are
/// automatically persisted to `defaults` (the standard domain in the app, a
/// per-suite domain in tests) through `didSet`.
/// Credentials and secrets must **never** be stored here — use `KeychainService`.
@Observable
@MainActor
final class AppSettings {

    // MARK: - General

    /// Auto-refresh interval in seconds. `0` means disabled.
    var autoRefreshInterval: Int = 30 {
        didSet { defaults.set(autoRefreshInterval, forKey: Keys.autoRefreshInterval) }
    }

    /// Whether CubeLite should launch at login.
    var launchAtLogin: Bool = false {
        didSet { defaults.set(launchAtLogin, forKey: Keys.launchAtLogin) }
    }

    /// Whether to show system namespaces (e.g. kube-system, kube-public).
    var showSystemNamespaces: Bool = false {
        didSet {
            defaults.set(showSystemNamespaces, forKey: Keys.showSystemNamespaces)
        }
    }

    // MARK: - Appearance

    /// Preferred color scheme.
    var appearanceMode: AppearanceMode = .system {
        didSet { defaults.set(appearanceMode.rawValue, forKey: Keys.appearanceMode) }
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
            defaults.set(menuBarIconStyle.rawValue, forKey: Keys.menuBarIconStyle)
        }
    }

    // MARK: - Advanced

    /// Custom kubeconfig file paths. When empty, default path resolution is used.
    var kubeconfigPaths: [String] = [] {
        didSet { defaults.set(kubeconfigPaths, forKey: Keys.kubeconfigPaths) }
    }

    /// Kubernetes API request timeout in seconds. Clamped to 5–120.
    var apiTimeout: Int = 30 {
        didSet { defaults.set(apiTimeout, forKey: Keys.apiTimeout) }
    }

    /// User-configured namespaces per context for RBAC-restricted clusters.
    ///
    /// When a cluster denies `list namespaces`, the app falls back to this map
    /// to determine which namespaces the user can access. Keyed by context name.
    var contextNamespaces: [String: [String]] = [:] {
        didSet {
            if let data = try? JSONEncoder().encode(contextNamespaces) {
                defaults.set(data, forKey: Keys.contextNamespaces)
            }
        }
    }

    /// Last namespace the user selected per context, restored on cluster
    /// switch. The empty-string marker records an explicit "All Namespaces"
    /// choice, distinct from having no record at all.
    var lastNamespaces: [String: String] = [:] {
        didSet {
            if let data = try? JSONEncoder().encode(lastNamespaces) {
                defaults.set(data, forKey: Keys.lastNamespaces)
            }
        }
    }

    /// Marker stored in `lastNamespaces` for an "All Namespaces" selection.
    private static let allNamespacesMarker = ""

    /// Outcome of looking up the remembered namespace for a context.
    enum RecalledNamespace: Equatable {
        /// No selection has been recorded for this context.
        case none
        /// The user last selected "All Namespaces".
        case all
        /// The user last selected this specific namespace.
        case named(String)
    }

    /// Records the namespace selected for `context`. `nil` records
    /// an explicit "All Namespaces" choice.
    func rememberNamespace(_ namespace: String?, for context: String) {
        lastNamespaces[context] = namespace ?? Self.allNamespacesMarker
    }

    /// Returns the remembered namespace selection for `context`.
    func recallNamespace(for context: String) -> RecalledNamespace {
        guard let stored = lastNamespaces[context] else { return .none }
        return stored == Self.allNamespacesMarker ? .all : .named(stored)
    }

    /// Whether to skip TLS certificate verification for all clusters.
    /// When enabled, self-signed certificates (e.g., minikube) are accepted.
    /// ⚠️ Security risk — only enable for local development clusters.
    var skipTLSVerification: Bool = false {
        didSet { defaults.set(skipTLSVerification, forKey: Keys.skipTLSVerification) }
    }

    // MARK: - Integrations (#526)

    /// Whether panels offer setting up an integration that is not configured
    /// (the disabled History segment, the Metrics placeholder).
    var integrationHints: Bool = true {
        didSet { defaults.set(integrationHints, forKey: Keys.integrationHints) }
    }

    /// Settings tab shown; panels set it before opening Settings (not persisted).
    var preferencesTab: PreferencesTab = .general

    /// Integration shown in the Integrations tab (not persisted).
    var integrationPane: IntegrationPane = .elasticsearch

    /// Context the Integrations tab edits, requested by the panel that opened
    /// it (not persisted); nil leaves the tab's own choice.
    var integrationContext: String?

    /// Selects the Integrations tab on `pane` for `context` (the panel's
    /// active context); the caller then opens Settings.
    func showIntegrationSettings(_ pane: IntegrationPane?, context: String?) {
        preferencesTab = .integrations
        if let pane { integrationPane = pane }
        if let context { integrationContext = context }
    }

    // MARK: - Integration suggestions (#527)

    /// Integrations whose suggestion banner was dismissed, per context
    /// (`elasticsearch`, `prometheus`); Settings → Integrations clears them.
    private(set) var integrationDismissals: [String: [String]] = [:] {
        didSet {
            if let data = try? JSONEncoder().encode(integrationDismissals) {
                defaults.set(data, forKey: Keys.integrationDismissals)
            }
        }
    }

    func isDismissed(_ pane: IntegrationPane, context: String) -> Bool {
        integrationDismissals[context]?.contains(pane.key) ?? false
    }

    func dismiss(_ panes: [IntegrationPane], context: String) {
        let kept = integrationDismissals[context] ?? []
        integrationDismissals[context] = kept + panes.map(\.key).filter { !kept.contains($0) }
    }

    func clearDismissals(context: String) {
        integrationDismissals[context] = nil
    }

    /// Services the banner's Review hands to Settings → Integrations, which
    /// pre-fills its forms with them without saving (not persisted).
    private(set) var pendingSuggestion: PendingSuggestion?

    func suggest(_ found: DetectedIntegrations, context: String) {
        pendingSuggestion = PendingSuggestion(context: context, found: found)
    }

    /// The pending suggestion for `context`, consumed.
    func takeSuggestion(for context: String?) -> DetectedIntegrations? {
        guard let pending = pendingSuggestion, pending.context == context else { return nil }
        pendingSuggestion = nil
        return pending.found
    }

    struct PendingSuggestion: Equatable, Sendable {
        let context: String
        let found: DetectedIntegrations
    }

    // MARK: - Init

    /// Where settings persist; injectable so parallel test processes never
    /// share the standard domain (#482).
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let d = defaults
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
        if let v = d.object(forKey: Keys.integrationHints) as? Bool { integrationHints = v }
        if let data = d.data(forKey: Keys.contextNamespaces),
            let decoded = try? JSONDecoder().decode([String: [String]].self, from: data)
        {
            contextNamespaces = decoded
        }
        if let data = d.data(forKey: Keys.integrationDismissals),
            let decoded = try? JSONDecoder().decode([String: [String]].self, from: data)
        {
            integrationDismissals = decoded
        }
        if let data = d.data(forKey: Keys.lastNamespaces),
            let decoded = try? JSONDecoder().decode([String: String].self, from: data)
        {
            lastNamespaces = decoded
        }
    }

    // MARK: - Nested Types

    /// Tabs of the Settings window.
    enum PreferencesTab: Hashable {
        case general, appearance, navigation, integrations, advanced
    }

    /// Integrations configured in the Integrations tab.
    enum IntegrationPane: String, CaseIterable, Sendable {
        case elasticsearch = "Elasticsearch"
        case prometheus = "Prometheus"

        /// Persisted name (dismissals, same as the desktop's).
        var key: String { self == .elasticsearch ? "elasticsearch" : "prometheus" }
    }

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
        static let lastNamespaces = "lastNamespaces"
        static let integrationHints = "integrationHints"
        static let integrationDismissals = "integrationDismissals"
    }
}
