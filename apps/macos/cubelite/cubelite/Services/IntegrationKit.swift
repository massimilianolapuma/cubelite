import Foundation
import Security

// Infrastructure shared by the HTTP integrations (Elasticsearch #502,
// Prometheus #511): cluster access, keychain records bound to their
// endpoint, the in-cluster tunnel, TLS trust, connections and their cache.

// MARK: - Cluster access

/// What the integrations need from the Kubernetes API (KubeAPIService in
/// the app, a stub in tests).
protocol IntegrationClusterAccess: Sendable {
    /// Raw GET; nil when the object does not exist (404).
    func getIfPresent(path: String, inContext contextName: String?) async throws -> Data?
    func portForwardWebSocket(
        namespace: String, pod: String, remotePort: Int, inContext contextName: String?
    ) async throws -> URLSessionWebSocketTask
    /// Raw GET with its status (the API server's service proxy, #511).
    func rawGet(path: String, inContext contextName: String?) async throws -> (
        status: Int, body: Data
    )
}

extension KubeAPIService: IntegrationClusterAccess {}

/// Where the credentials record lives (the keychain in the app).
protocol IntegrationSecretStore: Sendable {
    func read(account: String) async throws -> Data?
    func write(_ data: Data, account: String) async throws
    func delete(account: String) async throws
}

/// Keychain-backed store: one generic password per kube context.
struct KeychainSecrets: IntegrationSecretStore {
    let tag: KeychainService.CredentialTag
    private let keychain = KeychainService()

    init(tag: KeychainService.CredentialTag) {
        self.tag = tag
    }

    func read(account: String) async throws -> Data? {
        try await keychain.retrieve(tag: tag, account: account)
    }

    func write(_ data: Data, account: String) async throws {
        try await keychain.store(data, tag: tag, account: account)
    }

    func delete(account: String) async throws {
        try await keychain.delete(tag: tag, account: account)
    }
}

// MARK: - Kubernetes objects (only the fields discovery reads)

enum IntegrationK8s {
    struct List<Item: Decodable>: Decodable {
        let items: [Item]
    }

    struct Meta: Decodable, Sendable {
        var name: String?
        var namespace: String?
        var labels: [String: String]?
    }

    enum IntOrString: Decodable, Sendable, Equatable {
        case int(Int)
        case string(String)

        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let n = try? c.decode(Int.self) {
                self = .int(n)
            } else {
                self = .string(try c.decode(String.self))
            }
        }
    }

    struct Service: Decodable, Sendable {
        struct Port: Decodable, Sendable {
            var name: String?
            var port: Int
            var targetPort: IntOrString?
        }
        struct Spec: Decodable, Sendable {
            var ports: [Port]?
            var selector: [String: String]?
        }
        var metadata = Meta()
        var spec: Spec?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            metadata = try c.decodeIfPresent(Meta.self, forKey: .metadata) ?? Meta()
            spec = try c.decodeIfPresent(Spec.self, forKey: .spec)
        }

        private enum CodingKeys: String, CodingKey { case metadata, spec }
    }

    struct Pod: Decodable, Sendable {
        struct ContainerPort: Decodable, Sendable {
            var name: String?
            var containerPort: Int
        }
        struct Container: Decodable, Sendable {
            var ports: [ContainerPort]?
        }
        struct Spec: Decodable, Sendable {
            var containers: [Container]
        }
        struct Condition: Decodable, Sendable {
            var type: String
            var status: String
        }
        struct Status: Decodable, Sendable {
            var phase: String?
            var conditions: [Condition]?
        }
        var metadata = Meta()
        var spec: Spec?
        var status: Status?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            metadata = try c.decodeIfPresent(Meta.self, forKey: .metadata) ?? Meta()
            spec = try c.decodeIfPresent(Spec.self, forKey: .spec)
            status = try c.decodeIfPresent(Status.self, forKey: .status)
        }

        private enum CodingKeys: String, CodingKey { case metadata, spec, status }
    }

    struct Secret: Decodable, Sendable {
        /// Base64 values, as the API returns them.
        var data: [String: String]?

        func value(_ key: String) -> Data? {
            data?[key].flatMap { Data(base64Encoded: $0) }
        }
    }
}

extension Integration {

