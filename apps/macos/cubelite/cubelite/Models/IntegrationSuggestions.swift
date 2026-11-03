import Foundation
import Observation

// Detect on connect, enable in one click (#527, spec
// docs/superpowers/specs/2026-11-03-integrations-one-click-design.md),
// mirroring the desktop's integrations store and core `integration::pick_services`.

extension DetectedService {
    /// ECK's HTTP service (`{cluster}-es-http`), whose `elastic` user can be used.
    var isECK: Bool { name.hasSuffix("-es-http") }
}

/// How one integration's services are trusted: an owner reference to the
/// operator's custom resource, verified through the Kubernetes API.
struct OperatorRule: Sendable {
    /// Main kind from the classifier (`elasticsearch`, `prometheus`).
    let main: String
    /// Owner kind and API group of the custom resource.
    let ownerKind: String
    let group: String
    /// Plural resource name in the API path.
    let resource: String
    /// Selector label naming the instance (same-instance aliases).
    let instanceLabel: String
    /// Whether the classifier finds a main-kind service.
    let isMain: @Sendable (IntegrationK8s.Service) -> Bool
    /// Conventional name (ranking only).
    let conventional: @Sendable (String) -> Bool

    static let elasticsearch = OperatorRule(
        main: "elasticsearch", ownerKind: "Elasticsearch", group: "elasticsearch.k8s.elastic.co",
        resource: "elasticsearches", instanceLabel: "elasticsearch.k8s.elastic.co/cluster-name",
        isMain: { Elastic.classify($0)?.kind == .elasticsearch },
        conventional: { $0.hasSuffix("-es-http") || $0.hasSuffix("-kb-http") })

    static let prometheus = OperatorRule(
        main: "prometheus", ownerKind: "Prometheus", group: "monitoring.coreos.com",
        resource: "prometheuses", instanceLabel: "operator.prometheus.io/name",
        isMain: { Prometheus.classify($0)?.kind == .prometheus },
        conventional: { $0 == "prometheus-operated" })

    /// The owner reference `service` claims (kind and API group match).
    func owner(of service: IntegrationK8s.Service) -> IntegrationK8s.OwnerReference? {
        (service.metadata.ownerReferences ?? []).first { owner in
            owner.kind == ownerKind && owner.apiVersion.split(separator: "/").first.map(String.init) == group
        }
    }

    /// The custom resource an owner reference names, in the service's namespace.
    func path(namespace: String, name: String) -> String {
        "/apis/\(group)/v1/namespaces/\(namespace)/\(resource)/\(name)"
    }

    /// Ranking before verification: well-known namespace, conventional
    /// name, namespace, name.
    func unverifiedKey(namespace: String, name: String) -> (Int, Int, String, String) {
        (
            DetectedIntegrations.wellKnownNamespaces.contains(namespace) ? 0 : 1, conventional(name) ? 0 : 1,
            namespace, name
        )
    }
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
    /// `elasticsearch` is owned by a verified ECK resource and no other
    /// Elasticsearch is in the cluster: Enable may save it without a review.
    var elasticsearchOneClick = false
    /// Same for `prometheus` and the Prometheus operator.
    var prometheusOneClick = false
    /// Every Elasticsearch and Kibana found, best first (for Review).
    var elasticServices: [DetectedService] = []
    /// Every Prometheus and Grafana found, best first (for Review).
    var prometheusServices: [DetectedPrometheus] = []

    /// Namespaces where observability stacks usually live, preferred after
    /// verified ownership.
    static let wellKnownNamespaces = ["logging", "elastic-system", "monitoring", "observability"]

    /// Owner resources verified per integration, at most.
    static let maxVerified = 3

    /// Picks the integrations' services with the Elasticsearch and
    /// Prometheus classifiers. `verified` holds the `namespace/name` of
    /// services whose operator owner was checked ([`detect`]); labels and
    /// names only rank.
    static func pick(services: [IntegrationK8s.Service], verified: Set<String>) -> DetectedIntegrations {
        let es = rank(
            services.compactMap { s in Elastic.classify(s).map { ($0, s) } }, rule: .elasticsearch,
            verified: verified)
        let prom = rank(
            services.compactMap { s in Prometheus.classify(s).map { ($0, s) } }, rule: .prometheus,
            verified: verified)
        return DetectedIntegrations(
            elasticsearch: es.main, kibana: es.webUI, prometheus: prom.main, grafana: prom.webUI,
            elasticsearchOneClick: es.oneClick, prometheusOneClick: prom.oneClick,
            elasticServices: es.all, prometheusServices: prom.all)
    }

    private struct Ranked<T> {
        var main: T?
        var webUI: T?
        var oneClick: Bool
        var all: [T]
    }

