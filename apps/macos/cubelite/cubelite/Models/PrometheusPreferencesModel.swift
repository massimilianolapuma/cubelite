import Foundation
import Observation

/// What Settings → Integrations → Prometheus needs (PrometheusService in
/// the app, a stub in tests).
protocol PrometheusPreferencesBackend: Sendable {
    func detect(context: String) async throws -> [DetectedPrometheus]
    func test(context: String, endpoint: PromEndpoint, auth: PromAuth?) async throws -> PromInfo
    func saveAuth(context: String, endpoint: PromEndpoint, auth: PromAuth) async throws
    func authMethod(context: String, endpoint: PromEndpoint) async throws -> String
    /// Closes the context's connections and Grafana forwards (endpoint changed).
    func disconnect(context: String) async
}

extension PrometheusService: PrometheusPreferencesBackend {}

/// Form state of Settings → Integrations → Prometheus for one kube context
/// or the default shared by every context (#512 spec §5.3, #528), mirroring
/// the desktop's PrometheusPreferences.
/// In-cluster endpoints use the cluster credentials; external ones take
/// basic, bearer or an Azure CLI token. Secrets are never read back.
@Observable @MainActor
final class PrometheusPreferencesModel {

    enum AuthMethod: String, CaseIterable, Sendable {
        case none
        case basic
        case bearer
        case azureCLI = "azure-cli"

        var label: String {
            switch self {
            case .none: "No authentication"
            case .basic: "User and password"
            case .bearer: "Bearer token"
            case .azureCLI: "Azure CLI (Azure Monitor)"
            }
        }
    }

    enum Busy: Sendable { case detect, test, save }

    private(set) var context: String?
    let target = TargetFields(defaultPort: 9090, defaultHTTPS: false)
    let input = SecretInput()
    var cluster = ""
    var grafanaURL = ""
    var grafanaDatasource = ""
    /// In-cluster Grafana picked from Detect, opened through a port-forward
    /// when there is no Grafana URL (#525).
    var grafanaService: GrafanaService?
    /// Kept while In cluster is shown, so a stored Azure CLI choice survives
    /// switching modes back and forth.
    var authMethod = AuthMethod.none
    private(set) var storedMethod: AuthMethod?

    private(set) var detected: [DetectedPrometheus]?
    /// Grafana services found by the last Detect.
    private(set) var detectedGrafana: [DetectedPrometheus] = []
    /// `cluster` values found by the last Test connection (#528).
    private(set) var foundClusters: [String]?
    /// This context's endpoint or the default (#528).
    let scope: EndpointScopeModel<PromEndpoint>
    private(set) var busy: Busy?
    private(set) var outcome: FormOutcome?

    private let backend: any PrometheusPreferencesBackend
    private let endpoints: PrometheusEndpointStore
    /// Called with the context when Save turned Prometheus off, so the
    /// banner does not offer it again (#527).
    @ObservationIgnored var onTurnedOff: ((String) -> Void)?

    init(backend: any PrometheusPreferencesBackend, endpoints: PrometheusEndpointStore) {
        self.backend = backend
        self.endpoints = endpoints
        scope = EndpointScopeModel(store: endpoints)
    }

    /// What the form shows for the context (#528).
    var view: ScopeView { scope.view(for: context) }

    /// The saved endpoint the form edits: the context's own, or the default.
    var saved: PromEndpoint? { scope.saved(view, context: context) }

    /// Loads `context`'s saved endpoint; nothing from the previous context stays.
    func load(context: String?) async {
        if context != self.context { scope.overriding = false }
        self.context = context
        outcome = nil
        detected = nil
        detectedGrafana = []
        foundClusters = nil
        input.reset()
        authMethod = .none
        storedMethod = nil
        let view = self.view
        guard let endpoint = saved ?? scope.prefill(view) else {
            target.reset()
            // On the default, the context's own label.
            cluster = view == .inherited ? context.flatMap { endpoints.contextSettings[$0]?.cluster } ?? "" : ""
            grafanaURL = ""
            grafanaDatasource = ""
            grafanaService = nil
            return
        }
        target.load(endpoint.target, skipTLSVerify: endpoint.skipTLSVerify)
        cluster = endpoint.cluster ?? ""
        grafanaURL = endpoint.grafanaURL ?? ""
        grafanaDatasource = endpoint.grafanaDatasource ?? ""
        grafanaService = endpoint.grafanaService
        if saved != nil { await refreshStoredMethod(scope.forBackend(endpoint, view: view)) }
    }

    // MARK: Scope (#528)