    /// The container port a service port targets on `pod`: a numeric
    /// `targetPort`, a named one looked up in the pod's containers, or the
    /// service port itself.
    static func targetPort(_ service: IntegrationK8s.Service, port: Int, pod: IntegrationK8s.Pod) -> Int? {
        guard let specPort = service.spec?.ports?.first(where: { $0.port == port }) else {
            return nil
        }
        switch specPort.targetPort {
        case nil: return port
        case .int(let n)?: return n
        case .string(let name)?:
            return pod.spec?.containers.lazy.flatMap { $0.ports ?? [] }
                .first { $0.name == name }?.containerPort
        }
    }

    /// First running pod whose Ready condition is true.
    static func readyPod(_ pods: [IntegrationK8s.Pod]) -> IntegrationK8s.Pod? {
        pods.first { pod in
            pod.status?.phase == "Running"
                && (pod.status?.conditions ?? []).contains { $0.type == "Ready" && $0.status == "True" }
        }
    }

    /// `k=v,k2=v2` from a service selector (sorted, so requests are stable).
    static func selector(_ service: IntegrationK8s.Service) -> String? {
        guard let selector = service.spec?.selector, !selector.isEmpty else { return nil }
        return selector.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
            .joined(separator: ",")
    }
}

// MARK: - TLS

/// Server trust for one integration connection. In-cluster: the
/// certificate must name `{service}.{namespace}.svc` (the request goes to
/// 127.0.0.1, so the name is checked here) and, with ECK's CA, chain to it
/// only. External: the system trust store. Either can opt out ("skip
/// verification"). Completion-handler delegate variants, as required for
/// URLSession on macOS.
final class IntegrationTrustDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate,
    @unchecked Sendable
{
    // Immutable after init; SecCertificate is an immutable CF type.
    let hostname: String?
    let anchor: SecCertificate?
    let insecure: Bool

    init(hostname: String?, anchor: SecCertificate?, insecure: Bool) {
        self.hostname = hostname
        self.anchor = anchor
        self.insecure = insecure
    }

    func evaluate(_ challenge: URLAuthenticationChallenge) -> (
        URLSession.AuthChallengeDisposition, URLCredential?
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
            let trust = challenge.protectionSpace.serverTrust
        else {
            return (.performDefaultHandling, nil)
        }
        if insecure {
            return (.useCredential, URLCredential(trust: trust))
        }
        guard let hostname else {
            return (.performDefaultHandling, nil)
        }
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, hostname as CFString))
        if let anchor {
            SecTrustSetAnchorCertificates(trust, [anchor] as CFArray)
            SecTrustSetAnchorCertificatesOnly(trust, true)
        }
        return SecTrustEvaluateWithError(trust, nil)
            ? (.useCredential, URLCredential(trust: trust))
            : (.cancelAuthenticationChallenge, nil)
    }

    func urlSession(
        _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let (disposition, credential) = evaluate(challenge)
        completionHandler(disposition, credential)
    }

    /// Never follows redirects: the Elasticsearch API does not redirect, and
    /// a followed redirect could carry the `Authorization` header to another
    /// host. The 3xx response itself comes back as an error status.
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let (disposition, credential) = evaluate(challenge)
        completionHandler(disposition, credential)
    }
}


// MARK: - Connections

/// An open HTTP connection of an integration: session, base URL, the
/// `Authorization` value (resolved per request, so short-lived tokens are
/// refreshed) and the tunnel that carries in-cluster requests.
final class IntegrationConnection<Endpoint: Sendable>: @unchecked Sendable {
    typealias Authorize = @Sendable () async throws -> String?

    let endpoint: Endpoint
    let session: URLSession
    let base: URL
    private let authorize: Authorize
    private let tunnel: IntegrationTunnel?

    init(
        endpoint: Endpoint, session: URLSession, base: URL, tunnel: IntegrationTunnel?,
        authorize: @escaping Authorize
    ) {
        self.endpoint = endpoint
        self.session = session
        self.base = base
        self.tunnel = tunnel
        self.authorize = authorize
    }

    /// Cancels in-flight requests and closes the tunnel.
    func close() {
        session.invalidateAndCancel()
        tunnel?.close()
    }

