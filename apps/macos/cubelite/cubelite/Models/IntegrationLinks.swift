import Foundation

/// When panels offer setting up an integration (#526): the disabled History
/// segment of the log panel and the Metrics placeholder of the details.
enum IntegrationHints {
    /// Help of the disabled History segment.
    static let historyHelp = "Connect Elasticsearch in Settings → Integrations to see older logs"
    /// Caption of the Metrics placeholder.
    static let metricsCaption = "CPU, memory, restarts and network history from Prometheus."

    /// The integration exists in this build, the context has none, and the
    /// user has not hidden the hints.
    static func showsSetup(available: Bool, configured: Bool, hints: Bool) -> Bool {
        available && !configured && hints
    }
}

/// A command palette entry about integrations (#526).
enum IntegrationPaletteEntry: String, CaseIterable, Sendable {
    case openKibana
    case openGrafana
    case integrationsSettings

    var label: String {
        switch self {
        case .openKibana: "Open Kibana"
        case .openGrafana: "Open Grafana"
        case .integrationsSettings: "Integrations settings"
        }
    }

    var systemImage: String {
        switch self {
        case .openKibana, .openGrafana: "arrow.up.forward.square"
        case .integrationsSettings: "puzzlepiece.extension"
        }
    }

    /// The entries for a context: a web UI only when it can be opened, the
    /// settings whenever the build has integrations.
    static func entries(canOpenKibana: Bool, canOpenGrafana: Bool, hasIntegrations: Bool) -> [Self] {
        var out: [Self] = []
        if canOpenKibana { out.append(.openKibana) }
        if canOpenGrafana { out.append(.openGrafana) }
        if hasIntegrations { out.append(.integrationsSettings) }
        return out
    }
}

/// The web UIs of one context's integrations (#526): which can be opened,
/// and their links (a configured URL, else an in-cluster service through a
/// port-forward).
@MainActor
struct IntegrationLinks {
    let context: String?
    let elastic: LogHistoryAccess?
    let prometheus: PrometheusStore?

    var esEndpoint: EsEndpoint? { elastic?.endpoints.endpoint(for: context) }
    var promEndpoint: PromEndpoint? { prometheus?.endpoint(for: context) }

    var canOpenKibana: Bool {
        guard let elastic, let endpoint = esEndpoint else { return false }
        return elastic.canOpenKibana(endpoint)
    }

    var canOpenGrafana: Bool {
        guard let prometheus, let endpoint = promEndpoint else { return false }
        return prometheus.canOpenGrafana(endpoint)
    }

    var paletteEntries: [IntegrationPaletteEntry] {
        IntegrationPaletteEntry.entries(
            canOpenKibana: canOpenKibana, canOpenGrafana: canOpenGrafana,
            hasIntegrations: elastic != nil || prometheus?.querying != nil)
    }

    /// Discover filtered on `workload` in `namespace`; plain Discover without one.
    func kibanaURL(namespace: String = "", workload: Workload? = nil) async throws -> URL? {
        guard let context, let elastic, let endpoint = esEndpoint else { return nil }
        return try await elastic.kibanaURL(
            context: context, endpoint: endpoint, namespace: namespace, workload: workload)
    }

    /// Explore with the CPU of `workload` in `namespace`; Grafana's home without one.
    func grafanaURL(namespace: String = "", workload: Workload? = nil) async throws -> URL? {
        guard let context, let prometheus, let endpoint = promEndpoint else { return nil }
        guard let workload else { return try await prometheus.grafanaHomeURL(context: context, endpoint: endpoint) }
        return try await prometheus.grafanaWorkloadURL(
            context: context, endpoint: endpoint, namespace: namespace, workload: workload)
    }
}
