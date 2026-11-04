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
    /// Closes the context's connections and Kibana forwards (endpoint changed).
    func disconnect(context: String) async
}

extension ElasticService: ElasticPreferencesBackend {}

/// Form state of Settings → Integrations → Elasticsearch for one kube
/// context or the default shared by every context (#503 spec §5.2, #528),
/// mirroring the desktop's ElasticPreferences.
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
    /// In-cluster Kibana picked from Detect, opened through a port-forward
    /// when there is no Kibana URL (#519).
    var kibanaService: KibanaService?
    /// Cluster filter (#528): field (blank = the default's, or
    /// `orchestrator.cluster.name` with ECS) and value.
    var clusterField = ""
    var clusterValue = ""

    var authMethod = AuthMethod.none
    private(set) var storedMethod: AuthMethod?

    private(set) var detected: [DetectedService]?
    /// Kibana services found by the last Detect.
    private(set) var detectedKibana: [DetectedService] = []
    private(set) var busy: Busy?
    private(set) var outcome: Outcome?
    /// This context's endpoint or the default (#528).
    let scope: EndpointScopeModel<EsEndpoint>

    private let backend: any ElasticPreferencesBackend
    private let endpoints: ElasticEndpointStore
    /// Called with the context when Save turned Elasticsearch off, so the
    /// banner does not offer it again (#527).
    @ObservationIgnored var onTurnedOff: ((String) -> Void)?

    init(backend: any ElasticPreferencesBackend, endpoints: ElasticEndpointStore) {
        self.backend = backend
        self.endpoints = endpoints
        scope = EndpointScopeModel(store: endpoints)
        // ECK's user is offered only in-cluster.
        target.onModeChange = { [weak self] in
            guard let self, !self.authMethods.contains(self.authMethod) else { return }
            self.authMethod = .none
        }
    }

    /// What the form shows for the context (#528).
    var view: ScopeView { scope.view(for: context) }

    /// The saved endpoint the form edits: the context's own, or the default.
    var saved: EsEndpoint? { scope.saved(view, context: context) }

    /// Loads `context`'s saved endpoint; nothing from the previous context
    /// stays in the form.
    func load(context: String?) async {
        if context != self.context { scope.overriding = false }
        self.context = context
        outcome = nil
        detected = nil
        detectedKibana = []
        input.reset()
        authMethod = .none
        storedMethod = nil
        let view = self.view
        guard let endpoint = saved ?? scope.prefill(view) else {
            target.reset()
            indexPattern = EsEndpoint.defaultIndexPattern
            preset = .ecs
            kibanaURL = ""
            kibanaService = nil
            // On the default, the context's own filter.
            let own = view == .inherited ? context.flatMap { endpoints.contextSettings[$0]?.clusterFilter } : nil
            clusterField = own?.field ?? ""
            clusterValue = own?.value ?? ""
            return
        }
        target.load(endpoint.target, skipTLSVerify: endpoint.skipTLSVerify)
        indexPattern = endpoint.indexPattern
        preset = endpoint.preset
        kibanaURL = endpoint.kibanaURL ?? ""
        kibanaService = endpoint.kibanaService
        clusterField = endpoint.clusterFilter?.field ?? ""
        clusterValue = endpoint.clusterFilter?.value ?? ""
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
        let result = await scope.turnOff(context, name: "Elasticsearch", onTurnedOff: onTurnedOff) {
            await self.backend.disconnect(context: $0)
        }
        await load(context: context)
        outcome = result
    }

    func useDefault() async {
        guard let context else { return }
        let result = await scope.useDefault(
            context, name: "Elasticsearch",
            removeSecret: { try await self.backend.saveAuth(context: context, endpoint: $0, auth: .none) },
            disconnect: { await self.backend.disconnect(context: $0) })
        await load(context: context)
        outcome = result
    }

    /// The placeholder of the cluster field: the field used when left blank.
    var clusterFieldHint: String {
        view == .inherited
            ? ClusterFilter.fieldHint(
                preset: endpoints.defaultEndpoint?.preset ?? .ecs,
                fallback: endpoints.defaultEndpoint?.clusterFilter?.field)
            : ClusterFilter.fieldHint(preset: preset, fallback: nil)
    }

    /// The endpoint Test connection reaches.
    private func tested() -> EsEndpoint? {
        let view = self.view
        if view == .inherited {
            return endpoints.defaultEndpoint(
                with: ElasticContextSettings(clusterFilter: ClusterFilter.typed(field: clusterField, value: clusterValue)))
        }
        return draft().map { scope.forBackend($0, view: view) }
    }

    // MARK: Validation

    var kibanaProblem: String? { target.mode == .off ? nil : TargetFields.problem(kibanaURL) }

    var isIncomplete: Bool { view != .inherited && (target.isIncomplete || kibanaProblem != nil) }

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
            preset: preset, kibanaURL: kibana.isEmpty ? nil : kibana,
            kibanaService: self.target.mode == .inCluster ? kibanaService : nil,
            skipTLSVerify: self.target.skipTLSVerify,
            clusterFilter: ClusterFilter.typed(field: clusterField, value: clusterValue))
    }

    /// Auth typed in the form, or nil to use the stored one.
    func typedAuth() -> EsAuth? {
        if view == .inherited { return nil }
        return switch authMethod {
        case .none: storedMethod == AuthMethod.none ? nil : EsAuth.none
        case .basic:
            !input.username.isEmpty && !input.password.isEmpty
                ? .basic(username: input.username, password: input.password) : nil
        case .apiKey: input.secret.isEmpty ? nil : .apiKey(input.secret)
        case .bearer: input.secret.isEmpty ? nil : .bearer(input.secret)
        case .eckUser: nil
        }
    }

    /// Uses a detected Kibana service for Open in Kibana.
    func pickKibana(_ found: DetectedService) {
        kibanaService = KibanaService(
            namespace: found.namespace, service: found.name, port: found.port, https: found.https)
    }

    func pick(_ found: DetectedService) {
        target.pick(namespace: found.namespace, name: found.name, port: found.port, https: found.https)
    }

    /// Fills the form with a service found when the context connected
    /// (#527): in cluster, its Kibana and, for ECK, ECK's `elastic` user.
    /// Nothing is saved, and a saved endpoint is never replaced.
    /// `candidates` (every service found, best first) fill the detected
    /// list so another can be picked.
    func suggest(_ found: DetectedService, kibana: DetectedService?, candidates: [DetectedService] = []) {
        guard saved == nil else { return }
        target.mode = .inCluster
        pick(found)
        if let kibana { pickKibana(kibana) }
        authMethod = found.isECK ? .eckUser : .none
        if !candidates.isEmpty {
            detected = candidates.filter { $0.kind == .elasticsearch }
            detectedKibana = candidates.filter { $0.kind == .kibana }
        }
        outcome = FormOutcome(ok: true, text: IntegrationForm.suggestedMessage)
    }

    /// Tests the form's endpoint, ECK's user read only now, then saves it;
    /// nothing is saved when the test fails (#527).
    func testThenSave() async -> EnableResult<EsInfo> {
        guard let context, let endpoint = draft() else { return .failed("Nothing to save") }
        let auth = authMethod == .eckUser ? EsAuth.eckUser : typedAuth()
        return await IntegrationForm.testThenSave(
            test: { try await self.backend.test(context: context, endpoint: endpoint, auth: auth) },
            save: { await self.save(); return self.outcome })
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
            detectedKibana = found.filter { $0.kind == .kibana }
            if detected?.isEmpty ?? true {
                let kibana = !detectedKibana.isEmpty ? " (only Kibana was found)" : ""
                outcome = Outcome(ok: false, text: "No Elasticsearch service found in this cluster\(kibana).")
            }
        } catch {
            if context == self.context { outcome = Outcome(ok: false, text: error.localizedDescription) }
        }
    }

    func test() async {
        guard let context, let endpoint = tested() else { return }
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

    /// Saves the endpoint (or turns Elasticsearch off) and the typed
    /// credentials; on the default, this context's cluster filter only.
    func save() async {
        guard let context else { return }
        let view = self.view
        if view == .inherited {
            let filter = ClusterFilter.typed(field: clusterField, value: clusterValue)
            endpoints.setSettings(filter.map { ElasticContextSettings(clusterFilter: $0) }, for: context)
            outcome = Outcome(ok: true, text: "Elasticsearch cluster filter saved for \(context)")
            return
        }
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
                    try await backend.saveAuth(
                        context: context, endpoint: scope.forBackend(endpoint, view: view), auth: auth)
                } else if moved, let stored = storedMethod, stored != .none {
                    // Stored secrets only work with the endpoint they were saved for.
                    outcome = Outcome(ok: false, text: IntegrationForm.movedMessage)
                    return
                }
                input.clearSecrets()
            } else if let saved {
                // Turning it off also removes the stored secret and open connection.
                try await backend.saveAuth(
                    context: context, endpoint: scope.forBackend(saved, view: view), auth: .none)
            }
            // Stored even if the form moved to another context meanwhile:
            // the keychain already matches this endpoint.
            scope.apply(endpoint, view: view, context: context)
            if endpoint == nil, view != .sharedDefault { onTurnedOff?(context) }
            // A changed endpoint or Kibana service must not keep old forwards.
            await backend.disconnect(context: context)
            guard context == self.context else { return }
            if let endpoint {
                await refreshStoredMethod(scope.forBackend(endpoint, view: view))
            } else {
                storedMethod = nil
            }
            outcome = Outcome(
                ok: true,
                text: EndpointScopeModel<EsEndpoint>.savedText(
                    name: "Elasticsearch", view: view, saved: endpoint != nil, context: context))
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