    /// Ranks: the main kind first, then verified, well-known namespace,
    /// conventional name, namespace and name. The web UI comes only from
    /// the best service's namespace. One-click needs a verified best and
    /// every other main-kind service an alias of the same instance.
    private static func rank<T: RankedService>(
        _ found: [(T, IntegrationK8s.Service)], rule: OperatorRule, verified: Set<String>
    ) -> Ranked<T> {
        func isVerified(_ d: T) -> Bool { d.kindName == rule.main && verified.contains("\(d.namespace)/\(d.name)") }
        func key(_ d: T) -> (Int, Int, Int, Int, String, String) {
            let (wellKnown, conventional, namespace, name) = rule.unverifiedKey(namespace: d.namespace, name: d.name)
            return (d.kindName == rule.main ? 0 : 1, isVerified(d) ? 0 : 1, wellKnown, conventional, namespace, name)
        }
        let sorted = found.sorted { key($0.0) < key($1.0) }
        let all = sorted.map(\.0)
        guard let best = sorted.first(where: { $0.0.kindName == rule.main }) else {
            return Ranked(main: nil, webUI: nil, oneClick: false, all: all)
        }
        let webUI = sorted.first { $0.0.kindName != rule.main && $0.0.namespace == best.0.namespace }?.0
        let instance = rule.owner(of: best.1)?.name
        let others = sorted.filter {
            $0.0.kindName == rule.main && ($0.0.namespace, $0.0.name) != (best.0.namespace, best.0.name)
        }
        let aliasesOnly = others.allSatisfy { other in
            instance != nil && other.0.namespace == best.0.namespace
                && other.1.spec?.selector?[rule.instanceLabel] == instance
        }
        return Ranked(main: best.0, webUI: webUI, oneClick: isVerified(best.0) && aliasesOnly, all: all)
    }

    /// Lists the services of every namespace once and verifies the owners
    /// of up to three claimed services per integration: only the
    /// Kubernetes API is contacted, never Elasticsearch or Prometheus, and
    /// no secrets. A user who may not list services across namespaces
    /// (403) gets nothing.
    static func detect(
        context: String, cluster: any IntegrationClusterAccess
    ) async throws -> DetectedIntegrations {
        let list: IntegrationK8s.List<IntegrationK8s.Service>
        do {
            list = try await Integration.get("/api/v1/services", context: context, from: cluster)
        } catch CubeliteError.forbidden {
            return DetectedIntegrations()
        }
        var verified = Set<String>()
        for rule in [OperatorRule.elasticsearch, .prometheus] {
            for (service, owner) in claims(list.items, rule: rule) {
                let namespace = service.metadata.namespace ?? ""
                if await isVerified(owner, namespace: namespace, rule: rule, context: context, cluster: cluster) {
                    verified.insert("\(namespace)/\(service.metadata.name ?? "")")
                }
            }
        }
        return pick(services: list.items, verified: verified)
    }

    /// Main-kind services with a matching owner reference, in unverified
    /// ranking order, at most `maxVerified`.
    static func claims(
        _ services: [IntegrationK8s.Service], rule: OperatorRule
    ) -> [(IntegrationK8s.Service, IntegrationK8s.OwnerReference)] {
        let claimed = services.compactMap { s in rule.isMain(s) ? rule.owner(of: s).map { (s, $0) } : nil }
        let sorted = claimed.sorted { a, b in
            rule.unverifiedKey(namespace: a.0.metadata.namespace ?? "", name: a.0.metadata.name ?? "")
                < rule.unverifiedKey(namespace: b.0.metadata.namespace ?? "", name: b.0.metadata.name ?? "")
        }
        return Array(sorted.prefix(maxVerified))
    }

    /// The owner resource exists in the service's namespace with the
    /// referenced uid; any error means not verified.
    private static func isVerified(
        _ owner: IntegrationK8s.OwnerReference, namespace: String, rule: OperatorRule, context: String,
        cluster: any IntegrationClusterAccess
    ) async -> Bool {
        guard let name = owner.name, let uid = owner.uid, Integration.isDNSLabel(namespace),
            Integration.isDNSLabel(name)
        else { return false }
        let data: Data?
        do {
            data = try await cluster.getIfPresent(path: rule.path(namespace: namespace, name: name), inContext: context)
        } catch {
            return false
        }
        guard let data, let object = try? JSONDecoder().decode(OwnerObject.self, from: data) else { return false }
        return object.metadata.uid == uid
    }

    private struct OwnerObject: Decodable {
        struct Meta: Decodable { var uid: String? }
        var metadata: Meta
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

    /// The context (re)connected: it is detected again after its first load,
    /// and a Review not yet shown in Settings is dropped.
    func connected(_ context: String) {
        attempted.remove(context)
        detected[context] = nil
        status[context] = nil
        settings.clearPendingSuggestion()
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
