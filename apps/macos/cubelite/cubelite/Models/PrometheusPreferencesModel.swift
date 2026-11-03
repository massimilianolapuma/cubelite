import Foundation
import Observation

/// What Settings → Integrations → Prometheus needs (PrometheusService in
/// the app, a stub in tests).
protocol PrometheusPreferencesBackend: Sendable {
    func detect(context: String) async throws -> [DetectedPrometheus]
    func test(context: String, endpoint: PromEndpoint, auth: PromAuth?) async throws -> PromInfo
    func saveAuth(context: String, endpoint: PromEndpoint, auth: PromAuth) async throws
    func authMethod(context: String, endpoint: PromEndpoint) async throws -> String
}

extension PrometheusService: PrometheusPreferencesBackend {}

/// Form state of Settings → Integrations → Prometheus for one kube context
/// (#512, spec §5.3), mirroring the desktop's PrometheusPreferences.
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
    /// Kept while In cluster is shown, so a stored Azure CLI choice survives
    /// switching modes back and forth.
    var authMethod = AuthMethod.none
    private(set) var storedMethod: AuthMethod?

    private(set) var detected: [DetectedPrometheus]?
    private(set) var busy: Busy?
    private(set) var outcome: FormOutcome?

    private let backend: any PrometheusPreferencesBackend
    private let endpoints: PrometheusEndpointStore

    init(backend: any PrometheusPreferencesBackend, endpoints: PrometheusEndpointStore) {
        self.backend = backend
        self.endpoints = endpoints
    }

    var saved: PromEndpoint? { endpoints.endpoint(for: context) }

    /// Loads `context`'s saved endpoint; nothing from the previous context stays.
    func load(context: String?) async {
        self.context = context
        outcome = nil
        detected = nil
        input.reset()
        authMethod = .none
        storedMethod = nil
        guard let endpoint = saved else {
            target.reset()
            cluster = ""
            grafanaURL = ""
            grafanaDatasource = ""
            return
        }
        target.load(endpoint.target, skipTLSVerify: endpoint.skipTLSVerify)
        cluster = endpoint.cluster ?? ""
        grafanaURL = endpoint.grafanaURL ?? ""
        grafanaDatasource = endpoint.grafanaDatasource ?? ""
        await refreshStoredMethod(endpoint)
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

    var isIncomplete: Bool { target.isIncomplete || grafanaProblem != nil || azureProblem != nil }

    // MARK: Draft

    func draft() -> PromEndpoint? {
        guard let target = target.target else { return nil }
        return PromEndpoint(
            target: target, cluster: cluster.trimmed.nilIfBlank, grafanaURL: grafanaURL.trimmed.nilIfBlank,
            grafanaDatasource: grafanaDatasource.trimmed.nilIfBlank,
            skipTLSVerify: self.target.skipTLSVerify)
    }

    /// Auth typed in the form, or nil to use the stored one. In-cluster
    /// endpoints always use the cluster credentials.
    func typedAuth() -> PromAuth? {
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

    // MARK: Actions

    func detect() async {
        await run(.detect) { context in
            let found = try await self.backend.detect(context: context)
            guard context == self.context else { return }
            self.detected = found
            if found.isEmpty {
                self.outcome = FormOutcome(ok: false, text: "No Prometheus service found in this cluster.")
            }
        }
    }

    func test() async {
        guard let endpoint = draft() else { return }
        let auth = typedAuth()
        await run(.test) { context in
            let info = try await self.backend.test(context: context, endpoint: endpoint, auth: auth)
            guard context == self.context else { return }
            var parts = ["Prometheus \(info.version)"]
            parts.append(info.cadvisor ? "cAdvisor ✓" : "no cAdvisor series")
            parts.append(info.kubeStateMetrics ? "kube-state-metrics ✓" : "no kube-state-metrics series")
            if !info.clusters.isEmpty { parts.append("clusters: \(info.clusters.joined(separator: ", "))") }
            self.outcome = FormOutcome(ok: info.cadvisor, text: parts.joined(separator: " · "))
        }
    }

    /// Saves the endpoint (or turns Prometheus off) and the typed credentials.
    func save() async {
        let endpoint = draft()
        await run(.save) { context in
            if let endpoint {
                let moved = IntegrationForm.moved(
                    saved: self.saved.map { ($0.target, $0.skipTLSVerify) },
                    draft: (endpoint.target, endpoint.skipTLSVerify))
                if let auth = self.typedAuth() {
                    try await self.backend.saveAuth(context: context, endpoint: endpoint, auth: auth)
                } else if moved, let stored = self.storedMethod, stored != .none {
                    self.outcome = FormOutcome(ok: false, text: IntegrationForm.movedMessage)
                    return
                }
                self.input.clearSecrets()
            } else if let saved = self.saved {
                // Turning it off also removes the stored secret and open connection.
                try await self.backend.saveAuth(context: context, endpoint: saved, auth: .none)
            }
            // Stored even if the form moved to another context meanwhile.
            self.endpoints.setEndpoint(endpoint, for: context)
            guard context == self.context else { return }
            if let endpoint {
                await self.refreshStoredMethod(endpoint)
            } else {
                self.storedMethod = nil
            }
            self.outcome = FormOutcome(
                ok: true, text: endpoint == nil ? "Prometheus off for \(context)" : "Prometheus saved for \(context)")
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
