import Foundation
import Observation

// Detect on connect, enable in one click (#527, spec
// docs/superpowers/specs/2026-11-03-integrations-one-click-design.md),
// mirroring the desktop's integrations store and core `integration::detect_all`.

extension DetectedService {
    /// ECK's HTTP service (`{cluster}-es-http`), whose `elastic` user can be used.
    var isECK: Bool { name.hasSuffix("-es-http") }
}

/// The services the integrations would use, from one listing of the
/// cluster's services.
struct DetectedIntegrations: Equatable, Sendable {
    var elasticsearch: DetectedService?
    var kibana: DetectedService?
    var prometheus: DetectedPrometheus?
    var grafana: DetectedPrometheus?

    /// Picks one service per integration with the Elasticsearch and
    /// Prometheus classifiers: ECK's `-es-http` and `prometheus-operated`
    /// first, else the first by namespace and name; Kibana and Grafana
    /// prefer the namespace of the service they go with.
    static func pick(services: [IntegrationK8s.Service]) -> DetectedIntegrations {
        let es = services.compactMap(Elastic.classify)
        let prom = services.compactMap(Prometheus.classify)
        let elasticsearch = first(es.filter { $0.kind == .elasticsearch }) { $0.isECK }
        let kibana = first(es.filter { $0.kind == .kibana }) { $0.namespace == elasticsearch?.namespace }
        let prometheus = first(prom.filter { $0.kind == .prometheus }) { $0.name == "prometheus-operated" }
        let grafana = first(prom.filter { $0.kind == .grafana }) { $0.namespace == prometheus?.namespace }
        return DetectedIntegrations(
            elasticsearch: elasticsearch, kibana: kibana, prometheus: prometheus, grafana: grafana)
    }

    /// The first of `found` by (preferred, namespace, name).
    private static func first<T: NamespacedService>(_ found: [T], preferred: (T) -> Bool) -> T? {
        found.min { a, b in
            (preferred(a) ? 0 : 1, a.namespace, a.name) < (preferred(b) ? 0 : 1, b.namespace, b.name)
        }
    }

    /// Lists the services of every namespace once: only the Kubernetes API
    /// is contacted, no Elasticsearch or Prometheus and no secrets. A user
    /// who may not list services across namespaces (403) gets nothing.
    static func detect(
        context: String, cluster: any IntegrationClusterAccess
    ) async throws -> DetectedIntegrations {
        do {
            let list: IntegrationK8s.List<IntegrationK8s.Service> = try await Integration.get(
                "/api/v1/services", context: context, from: cluster)
            return pick(services: list.items)
        } catch CubeliteError.forbidden {
            return DetectedIntegrations()
        }
    }

    /// Integrations with a service, in banner order.
    var found: [AppSettings.IntegrationPane] {
        (elasticsearch != nil ? [.elasticsearch] : []) + (prometheus != nil ? [.prometheus] : [])
    }

    /// Only the services of `panes` (what the banner offers).
    func only(_ panes: [AppSettings.IntegrationPane]) -> DetectedIntegrations {
        let es = panes.contains(.elasticsearch)
        let prom = panes.contains(.prometheus)
        return DetectedIntegrations(
            elasticsearch: es ? elasticsearch : nil, kibana: es ? kibana : nil,
            prometheus: prom ? prometheus : nil, grafana: prom ? grafana : nil)
    }
}

/// A detected service's namespace and name (ordering the picks).
protocol NamespacedService {
    var namespace: String { get }
    var name: String { get }
}

extension DetectedService: NamespacedService {}
extension DetectedPrometheus: NamespacedService {}

/// The suggestion banner's state per context (#527): what was found when
/// the context connected, the integrations offered, Enable and its outcome.
@Observable @MainActor
final class IntegrationsSuggestionStore {

    /// The banner's line after Enable: saved, or why nothing was saved.
    struct Status: Equatable, Sendable {
        let ok: Bool
        let text: String
    }

    private(set) var detected: [String: DetectedIntegrations] = [:]
    /// Context Enable runs for.
    private(set) var enabling: String?
    private(set) var status: [String: Status] = [:]

    /// How long a success line stays.
    @ObservationIgnored var successDuration: Duration = .seconds(4)
    /// Contexts detected since they connected.
    @ObservationIgnored private var attempted: Set<String> = []

    private let cluster: any IntegrationClusterAccess
    private let elastic: any ElasticPreferencesBackend
    private let prometheus: any PrometheusPreferencesBackend
    private let elasticEndpoints: ElasticEndpointStore
    private let prometheusEndpoints: PrometheusEndpointStore
    private let settings: AppSettings

