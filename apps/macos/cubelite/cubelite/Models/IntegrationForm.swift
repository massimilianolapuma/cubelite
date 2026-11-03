import Foundation
import Observation

/// Where an integration's endpoint lives, as typed in Settings (shared by
/// Elasticsearch #503 and Prometheus #512): off, a service in the cluster,
/// or an external URL.
@Observable @MainActor
final class TargetFields {

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

    var mode = Mode.off {
        didSet { if mode != oldValue { onModeChange?() } }
    }
    var namespace = ""
    var service = ""
    var port: Int
    var https: Bool
    var url = ""
    var skipTLSVerify = false

    /// Called when the mode changes (an integration drops auth methods that
    /// no longer apply).
    @ObservationIgnored var onModeChange: (() -> Void)?

    private let defaultPort: Int
    private let defaultHTTPS: Bool

    init(defaultPort: Int, defaultHTTPS: Bool) {
        self.defaultPort = defaultPort
        self.defaultHTTPS = defaultHTTPS
        port = defaultPort
        https = defaultHTTPS
    }

    /// Back to "off" with defaults: nothing from another context may leak.
    func reset() {
        mode = .off
        namespace = ""
        service = ""
        port = defaultPort
        https = defaultHTTPS
        url = ""
        skipTLSVerify = false
    }

    func load(_ target: IntegrationTarget, skipTLSVerify: Bool) {
        switch target {
        case .inCluster(let ns, let svc, let p, let secure):
            mode = .inCluster
            (namespace, service, port, https) = (ns, svc, p, secure)
            url = ""
        case .external(let address):
            mode = .external
            url = address
        }
        self.skipTLSVerify = skipTLSVerify
    }

    /// A service found by Detect.
    func pick(namespace: String, name: String, port: Int, https: Bool) {
        self.namespace = namespace
        service = name
        self.port = port
        self.https = https
    }

    /// The target typed in the form; nil when off.
    var target: IntegrationTarget? {
        switch mode {
        case .off: nil
        case .inCluster:
            .inCluster(namespace: namespace.trimmed, service: service.trimmed, port: port, https: https)
        case .external: .external(url: url.trimmed)
        }
    }

    var urlProblem: String? { mode == .external ? Self.problem(url) : nil }

    var isIncomplete: Bool {
        if urlProblem != nil { return true }
        switch mode {
        case .off: return false
        case .inCluster:
            return namespace.trimmed.isEmpty || service.trimmed.isEmpty || !(1...65535).contains(port)
        case .external: return url.trimmed.isEmpty
        }
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
}

/// Typed credentials: what the user entered, never what is stored.
@Observable @MainActor
final class SecretInput {
    var username = ""
    var password = ""
    var secret = ""

    func clearSecrets() {
        password = ""
        secret = ""
    }

    func reset() {
        username = ""
        clearSecrets()
    }
}

/// Result line under the integration forms.
struct FormOutcome: Equatable, Sendable {
    let ok: Bool
    let text: String
}

/// What the banner's Enable got (#527): saved, with the test's facts, or
/// why nothing was saved.
enum EnableResult<Info: Sendable>: Sendable {
    case saved(Info)
    case failed(String)
}

enum IntegrationForm {

    /// Shown when stored secrets no longer apply after the endpoint moved.
    static let movedMessage =
        "The endpoint or TLS setting changed: enter the credentials again (or choose No authentication)."

    /// Shown when the banner's Review pre-filled the form (#527).
    static let suggestedMessage = "Found in this cluster: Test, then Save."

    /// The banner's Enable (#527): `test`, then `save` only when it passed;
    /// `save` returns the form's outcome.
    @MainActor
    static func testThenSave<Info: Sendable>(
        test: () async throws -> Info, save: () async -> FormOutcome?
    ) async -> EnableResult<Info> {
        let info: Info
        do {
            info = try await test()
        } catch {
            return .failed(error.localizedDescription)
        }
        if let outcome = await save(), !outcome.ok { return .failed(outcome.text) }
        return .saved(info)
    }

    /// Whether `draft` is bound differently from `saved` (stored secrets
    /// only work with the endpoint they were saved for).
    static func moved(saved: (IntegrationTarget, Bool)?, draft: (IntegrationTarget, Bool)) -> Bool {
        guard let saved else { return false }
        return (try? Integration.binding(saved.0, skipTLSVerify: saved.1))
            != (try? Integration.binding(draft.0, skipTLSVerify: draft.1))
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