    func setScope(_ kind: EndpointScopeKind) async {
        scope.kind = kind
        await load(context: context)
    }

    /// Gives a context using the default an endpoint of its own.
    func override() async {
        scope.overriding = true
        await load(context: context)
    }

    func turnOff() async {
        guard let context else { return }
        let result = await scope.turnOff(context, name: "Prometheus", onTurnedOff: onTurnedOff) {
            await self.backend.disconnect(context: $0)
        }
        await load(context: context)
        outcome = result
    }

    func useDefault() async {
        guard let context else { return }
        let result = await scope.useDefault(
            context, name: "Prometheus",
            removeSecret: { try await self.backend.saveAuth(context: context, endpoint: $0, auth: .none) },
            disconnect: { await self.backend.disconnect(context: $0) })
        await load(context: context)
        outcome = result
    }

    /// The default with the label typed for this context (Test on the default).
    private var contextDraft: PrometheusContextSettings? {
        cluster.trimmed.isEmpty ? nil : PrometheusContextSettings(cluster: cluster.trimmed)
    }

    /// The endpoint Test connection reaches.
    private func tested() -> PromEndpoint? {
        let view = self.view
        if view == .inherited { return endpoints.defaultEndpoint(with: contextDraft) }
        return draft().map { scope.forBackend($0, view: view) }
    }

    // MARK: Validation

    var grafanaProblem: String? { target.mode == .off ? nil : TargetFields.problem(grafanaURL) }

    /// Azure CLI tokens go only to Azure Monitor query endpoints.
    var azureProblem: String? {
        guard target.mode == .external, authMethod == .azureCLI else { return nil }
        guard let url = URL(string: target.url.trimmed), Prometheus.isAzureMonitorURL(url) else {
            return "Azure CLI sign-in works only with https://…prometheus.monitor.azure.com endpoints."
        }
        return nil
    }

    var isIncomplete: Bool {
        view != .inherited && (target.isIncomplete || grafanaProblem != nil || azureProblem != nil)
    }

    // MARK: Draft

    func draft() -> PromEndpoint? {
        guard let target = target.target else { return nil }
        return PromEndpoint(
            target: target, cluster: cluster.trimmed.nilIfBlank, grafanaURL: grafanaURL.trimmed.nilIfBlank,
            grafanaDatasource: grafanaDatasource.trimmed.nilIfBlank,
            grafanaService: self.target.mode == .inCluster ? grafanaService : nil,
            skipTLSVerify: self.target.skipTLSVerify)
    }

    /// Auth typed in the form, or nil to use the stored one. In-cluster
    /// endpoints always use the cluster credentials.
    func typedAuth() -> PromAuth? {
        if view == .inherited { return nil }
        if target.mode == .inCluster { return storedMethod == AuthMethod.none ? nil : PromAuth.none }
        switch authMethod {
        case .none: return storedMethod == AuthMethod.none ? nil : PromAuth.none
        case .basic:
            return !input.username.isEmpty && !input.password.isEmpty
                ? .basic(username: input.username, password: input.password) : nil
        case .bearer: return input.secret.isEmpty ? nil : .bearer(input.secret)
        case .azureCLI: return .azureCLI
        }
    }

    func pick(_ found: DetectedPrometheus) {
        target.pick(namespace: found.namespace, name: found.name, port: found.port, https: found.https)
    }

    /// Uses a detected Grafana service for Open in Grafana.
    func pickGrafana(_ found: DetectedPrometheus) {
        grafanaService = found.serviceRef
    }

    /// Fills the form with a service found when the context connected
    /// (#527): in cluster and its Grafana. Nothing is saved, and a saved
    /// endpoint is never replaced. `candidates` (every service found, best
    /// first) fill the detected list so another can be picked.
    func suggest(_ found: DetectedPrometheus, grafana: DetectedPrometheus?, candidates: [DetectedPrometheus] = []) {
        guard saved == nil else { return }
        target.mode = .inCluster
        pick(found)
        if let grafana { pickGrafana(grafana) }
        if !candidates.isEmpty {
            detected = candidates.filter { $0.kind == .prometheus }
            detectedGrafana = candidates.filter { $0.kind == .grafana }
        }
        outcome = FormOutcome(ok: true, text: IntegrationForm.suggestedMessage)
    }

    /// Tests the form's endpoint, then saves it; nothing is saved when the
    /// test fails (#527).
    func testThenSave() async -> EnableResult<PromInfo> {
        guard let context, let endpoint = draft() else { return .failed("Nothing to save") }
        let auth = typedAuth()
        return await IntegrationForm.testThenSave(
            test: { try await self.backend.test(context: context, endpoint: endpoint, auth: auth) },
            save: { await self.save(); return self.outcome })
    }

