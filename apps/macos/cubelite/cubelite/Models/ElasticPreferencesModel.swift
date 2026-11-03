import Foundation
import Observation

/// What Settings → Integrations needs from Elasticsearch (ElasticService in
/// the app, a stub in tests).
protocol ElasticPreferencesBackend: Sendable {
    func detect(context: String) async throws -> [DetectedService]
    func test(context: String, endpoint: EsEndpoint, auth: EsAuth?) async throws -> EsInfo
    func saveAuth(context: String, endpoint: EsEndpoint, auth: EsAuth) async throws
    func authMethod(context: String, endpoint: EsEndpoint) async throws -> String
    func useEckCredentials(context: String, endpoint: EsEndpoint) async throws
}

extension ElasticService: ElasticPreferencesBackend {}

/// Form state of Settings → Integrations → Elasticsearch for one kube
/// context (#503, spec §5.2), mirroring the desktop's ElasticPreferences.
/// Secrets go straight to the keychain and are never read back: the form
/// only knows which method is stored.
@Observable @MainActor
final class ElasticPreferencesModel {

    typealias Mode = TargetFields.Mode

    enum AuthMethod: String, CaseIterable, Sendable {
        case none
        case basic
        case apiKey = "api-key"
        case bearer
        case eckUser = "eck-user"

        var label: String {
            switch self {
            case .none: "No authentication"
            case .basic: "User and password"
            case .apiKey: "API key"
            case .bearer: "Bearer token"
            case .eckUser: "ECK elastic user"
            }
        }
    }

    enum Busy: Sendable { case detect, test, save, eck }

    typealias Outcome = FormOutcome

    private(set) var context: String?
    /// Where the endpoint lives.
    let target = TargetFields(defaultPort: 9200, defaultHTTPS: true)
    /// Typed credentials (never read back from the keychain).
    let input = SecretInput()
    var indexPattern = EsEndpoint.defaultIndexPattern
    var preset = FieldPreset.ecs
    var kibanaURL = ""

    var authMethod = AuthMethod.none
    private(set) var storedMethod: AuthMethod?

    private(set) var detected: [DetectedService]?
    private(set) var busy: Busy?
    private(set) var outcome: Outcome?

    private let backend: any ElasticPreferencesBackend
    private let endpoints: ElasticEndpointStore

    init(backend: any ElasticPreferencesBackend, endpoints: ElasticEndpointStore) {
        self.backend = backend
        self.endpoints = endpoints
        // ECK's user is offered only in-cluster.
        target.onModeChange = { [weak self] in
            guard let self, !self.authMethods.contains(self.authMethod) else { return }
            self.authMethod = .none
        }
    }

    /// The saved endpoint of the shown context.
    var saved: EsEndpoint? { endpoints.endpoint(for: context) }

    /// Loads `context`'s saved endpoint; nothing from the previous context
    /// stays in the form.
    func load(context: String?) async {
        self.context = context
        outcome = nil
        detected = nil
        input.reset()
        authMethod = .none
        storedMethod = nil
        guard let endpoint = saved else {
            target.reset()
            indexPattern = EsEndpoint.defaultIndexPattern
            preset = .ecs
            kibanaURL = ""
            return
        }
        target.load(endpoint.target, skipTLSVerify: endpoint.skipTLSVerify)
        indexPattern = endpoint.indexPattern
        preset = endpoint.preset
        kibanaURL = endpoint.kibanaURL ?? ""
        await refreshStoredMethod(endpoint)
    }

    // MARK: Validation

    var kibanaProblem: String? { target.mode == .off ? nil : TargetFields.problem(kibanaURL) }

    var isIncomplete: Bool { target.isIncomplete || kibanaProblem != nil }

    /// Methods offered: ECK's user only for in-cluster endpoints.
    var authMethods: [AuthMethod] {
        target.mode == .inCluster ? AuthMethod.allCases : AuthMethod.allCases.filter { $0 != .eckUser }
    }

    // MARK: Draft

    func draft() -> EsEndpoint? {
        guard let target = target.target else { return nil }
        let pattern = indexPattern.trimmed
        let kibana = kibanaURL.trimmed
        return EsEndpoint(
            target: target, indexPattern: pattern.isEmpty ? EsEndpoint.defaultIndexPattern : pattern,
            preset: preset, kibanaURL: kibana.isEmpty ? nil : kibana, skipTLSVerify: self.target.skipTLSVerify)
    }

