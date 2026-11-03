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

    enum Mode: String, CaseIterable, Sendable {
        case off, inCluster, external

        var label: String {
            switch self {
            case .off: "Off"
            case .inCluster: "In cluster"
            case .external: "External"
            }
        }
    }

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

    struct Outcome: Equatable, Sendable {
        let ok: Bool
        let text: String
    }

    private(set) var context: String?
    var mode = Mode.off
    var namespace = ""
    var service = ""
    var port = 9200
    var https = true
    var url = ""
    var indexPattern = EsEndpoint.defaultIndexPattern
    var preset = FieldPreset.ecs
    var kibanaURL = ""
    var skipTLSVerify = false

    var authMethod = AuthMethod.none
    var username = ""
    var password = ""
    var secret = ""
    private(set) var storedMethod: AuthMethod?

    private(set) var detected: [DetectedService]?
    private(set) var busy: Busy?
    private(set) var outcome: Outcome?

    private let backend: any ElasticPreferencesBackend
    private let endpoints: ElasticEndpointStore

    init(backend: any ElasticPreferencesBackend, endpoints: ElasticEndpointStore) {
        self.backend = backend
        self.endpoints = endpoints
    }

    /// The saved endpoint of the shown context.
    var saved: EsEndpoint? { endpoints.endpoint(for: context) }

    /// Loads `context`'s saved endpoint; nothing from the previous context
    /// stays in the form.
    func load(context: String?) async {
        self.context = context
        outcome = nil
        detected = nil
        password = ""
        secret = ""
        username = ""
        authMethod = .none
        storedMethod = nil
        guard let endpoint = saved else {
            mode = .off
            namespace = ""
            service = ""
            port = 9200
            https = true
            url = ""
            indexPattern = EsEndpoint.defaultIndexPattern
            preset = .ecs
            kibanaURL = ""
            skipTLSVerify = false
            return
        }
        switch endpoint.target {
        case .inCluster(let ns, let svc, let p, let secure):
            mode = .inCluster
            (namespace, service, port, https) = (ns, svc, p, secure)
            url = ""
        case .external(let address):
            mode = .external
            url = address
        }
        indexPattern = endpoint.indexPattern
        preset = endpoint.preset
        kibanaURL = endpoint.kibanaURL ?? ""
        skipTLSVerify = endpoint.skipTLSVerify
        await refreshStoredMethod(endpoint)
    }

    // MARK: Validation

    var urlProblem: String? { mode == .external ? Self.problem(url) : nil }
    var kibanaProblem: String? { mode == .off ? nil : Self.problem(kibanaURL) }

    var isIncomplete: Bool {
        if urlProblem != nil || kibanaProblem != nil { return true }
        switch mode {
        case .off: return false
        case .inCluster:
            return namespace.trimmed.isEmpty || service.trimmed.isEmpty
                || !(1...65535).contains(port)
        case .external: return url.trimmed.isEmpty
        }
    }

    /// Methods offered: ECK's user only for in-cluster endpoints.
    var authMethods: [AuthMethod] {
        mode == .inCluster ? AuthMethod.allCases : AuthMethod.allCases.filter { $0 != .eckUser }
    }

    /// Credentials in a URL would bypass the keychain.
    static func problem(_ value: String) -> String? {
        let v = value.trimmed
        guard !v.isEmpty else { return nil }
        guard let parts = URLComponents(string: v), let host = parts.host, !host.isEmpty else {
            return "Not a valid URL."
        }
        guard ["http", "https"].contains(parts.scheme?.lowercased() ?? "") else {
            return "Use an http:// or https:// URL."
        }
        if parts.user != nil || parts.password != nil {
            return "Remove the credentials from the URL; use the authentication fields."
        }
        return nil
    }

    // MARK: Draft

    func draft() -> EsEndpoint? {
        let target: EsTarget
        switch mode {
        case .off: return nil
        case .inCluster:
            target = .inCluster(
                namespace: namespace.trimmed, service: service.trimmed, port: port, https: https)
        case .external:
            target = .external(url: url.trimmed)
        }
        let pattern = indexPattern.trimmed
        let kibana = kibanaURL.trimmed
        return EsEndpoint(
            target: target, indexPattern: pattern.isEmpty ? EsEndpoint.defaultIndexPattern : pattern,
            preset: preset, kibanaURL: kibana.isEmpty ? nil : kibana, skipTLSVerify: skipTLSVerify)
    }

    /// Auth typed in the form, or nil to use the stored one.
    func typedAuth() -> EsAuth? {
        switch authMethod {
        case .none: storedMethod == AuthMethod.none ? nil : EsAuth.none
        case .basic:
            !username.isEmpty && !password.isEmpty
                ? .basic(username: username, password: password) : nil
        case .apiKey: secret.isEmpty ? nil : .apiKey(secret)
        case .bearer: secret.isEmpty ? nil : .bearer(secret)
        case .eckUser: nil
        }
    }

    func pick(_ found: DetectedService) {
        namespace = found.namespace
        service = found.name
        port = found.port
        https = found.https
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
                let moved =
                    saved.map { (try? Elastic.binding($0)) != (try? Elastic.binding(endpoint)) }
                    ?? false
                if authMethod == .eckUser, storedMethod != .eckUser || moved {
                    try await backend.useEckCredentials(context: context, endpoint: endpoint)
                } else if let auth {
                    try await backend.saveAuth(context: context, endpoint: endpoint, auth: auth)
                } else if moved, let stored = storedMethod, stored != .none {
                    // Stored secrets only work with the endpoint they were saved for.
                    outcome = Outcome(
                        ok: false,
                        text:
                            "The endpoint or TLS setting changed: enter the credentials again (or choose No authentication)."
                    )
                    return
                }
                password = ""
                secret = ""
            } else if let saved {
                // Turning it off also removes the stored secret and open connection.
                try await backend.saveAuth(context: context, endpoint: saved, auth: .none)
            }
            guard context == self.context else { return }
            endpoints.setEndpoint(endpoint, for: context)
            if let endpoint { await refreshStoredMethod(endpoint) }
            outcome = Outcome(
                ok: true,
                text: endpoint == nil
                    ? "Elasticsearch off for \(context)" : "Elasticsearch saved for \(context)")
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

extension String {
    fileprivate var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