    // MARK: Actions

    func detect() async {
        await run(.detect) { context in
            let found = try await self.backend.detect(context: context)
            guard context == self.context else { return }
            self.detected = found.filter { $0.kind == .prometheus }
            self.detectedGrafana = found.filter { $0.kind == .grafana }
            if self.detected?.isEmpty ?? true {
                let grafana = !self.detectedGrafana.isEmpty ? " (only Grafana was found)" : ""
                self.outcome = FormOutcome(ok: false, text: "No Prometheus service found in this cluster\(grafana).")
            }
        }
    }

    func test() async {
        guard let endpoint = tested() else { return }
        let auth = typedAuth()
        let view = self.view
        await run(.test) { context in
            let info = try await self.backend.test(context: context, endpoint: endpoint, auth: auth)
            guard context == self.context else { return }
            self.foundClusters = info.clusters
            // Preselect this context's cluster in a shared workspace (#528).
            if view != .sharedDefault, self.cluster.trimmed.isEmpty,
                let match = ClusterLabel.match(info.clusters, context: context)
            {
                self.cluster = match
            }
            var parts = ["Prometheus \(info.version)"]
            parts.append(info.cadvisor ? "cAdvisor ✓" : "no cAdvisor series")
            parts.append(info.kubeStateMetrics ? "kube-state-metrics ✓" : "no kube-state-metrics series")
            if !info.clusters.isEmpty { parts.append("clusters: \(info.clusters.joined(separator: ", "))") }
            self.outcome = FormOutcome(ok: info.cadvisor, text: parts.joined(separator: " · "))
        }
    }

    /// Saves the endpoint (or turns Prometheus off) and the typed credentials;
    /// on the default, this context's `cluster` label only.
    func save() async {
        let view = self.view
        if view == .inherited {
            guard let context else { return }
            endpoints.setSettings(contextDraft, for: context)
            outcome = FormOutcome(ok: true, text: "Prometheus cluster label saved for \(context)")
            return
        }
        let endpoint = draft()
        await run(.save) { context in
            if let endpoint {
                let moved = IntegrationForm.moved(
                    saved: self.saved.map { ($0.target, $0.skipTLSVerify) },
                    draft: (endpoint.target, endpoint.skipTLSVerify))
                if let auth = self.typedAuth() {
                    try await self.backend.saveAuth(
                        context: context, endpoint: self.scope.forBackend(endpoint, view: view), auth: auth)
                } else if moved, let stored = self.storedMethod, stored != .none {
                    self.outcome = FormOutcome(ok: false, text: IntegrationForm.movedMessage)
                    return
                }
                self.input.clearSecrets()
            } else if let saved = self.saved {
                // Turning it off also removes the stored secret and open connection.
                try await self.backend.saveAuth(
                    context: context, endpoint: self.scope.forBackend(saved, view: view), auth: .none)
            }
            // Stored even if the form moved to another context meanwhile.
            self.scope.apply(endpoint, view: view, context: context)
            if endpoint == nil, view != .sharedDefault { self.onTurnedOff?(context) }
            // A changed endpoint or Grafana service must not keep old forwards.
            await self.backend.disconnect(context: context)
            guard context == self.context else { return }
            if let endpoint {
                await self.refreshStoredMethod(self.scope.forBackend(endpoint, view: view))
            } else {
                self.storedMethod = nil
            }
            self.outcome = FormOutcome(
                ok: true,
                text: EndpointScopeModel<PromEndpoint>.savedText(
                    name: "Prometheus", view: view, saved: endpoint != nil, context: context))
        }
    }

    /// Runs an action for the shown context: busy state, error outcome.
    private func run(_ kind: Busy, _ body: @MainActor (String) async throws -> Void) async {
        guard let context else { return }
        busy = kind
        outcome = nil
        defer { busy = nil }
        do {
            try await body(context)
        } catch {
            if context == self.context { outcome = FormOutcome(ok: false, text: error.localizedDescription) }
        }
    }

    private func refreshStoredMethod(_ endpoint: PromEndpoint) async {
        guard let context else { return }
        let method = try? await backend.authMethod(context: context, endpoint: endpoint)
        guard context == self.context else { return }
        storedMethod = method.flatMap(AuthMethod.init(rawValue:))
        if let storedMethod { authMethod = storedMethod }
    }
}

extension String {
    fileprivate var nilIfBlank: String? { isEmpty ? nil : self }
}