    /// Lets in-flight requests finish; the tunnel closes when the last
    /// holder releases the connection.
    func retire() {
        session.finishTasksAndInvalidate()
    }

    deinit {
        close()
    }

    /// GET (or POST with a JSON body) `path` relative to the base URL.
    /// Throws `IntegrationFailure` when the endpoint cannot be reached; any
    /// HTTP status is returned to the caller.
    func send(_ path: String, body: Data? = nil) async throws -> (status: Int, body: String) {
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        guard let url = URL(string: base.absoluteString + "/" + trimmed) else {
            throw IntegrationFailure.config("Invalid request path \(path)")
        }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let authorization = try await Integration.checkedHeader(authorize()) {
            request.setValue(authorization, forHTTPHeaderField: "Authorization")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code == .cancelled {
            // The caller went away: not a transport failure.
            throw CancellationError()
        } catch let error as URLError {
            throw IntegrationFailure.connect(Integration.describe(error))
        } catch {
            throw IntegrationFailure.connect(error.localizedDescription)
        }
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, String(decoding: data, as: UTF8.self))
    }
}

extension Integration {

    /// Per-request (and per-resource) timeout of the integrations.
    static let requestTimeout: TimeInterval = 15

    /// A session configuration with the integrations' timeouts and no
    /// cache or cookies.
    static func sessionConfiguration(from base: URLSessionConfiguration) -> URLSessionConfiguration {
        let config = base.copy() as? URLSessionConfiguration ?? .ephemeral
        config.timeoutIntervalForRequest = requestTimeout
        config.timeoutIntervalForResource = requestTimeout
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        return config
    }

    static func describe(_ error: URLError) -> String {
        switch error.code {
        case .timedOut: "timed out after 15 s"
        case _ where KubeAPIService.isTLSError(error):
            "TLS certificate not trusted (\(error.localizedDescription)); check the CA or enable skip verification"
        default: error.localizedDescription
        }
    }

    /// Decodes a kube API object; `IntegrationFailure` when it is missing or unreadable.
    static func get<T: Decodable>(
        _ path: String, context: String, from cluster: any IntegrationClusterAccess
    ) async throws -> T {
        guard let data = try await cluster.getIfPresent(path: path, inContext: context) else {
            throw IntegrationFailure.config("Not found: \(path)")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw IntegrationFailure.config("Cannot read \(path): \(error.localizedDescription)")
        }
    }

    /// Opens a loopback port-forward to a ready pod behind
    /// `namespace/service:port` (the API server's service proxy strips
    /// `Authorization`, kubernetes/kubernetes#38775).
    static func openServiceTunnel(
        cluster: any IntegrationClusterAccess, context: String, namespace: String,
        service: String, port: Int
    ) async throws -> (IntegrationTunnel, UInt16) {
        try checkNames(namespace: namespace, service: service)
        let svc: IntegrationK8s.Service = try await get(
            "/api/v1/namespaces/\(namespace)/services/\(service)", context: context, from: cluster)
        guard let selector = selector(svc) else {
            throw IntegrationFailure.config("Service \(namespace)/\(service) has no pod selector")
        }
        let encoded =
            selector.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? selector
        let pods: IntegrationK8s.List<IntegrationK8s.Pod> = try await get(
            "/api/v1/namespaces/\(namespace)/pods?labelSelector=\(encoded)", context: context,
            from: cluster)
        guard let pod = readyPod(pods.items), let podName = pod.metadata.name else {
            throw IntegrationFailure.connect("no ready pod behind \(namespace)/\(service)")
        }
        guard let remote = targetPort(svc, port: port, pod: pod) else {
            throw IntegrationFailure.config("Service \(namespace)/\(service) has no port \(port)")
        }
        let podSegment = try pathSegment(podName)
        return try await IntegrationTunnel.open {
            try await cluster.portForwardWebSocket(
                namespace: namespace, pod: podSegment, remotePort: remote, inContext: context)
        }
    }
}

// MARK: - Credentials

/// Credentials in the keychain, one record per kube context, bound to the
/// endpoint they were saved for and never sent anywhere else.
struct IntegrationVault<Auth: Codable & Equatable & Sendable>: Sendable {
    private struct Stored: Codable {
        let binding: String
        let auth: Auth
    }