    /// Auth typed in the form, or nil to use the stored one.
    func typedAuth() -> EsAuth? {
        switch authMethod {
        case .none: storedMethod == AuthMethod.none ? nil : EsAuth.none
        case .basic:
            !input.username.isEmpty && !input.password.isEmpty
                ? .basic(username: input.username, password: input.password) : nil
        case .apiKey: input.secret.isEmpty ? nil : .apiKey(input.secret)
        case .bearer: input.secret.isEmpty ? nil : .bearer(input.secret)
        case .eckUser: nil
        }
    }

    func pick(_ found: DetectedService) {
        target.pick(namespace: found.namespace, name: found.name, port: found.port, https: found.https)
    }

    // MARK: Actions

    func detect() async {
        guard let context else { return }
        busy = .detect
        defer { busy = nil }
        do {
            let found = try await backend.detect(context: context)
            guard context == self.context else { return }
            detected = found.filter { $0.kind == .elasticsearch }
            if detected?.isEmpty ?? true {
                outcome = Outcome(ok: false, text: "No Elasticsearch service found in this cluster.")
            }
        } catch {
            if context == self.context { outcome = Outcome(ok: false, text: error.localizedDescription) }
        }
    }

    func test() async {
        guard let context, let endpoint = draft() else { return }
        busy = .test
        outcome = nil
        defer { busy = nil }
        do {
            let info = try await backend.test(context: context, endpoint: endpoint, auth: typedAuth())
            guard context == self.context else { return }
            var parts = ["Elasticsearch \(info.version)", info.clusterName]
            if let health = info.health { parts.append("health \(health)") }
            if let indices = info.indices { parts.append("\(indices) matching indices or data streams") }
            outcome = Outcome(ok: true, text: parts.filter { !$0.isEmpty }.joined(separator: " · "))
        } catch {
            if context == self.context { outcome = Outcome(ok: false, text: error.localizedDescription) }
        }
    }

    /// Saves the endpoint (or turns Elasticsearch off) and the typed credentials.
    func save() async {
        guard let context else { return }
        let endpoint = draft()
        busy = .save
        outcome = nil
        defer { busy = nil }
        do {
            if let endpoint {
                let auth = typedAuth()
                let moved = IntegrationForm.moved(
                    saved: saved.map { ($0.target, $0.skipTLSVerify) },
                    draft: (endpoint.target, endpoint.skipTLSVerify))
                if authMethod == .eckUser, storedMethod != .eckUser || moved {
                    try await backend.useEckCredentials(context: context, endpoint: endpoint)
                } else if let auth {
                    try await backend.saveAuth(context: context, endpoint: endpoint, auth: auth)
                } else if moved, let stored = storedMethod, stored != .none {
                    // Stored secrets only work with the endpoint they were saved for.
                    outcome = Outcome(ok: false, text: IntegrationForm.movedMessage)
                    return
                }
                input.clearSecrets()
            } else if let saved {
                // Turning it off also removes the stored secret and open connection.
                try await backend.saveAuth(context: context, endpoint: saved, auth: .none)
            }
            // Stored even if the form moved to another context meanwhile:
            // the keychain already matches this endpoint.
            endpoints.setEndpoint(endpoint, for: context)
            guard context == self.context else { return }
            if let endpoint { await refreshStoredMethod(endpoint) }
            outcome = Outcome(
                ok: true,
                text: endpoint == nil
                    ? "Elasticsearch off for \(context)" : "Elasticsearch saved for \(context)")
        } catch {
            if context == self.context { outcome = Outcome(ok: false, text: error.localizedDescription) }
        }
    }

    /// Checks ECK's `elastic` user can be read now and stores that choice.
    func useEck() async {
        guard let context, let endpoint = draft() else { return }
        busy = .eck
        outcome = nil
        defer { busy = nil }
        do {
            try await backend.useEckCredentials(context: context, endpoint: endpoint)
            guard context == self.context else { return }
            storedMethod = .eckUser
            authMethod = .eckUser
            outcome = Outcome(ok: true, text: "ECK credentials found; Save to keep this endpoint.")
        } catch {
            if context == self.context { outcome = Outcome(ok: false, text: error.localizedDescription) }
        }
    }

    private func refreshStoredMethod(_ endpoint: EsEndpoint) async {
        guard let context else { return }
        let method = try? await backend.authMethod(context: context, endpoint: endpoint)
        // A late answer for another context must not land here.
        guard context == self.context else { return }
        storedMethod = method.flatMap(AuthMethod.init(rawValue:))
        if let storedMethod { authMethod = storedMethod }
    }
}