    init(
        cluster: any IntegrationClusterAccess, elastic: any ElasticPreferencesBackend,
        prometheus: any PrometheusPreferencesBackend, elasticEndpoints: ElasticEndpointStore,
        prometheusEndpoints: PrometheusEndpointStore, settings: AppSettings
    ) {
        self.cluster = cluster
        self.elastic = elastic
        self.prometheus = prometheus
        self.elasticEndpoints = elasticEndpoints
        self.prometheusEndpoints = prometheusEndpoints
        self.settings = settings
    }

    // MARK: Detection

    /// The context (re)connected: it is detected again after its first load.
    func connected(_ context: String) {
        attempted.remove(context)
        detected[context] = nil
        status[context] = nil
    }

    /// Lists the services once per connect; failures stay silent.
    func detectIfNeeded(context: String) async {
        guard !attempted.contains(context) else { return }
        attempted.insert(context)
        guard let found = try? await DetectedIntegrations.detect(context: context, cluster: cluster) else {
            return
        }
        detected[context] = found
    }

    // MARK: Banner

    /// Integrations offered for `context`: found, not configured, not
    /// dismissed, with hints on.
    func offered(for context: String?) -> [AppSettings.IntegrationPane] {
        guard let context, settings.integrationHints, let found = detected[context] else { return [] }
        return found.found.filter { pane in
            !settings.isDismissed(pane, context: context) && !isConfigured(pane, context: context)
        }
    }

    func isConfigured(_ pane: AppSettings.IntegrationPane, context: String) -> Bool {
        switch pane {
        case .elasticsearch: elasticEndpoints.endpoint(for: context) != nil
        case .prometheus: prometheusEndpoints.endpoint(for: context) != nil
        }
    }

    /// The banner's line, nil when it is hidden.
    func message(for context: String?) -> Status? {
        guard let context, settings.integrationHints else { return nil }
        if let status = status[context] { return status }
        let offered = offered(for: context)
        guard !offered.isEmpty else { return nil }
        return Status(ok: true, text: Self.foundText(offered))
    }

    /// "Elasticsearch and Prometheus found in this cluster".
    static func foundText(_ panes: [AppSettings.IntegrationPane]) -> String {
        "\(panes.map(\.rawValue).joined(separator: " and ")) found in this cluster"
    }

    /// Whether Enable and Review apply (something is still offered).
    func canAct(for context: String?) -> Bool { !offered(for: context).isEmpty }

    // MARK: Actions

    /// Tests and saves every offered integration with the defaults;
    /// nothing is saved for one whose test fails.
    func enable(context: String) async {
        let offered = offered(for: context)
        guard enabling == nil, let found = detected[context], !offered.isEmpty else { return }
        enabling = context
        status[context] = nil
        defer { enabling = nil }
        var saved: [String] = []
        var failures: [String] = []
        for pane in offered {
            if let reason = await enable(pane, found: found, context: context) {
                failures.append(reason)
            } else {
                saved.append("\(pane.rawValue) enabled for \(context)")
            }
        }
        if !failures.isEmpty {
            status[context] = Status(ok: false, text: failures.joined(separator: " · "))
        } else {
            let line = Status(ok: true, text: saved.joined(separator: " · "))
            status[context] = line
            clearLater(line, context: context)
        }
    }

    /// The failure line for `pane`, nil once saved.
    private func enable(
        _ pane: AppSettings.IntegrationPane, found: DetectedIntegrations, context: String
    ) async -> String? {
        let reason: String?
        var hint = ""
        switch pane {
        case .elasticsearch:
            guard let es = found.elasticsearch else { return nil }
            let model = ElasticPreferencesModel(backend: elastic, endpoints: elasticEndpoints)
            await model.load(context: context)
            model.suggest(es, kibana: found.kibana)
            reason = await model.testThenSave()
            if !es.isECK { hint = " (credentials may be needed)" }
        case .prometheus:
            guard let prom = found.prometheus else { return nil }
            let model = PrometheusPreferencesModel(backend: prometheus, endpoints: prometheusEndpoints)
            await model.load(context: context)
            model.suggest(prom, grafana: found.grafana)
            reason = await model.testThenSave()
        }
        return reason.map { "Couldn't connect to \(pane.rawValue): \($0)\(hint)" }
    }

    private func clearLater(_ line: Status, context: String) {
        let duration = successDuration
        Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard let self, self.status[context] == line else { return }
            self.status[context] = nil
        }
    }

    /// Hands the offered services to Settings → Integrations (pre-filled,
    /// not saved); the pane to open.
    func review(context: String) -> AppSettings.IntegrationPane {
        let offered = offered(for: context)
        if let found = detected[context] { settings.suggest(found.only(offered), context: context) }
        status[context] = nil
        return offered.first ?? .elasticsearch
    }

    /// Hides the banner for the offered integrations of `context` (kept).
    func dismiss(context: String) {
        settings.dismiss(offered(for: context), context: context)
        status[context] = nil
    }
}