    let store: any IntegrationSecretStore
    /// The "nothing stored" value (`.none`).
    let none: Auth

    /// The stored method's record, if any, with its binding.
    func read(context: String) async throws -> (binding: String, auth: Auth)? {
        guard let data = try await store.read(account: context) else { return nil }
        guard let record = try? JSONDecoder().decode(Stored.self, from: data) else {
            throw IntegrationFailure.config("Stored credentials are unreadable; save them again")
        }
        return (record.binding, record.auth)
    }

    /// Stored credentials usable with `binding`; `none` when nothing is stored.
    func load(context: String, binding: String) async throws -> Auth {
        guard let stored = try await read(context: context) else { return none }
        guard stored.binding == binding else {
            throw IntegrationFailure.config(
                "The saved credentials belong to another endpoint or TLS setting; save them again for this one"
            )
        }
        return stored.auth
    }

    /// The stored auth when it belongs to `binding`, else nil.
    func stored(context: String, binding: String) async throws -> Auth? {
        guard let stored = try await read(context: context), stored.binding == binding else {
            return nil
        }
        return stored.auth
    }

    /// Stores `auth` bound to `binding`; `none` deletes the record.
    func save(context: String, binding: String, auth: Auth) async throws {
        if auth == none {
            try await store.delete(account: context)
        } else {
            try await store.write(
                try JSONEncoder().encode(Stored(binding: binding, auth: auth)), account: context)
        }
    }
}

// MARK: - Connection cache

/// Open connections per kube context, reused while the endpoint is
/// unchanged and closed after `idleTimeout` without use. A connect that
/// started before `disconnect` (credentials changed) is discarded.
actor ConnectionPool<Endpoint: Equatable & Sendable> {
    typealias Connection = IntegrationConnection<Endpoint>

    /// Idle connections (and their port-forwards) close after this long.
    static var idleTimeout: Duration { .seconds(300) }

    private var connections: [String: Connection] = [:]
    private var generations: [String: Int] = [:]
    private var lastUse: [String: ContinuousClock.Instant] = [:]
    private var idleTasks: [String: Task<Void, Never>] = [:]

    /// The cached connection for `endpoint`, or a new one from `connect`.
    func connection(
        context: String, endpoint: Endpoint,
        connect: @Sendable () async throws -> Connection
    ) async throws -> Connection {
        while true {
            if let cached = connections[context], cached.endpoint == endpoint {
                touch(context)
                return cached
            }
            let generation = generations[context, default: 0]
            let fresh = try await connect()
            // Credentials were saved or removed meanwhile: start over with them.
            guard generations[context, default: 0] == generation else {
                fresh.close()
                continue
            }
            // Another call may have connected meanwhile: keep the first one.
            if let existing = connections[context], existing.endpoint == endpoint {
                fresh.close()
                touch(context)
                return existing
            }
            // A request on the previous endpoint may still be using it.
            connections.removeValue(forKey: context)?.retire()
            connections[context] = fresh
            touch(context)
            return fresh
        }
    }

    /// Drops `connection` after a transport failure (dead port-forward,
    /// network change, rejected token) unless it was already replaced.
    func invalidate(context: String, connection: Connection) {
        if connections[context] === connection {
            disconnect(context: context)
        }
    }

    /// Closes the context's connection (and its port-forward).
    func disconnect(context: String) {
        generations[context, default: 0] += 1
        connections.removeValue(forKey: context)?.close()
        lastUse[context] = nil
        idleTasks.removeValue(forKey: context)?.cancel()
    }

    /// Closes every connection (app quit, kubeconfig reload).
    func disconnectAll() {
        for context in Array(connections.keys) {
            disconnect(context: context)
        }
    }

    private func touch(_ context: String) {
        lastUse[context] = .now
        idleTasks.removeValue(forKey: context)?.cancel()
        idleTasks[context] = Task { [weak self] in
            try? await Task.sleep(for: Self.idleTimeout)
            guard !Task.isCancelled else { return }
            await self?.closeIfIdle(context)
        }
    }

    private func closeIfIdle(_ context: String) {
        guard let last = lastUse[context], ContinuousClock.now - last >= Self.idleTimeout else {
            return
        }
        disconnect(context: context)
    }
}
