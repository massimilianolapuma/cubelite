import Foundation
import Observation

// Detect on connect, enable in one click (#527, spec
// docs/superpowers/specs/2026-11-03-integrations-one-click-design.md),
// mirroring the desktop's integrations store and core `integration::pick_services`.

extension DetectedService {
    /// ECK's HTTP service (`{cluster}-es-http`), whose `elastic` user can be used.
    var isECK: Bool { name.hasSuffix("-es-http") }
}

/// The services the integrations would use, from one listing of the
/// cluster's services, ranked like core `pick_services`.
struct DetectedIntegrations: Equatable, Sendable {
    /// Best Elasticsearch guess.
    var elasticsearch: DetectedService?
    /// Kibana in the Elasticsearch's namespace.
    var kibana: DetectedService?
    /// Best Prometheus guess.
    var prometheus: DetectedPrometheus?
    /// Grafana in the Prometheus's namespace.
    var grafana: DetectedPrometheus?
    /// `elasticsearch` is the only ECK-managed Elasticsearch: Enable may
    /// save it without a review.
    var elasticsearchOneClick = false
    /// `prometheus` is the only operator-managed Prometheus.
    var prometheusOneClick = false
    /// Every Elasticsearch and Kibana found, best first (for Review).
    var elasticServices: [DetectedService] = []
    /// Every Prometheus and Grafana found, best first (for Review).
    var prometheusServices: [DetectedPrometheus] = []

    /// Namespaces where observability stacks usually live, preferred after
    /// operator ownership.
    static let wellKnownNamespaces = ["logging", "elastic-system", "monitoring", "observability"]

    /// Picks the integrations' services with the Elasticsearch and
    /// Prometheus classifiers, ranked by operator ownership, well-known
    /// namespace, conventional name (`-es-http`, `prometheus-operated`),
    /// namespace and name. Kibana and Grafana come only from the namespace
    /// of the service they go with.
    static func pick(services: [IntegrationK8s.Service]) -> DetectedIntegrations {
        let es = rank(
            services.compactMap { s in Elastic.classify(s).map { ($0, esTrusted(s)) } }, main: "elasticsearch"
        ) { $0.name.hasSuffix("-es-http") || $0.name.hasSuffix("-kb-http") }
        let prom = rank(
            services.compactMap { s in Prometheus.classify(s).map { ($0, promTrusted(s)) } }, main: "prometheus"
        ) { $0.name == "prometheus-operated" }
        return DetectedIntegrations(
            elasticsearch: es.main, kibana: es.webUI, prometheus: prom.main, grafana: prom.webUI,
            elasticsearchOneClick: es.oneClick, prometheusOneClick: prom.oneClick,
            elasticServices: es.all, prometheusServices: prom.all)
    }

    /// An Elasticsearch service managed by ECK: owned by an `Elasticsearch`
    /// resource, or carrying ECK's type and cluster-name labels.
    static func esTrusted(_ service: IntegrationK8s.Service) -> Bool {
        let labels = service.metadata.labels ?? [:]
        return ownedBy(service, kind: "Elasticsearch", group: "elasticsearch.k8s.elastic.co")
            || (labels["common.k8s.elastic.co/type"] == "elasticsearch"
                && labels["elasticsearch.k8s.elastic.co/cluster-name"] != nil)
    }

    /// A Prometheus service managed by the Prometheus operator: owned by a
    /// `Prometheus` resource, or its governing `prometheus-operated` service.
    static func promTrusted(_ service: IntegrationK8s.Service) -> Bool {
        ownedBy(service, kind: "Prometheus", group: "monitoring.coreos.com")
            || (service.metadata.name == "prometheus-operated"
                && service.metadata.labels?["operated-prometheus"] == "true")
    }

    /// Owned by a custom resource of `kind` in API group `group`.
    private static func ownedBy(_ service: IntegrationK8s.Service, kind: String, group: String) -> Bool {
        (service.metadata.ownerReferences ?? []).contains { owner in
            owner.kind == kind && owner.apiVersion.split(separator: "/").first.map(String.init) == group
        }
    }

    private struct Ranked<T> {
        var main: T?
        var webUI: T?
        var oneClick: Bool
        var all: [T]
    }

    /// Ranks (service, trusted): the `main` kind first, then trusted,
    /// well-known namespace, `conventional` name, namespace and name. The
    /// web UI comes only from the main service's namespace; one-click needs
    /// exactly one trusted main service.
    private static func rank<T: RankedService>(
        _ found: [(T, Bool)], main: String, conventional: (T) -> Bool
    ) -> Ranked<T> {
        func key(_ entry: (T, Bool)) -> (Int, Int, Int, Int, String, String) {
            let (d, trusted) = entry
            return (
                d.kindName == main ? 0 : 1, trusted ? 0 : 1, wellKnownNamespaces.contains(d.namespace) ? 0 : 1,
                conventional(d) ? 0 : 1, d.namespace, d.name
            )
        }
        let sorted = found.sorted { key($0) < key($1) }
        let best = sorted.first { $0.0.kindName == main }
        let webUI = best.flatMap { m in
            sorted.first { $0.0.kindName != main && $0.0.namespace == m.0.namespace }?.0
        }
        let trusted = sorted.filter { $0.1 && $0.0.kindName == main }.count
        return Ranked(
            main: best?.0, webUI: webUI, oneClick: trusted == 1 && best?.1 == true, all: sorted.map(\.0))
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

    func isOneClick(_ pane: AppSettings.IntegrationPane) -> Bool {
        pane == .elasticsearch ? elasticsearchOneClick : prometheusOneClick
    }

    /// `namespace/service` of what `pane` would use.
    func target(_ pane: AppSettings.IntegrationPane) -> String? {
        switch pane {
        case .elasticsearch: elasticsearch.map { "\($0.namespace)/\($0.name)" }
        case .prometheus: prometheus.map { "\($0.namespace)/\($0.name)" }
        }
    }

    /// Only the services of `panes` (what the banner offers).
    func only(_ panes: [AppSettings.IntegrationPane]) -> DetectedIntegrations {
        var kept = DetectedIntegrations()
        if panes.contains(.elasticsearch) {
            kept.elasticsearch = elasticsearch
            kept.kibana = kibana
            kept.elasticsearchOneClick = elasticsearchOneClick
            kept.elasticServices = elasticServices
        }
        if panes.contains(.prometheus) {
            kept.prometheus = prometheus
            kept.grafana = grafana
            kept.prometheusOneClick = prometheusOneClick
            kept.prometheusServices = prometheusServices
        }
        return kept
    }
}

/// What ranking reads from a detected service.
protocol RankedService {
    var kindName: String { get }
    var namespace: String { get }
    var name: String { get }
}

extension DetectedService: RankedService {
    var kindName: String { kind.rawValue }
}

extension DetectedPrometheus: RankedService {
    var kindName: String { kind.rawValue }
}

/// The suggestion banner's state per context (#527): what was found when
/// the context connected, the integrations offered, Enable and its outcome.
@Observable @MainActor
final class IntegrationsSuggestionStore {

    /// The banner's line: what was found, or Enable's outcome.
    struct Status: Equatable, Sendable {
        enum Tone: Sendable { case found, saved, warning, failed }
        let tone: Tone
        let text: String
    }

    /// Review's help when Enable is not offered.
    static let reviewFirstHelp = "Several candidates or not operator-managed: review before enabling"

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
        guard let found = detected[context], !offered.isEmpty else { return nil }
        return Status(tone: .found, text: Self.foundText(found, offered))
    }

    /// "Elasticsearch found (logging/quickstart-es-http) and Prometheus
    /// (monitoring/prometheus-operated)": always what would be used.
    static func foundText(_ found: DetectedIntegrations, _ panes: [AppSettings.IntegrationPane]) -> String {
        panes.enumerated().map { index, pane in
            let target = found.target(pane).map { " (\($0))" } ?? ""
            return index == 0 ? "\(pane.rawValue) found\(target)" : "\(pane.rawValue)\(target)"
        }.joined(separator: " and ")
    }

    /// Whether Review and ✕ apply (something is still offered).
    func canAct(for context: String?) -> Bool { !offered(for: context).isEmpty }

    /// Whether Enable applies: every offered integration has exactly one
    /// operator-managed candidate, and no failure is shown.
    func canEnable(for context: String?) -> Bool {
        guard let context, let found = detected[context], status[context]?.tone != .failed else { return false }
        let offered = offered(for: context)
        return !offered.isEmpty && offered.allSatisfy(found.isOneClick)
    }

    // MARK: Actions

    /// Tests and saves every offered integration with the defaults;
    /// nothing is saved for one whose test fails. A no-op unless every
    /// offered integration is one-click.
    func enable(context: String) async {
        let offered = offered(for: context)
        guard enabling == nil, let found = detected[context], !offered.isEmpty,
            offered.allSatisfy(found.isOneClick)
        else { return }
        enabling = context
        status[context] = nil
        defer { enabling = nil }
        var lines: [Status] = []
        for pane in offered {
            lines.append(await enable(pane, found: found, context: context))
        }
        let failed = lines.filter { $0.tone == .failed }
        if !failed.isEmpty {
            status[context] = Status(tone: .failed, text: failed.map(\.text).joined(separator: " · "))
        } else {
            let tone: Status.Tone = lines.contains { $0.tone == .warning } ? .warning : .saved
            let line = Status(tone: tone, text: lines.map(\.text).joined(separator: " · "))
            status[context] = line
            clearLater(line, context: context)
        }
    }

    /// `pane`'s line: saved (maybe with a warning) or why not.
    private func enable(
        _ pane: AppSettings.IntegrationPane, found: DetectedIntegrations, context: String
    ) async -> Status {
        let saved = "\(pane.rawValue) enabled for \(context)"
        let failed = { (reason: String, hint: String) in
            Status(tone: .failed, text: "Couldn't connect to \(pane.rawValue): \(reason)\(hint)")
        }
        switch pane {
        case .elasticsearch:
            guard let es = found.elasticsearch else { return Status(tone: .saved, text: saved) }
            let model = ElasticPreferencesModel(backend: elastic, endpoints: elasticEndpoints)
            await model.load(context: context)
            model.suggest(es, kibana: found.kibana)
            switch await model.testThenSave() {
            case .saved: return Status(tone: .saved, text: saved)
            case .failed(let reason): return failed(reason, es.isECK ? "" : " (credentials may be needed)")
            }
        case .prometheus:
            guard let prom = found.prometheus else { return Status(tone: .saved, text: saved) }
            let model = PrometheusPreferencesModel(backend: prometheus, endpoints: prometheusEndpoints)
            await model.load(context: context)
            model.suggest(prom, grafana: found.grafana)
            switch await model.testThenSave() {
            case .saved(let info) where !info.cadvisor:
                return Status(tone: .warning, text: "\(saved) — no container metrics (cAdvisor) found yet")
            case .saved: return Status(tone: .saved, text: saved)
            case .failed(let reason): return failed(reason, "")
            }
        }
    }

    private func clearLater(_ line: Status, context: String) {
        let duration = successDuration
        Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard let self, self.status[context] == line else { return }
            self.status[context] = nil
        }
    }

    /// Hands the offered services and every candidate to Settings →
    /// Integrations (pre-filled, not saved); the pane to open.
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
