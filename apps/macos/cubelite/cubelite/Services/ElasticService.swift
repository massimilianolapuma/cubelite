import Foundation
import Security

// MARK: - Cluster access

/// What `ElasticService` needs from the Kubernetes API (KubeAPIService in
/// the app, a stub in tests).
protocol ElasticClusterAccess: Sendable {
    /// Raw GET; nil when the object does not exist (404).
    func getIfPresent(path: String, inContext contextName: String?) async throws -> Data?
    func portForwardWebSocket(
        namespace: String, pod: String, remotePort: Int, inContext contextName: String?
    ) async throws -> URLSessionWebSocketTask
}

extension KubeAPIService: ElasticClusterAccess {}

/// Where the credentials record lives (the keychain in the app).
protocol ElasticSecretStore: Sendable {
    func read(account: String) async throws -> Data?
    func write(_ data: Data, account: String) async throws
    func delete(account: String) async throws
}

/// Keychain-backed store: one generic password per kube context.
struct KeychainElasticSecrets: ElasticSecretStore {
    private let keychain = KeychainService()

    func read(account: String) async throws -> Data? {
        try await keychain.retrieve(tag: .elasticAuth, account: account)
    }

    func write(_ data: Data, account: String) async throws {
        try await keychain.store(data, tag: .elasticAuth, account: account)
    }

    func delete(account: String) async throws {
        try await keychain.delete(tag: .elasticAuth, account: account)
    }
}

// MARK: - Kubernetes objects (only the fields discovery reads)

enum ElasticK8s {
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

extension Elastic {

    /// The container port a service port targets on `pod`: a numeric
    /// `targetPort`, a named one looked up in the pod's containers, or the
    /// service port itself.
    static func targetPort(_ service: ElasticK8s.Service, port: Int, pod: ElasticK8s.Pod) -> Int? {
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
    static func readyPod(_ pods: [ElasticK8s.Pod]) -> ElasticK8s.Pod? {
        pods.first { pod in
            pod.status?.phase == "Running"
                && (pod.status?.conditions ?? []).contains { $0.type == "Ready" && $0.status == "True" }
        }
    }

    /// Classifies a service as Elasticsearch / Kibana by ECK labels, the
    /// `app.kubernetes.io/name` label or its name.
    static func classify(_ service: ElasticK8s.Service) -> DetectedService? {
        guard let name = service.metadata.name else { return nil }
        let labels = service.metadata.labels ?? [:]
        let eck = labels["common.k8s.elastic.co/type"]
        let app = labels["app.kubernetes.io/name"]
        let kind: DetectedService.Kind
        if eck == "elasticsearch" || app == "elasticsearch" {
            kind = .elasticsearch
        } else if eck == "kibana" || app == "kibana" {
            kind = .kibana
        } else if name.hasSuffix("-es-http") || name.hasPrefix("elasticsearch") {
            kind = .elasticsearch
        } else if name.hasSuffix("-kb-http") || name.hasPrefix("kibana") {
            kind = .kibana
        } else {
            return nil
        }
        if ["-transport", "-headless", "-internal-http"].contains(where: name.hasSuffix) {
            return nil
        }
        // ECK also labels per-nodeSet services; only `-es-http` / `-kb-http`
        // match the certificate names and the ECK credential naming.
        if eck != nil, !(name.hasSuffix("-es-http") || name.hasSuffix("-kb-http")) {
            return nil
        }
        let wanted = kind == .elasticsearch ? 9200 : 5601
        let ports = service.spec?.ports ?? []
        guard let port = ports.first(where: { $0.port == wanted }) ?? ports.first else {
            return nil
        }
        // ECK and most charts name the port after its scheme.
        return DetectedService(
            kind: kind, namespace: service.metadata.namespace ?? "", name: name, port: port.port,
            https: port.name?.contains("https") ?? false)
    }

    /// `k=v,k2=v2` from a service selector (sorted, so requests are stable).
    static func selector(_ service: ElasticK8s.Service) -> String? {
        guard let selector = service.spec?.selector, !selector.isEmpty else { return nil }
        return selector.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
            .joined(separator: ",")
    }
}

// MARK: - TLS

/// Server trust for one Elasticsearch connection. In-cluster: the
/// certificate must name `{service}.{namespace}.svc` (the request goes to
/// 127.0.0.1, so the name is checked here) and, with ECK's CA, chain to it
/// only. External: the system trust store. Either can opt out ("skip
/// verification"). Completion-handler delegate variants, as required for
/// URLSession on macOS.
final class ElasticTrustDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate,
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

// MARK: - Service

/// Elasticsearch history for the log panel and Preferences (#502): service
/// discovery, connections (port-forward + pinned ECK CA in-cluster, HTTPS
/// externally) and credentials in the keychain bound to their endpoint.
///
/// Security rules (spec §6): credentials are sent only to the endpoint they
/// were saved for (origin + TLS setting), never in the URL, never over plain
/// http except to loopback; the tunnel bypasses proxies; ECK's `elastic`
/// password is read from the cluster at each connection, never stored.
actor ElasticService {

    /// Per-request timeout.
    static let requestTimeout: TimeInterval = 15
    /// Idle connections (and their port-forwards) close after this long.
    static let idleTimeout: Duration = .seconds(300)

    private struct StoredAuth: Codable {
        let binding: String
        let auth: EsAuth
    }

    /// An open connection: session, base URL, header and the tunnel that
    /// carries in-cluster requests.
    private final class Connection: @unchecked Sendable {
        let endpoint: EsEndpoint
        let session: URLSession
        let base: URL
        let authorization: String?
        let tunnel: ElasticTunnel?

        init(
            endpoint: EsEndpoint, session: URLSession, base: URL, authorization: String?,
            tunnel: ElasticTunnel?
        ) {
            self.endpoint = endpoint
            self.session = session
            self.base = base
            self.authorization = authorization
            self.tunnel = tunnel
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
    }

    private let cluster: ElasticClusterAccess
    private let secrets: ElasticSecretStore
    private let configuration: URLSessionConfiguration
    private var connections: [String: Connection] = [:]
    /// Bumped by `disconnect` (credential changes): a connect that started
    /// before is discarded instead of cached with the old credentials.
    private var generations: [String: Int] = [:]
    private var lastUse: [String: ContinuousClock.Instant] = [:]
    private var idleTasks: [String: Task<Void, Never>] = [:]

    /// - Parameter configuration: base session configuration (tests inject
    ///   `URLProtocol` stubs through it).
    init(
        cluster: ElasticClusterAccess, secrets: ElasticSecretStore = KeychainElasticSecrets(),
        configuration: URLSessionConfiguration = .ephemeral
    ) {
        self.cluster = cluster
        self.secrets = secrets
        self.configuration = configuration
    }

    // MARK: Discovery

    /// Elasticsearch and Kibana services in every namespace the user can list.
    func detect(context: String) async throws -> [DetectedService] {
        let list: ElasticK8s.List<ElasticK8s.Service> = try await get(
            "/api/v1/services", context: context)
        return list.items.compactMap(Elastic.classify)
    }

    // MARK: Credentials

    /// The auth method stored for `endpoint`, never the secret; `none`
    /// when nothing is stored or it belongs to another endpoint.
    func authMethod(context: String, endpoint: EsEndpoint) async throws -> String {
        let current = try Elastic.binding(endpoint)
        guard let stored = try await readRecord(context: context), stored.binding == current else {
            return EsAuth.none.method
        }
        return stored.auth.method
    }

    /// Saves `auth` for `context`, bound to `endpoint` (`none` deletes it),
    /// and closes the context's connection.
    func saveAuth(context: String, endpoint: EsEndpoint, auth: EsAuth) async throws {
        // Deleting must work even when the endpoint URL is broken.
        if auth != .none, case .external(let url) = endpoint.target {
            _ = try Elastic.checkExternalURL(url, auth: auth)
        }
        if auth == .none {
            try await secrets.delete(account: context)
        } else {
            let record = StoredAuth(binding: try Elastic.binding(endpoint), auth: auth)
            try await secrets.write(try JSONEncoder().encode(record), account: context)
        }
        disconnect(context: context)
    }

    /// Uses ECK's `elastic` user for this in-cluster endpoint: checks it can
    /// be read now, then stores only the choice.
    func useEckCredentials(context: String, endpoint: EsEndpoint) async throws {
        guard case .inCluster(let namespace, let service, _, _) = endpoint.target else {
            throw ElasticError.config("ECK credentials apply to in-cluster endpoints only")
        }
        _ = try await eckCredentials(context: context, namespace: namespace, service: service)
        try await saveAuth(context: context, endpoint: endpoint, auth: .eckUser)
    }

    // MARK: Queries

    /// Connects once and reports version, health and matching indices.
    /// `auth` tests credentials before saving them; nil uses the stored ones
    /// (only when they were saved for this endpoint).
    func test(context: String, endpoint: EsEndpoint, auth: EsAuth?) async throws -> EsInfo {
        let resolved: EsAuth
        if let auth {
            resolved = auth
        } else {
            resolved = try await loadAuth(context: context, endpoint: endpoint)
        }
        let connection = try await connect(context: context, endpoint: endpoint, auth: resolved)
        defer { connection.close() }
        let root = try await send(connection, path: "/")
        let health: String?
        if case .string(let status)? = (try? await send(connection, path: "_cluster/health"))?[
            "status"]
        {
            health = status
        } else {
            health = nil
        }
        var indices: Int?
        if (try? Elastic.validateIndexPattern(endpoint.indexPattern)) != nil,
            let resolvedIndex = try? await send(
                connection,
                path: "_resolve/index/\(endpoint.indexPattern)?expand_wildcards=open")
        {
            func count(_ key: String) -> Int {
                if case .array(let items)? = resolvedIndex[key] { items.count } else { 0 }
            }
            indices = count("indices") + count("data_streams")
        }
        let version: String
        if case .string(let number)? = root["version"]?["number"] {
            version = number
        } else {
            version = "unknown"
        }
        let name: String
        if case .string(let text)? = root["cluster_name"] { name = text } else { name = "" }
        return EsInfo(version: version, clusterName: name, health: health, indices: indices)
    }

    /// One page of a pod's history, through the context's cached connection.
    func search(context: String, endpoint: EsEndpoint, query: HistoryQuery) async throws
        -> HistoryPage
    {
        try Elastic.validateIndexPattern(endpoint.indexPattern)
        let connection = try await cachedConnection(context: context, endpoint: endpoint)
        let body = Data(Elastic.searchBody(query, preset: endpoint.preset).compactText.utf8)
        do {
            let response = try await send(
                connection,
                path: "\(endpoint.indexPattern)/_search?ignore_unavailable=true&allow_no_indices=true",
                body: body)
            return try Elastic.mapResponse(
                response, preset: endpoint.preset, pageSize: query.pageSize)
        } catch ElasticError.connect(let reason) {
            // A dead port-forward or network change: reconnect on the next page.
            if connections[context] === connection {
                disconnect(context: context)
            }
            throw ElasticError.connect(reason)
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

    // MARK: - Private

    private func get<T: Decodable>(_ path: String, context: String) async throws -> T {
        guard let data = try await cluster.getIfPresent(path: path, inContext: context) else {
            throw ElasticError.config("Not found: \(path)")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ElasticError.response("cannot decode \(path): \(error.localizedDescription)")
        }
    }

    private func readRecord(context: String) async throws -> StoredAuth? {
        guard let data = try await secrets.read(account: context) else { return nil }
        guard let record = try? JSONDecoder().decode(StoredAuth.self, from: data) else {
            throw ElasticError.config("Stored credentials are unreadable; save them again")
        }
        return record
    }

    /// Stored credentials usable with `endpoint`; `.none` when nothing is stored.
    private func loadAuth(context: String, endpoint: EsEndpoint) async throws -> EsAuth {
        guard let stored = try await readRecord(context: context) else { return .none }
        guard stored.binding == (try Elastic.binding(endpoint)) else {
            throw ElasticError.config(
                "The saved credentials belong to another endpoint or TLS setting; save them again for this one"
            )
        }
        return stored.auth
    }

    private func cachedConnection(context: String, endpoint: EsEndpoint) async throws -> Connection {
        if let cached = connections[context], cached.endpoint == endpoint {
            touch(context)
            return cached
        }
        let generation = generations[context, default: 0]
        let auth = try await loadAuth(context: context, endpoint: endpoint)
        let fresh = try await connect(context: context, endpoint: endpoint, auth: auth)
        // Credentials were saved or removed meanwhile: start over with them.
        guard generations[context, default: 0] == generation else {
            fresh.close()
            return try await cachedConnection(context: context, endpoint: endpoint)
        }
        // Another call may have connected meanwhile: keep the first one.
        if let existing = connections[context], existing.endpoint == endpoint {
            fresh.close()
            touch(context)
            return existing
        }
        // A search on the previous endpoint may still be using it.
        connections.removeValue(forKey: context)?.retire()
        connections[context] = fresh
        touch(context)
        return fresh
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

    private func connect(context: String, endpoint: EsEndpoint, auth: EsAuth) async throws
        -> Connection
    {
        let config = configuration.copy() as? URLSessionConfiguration ?? .ephemeral
        config.timeoutIntervalForRequest = Self.requestTimeout
        config.timeoutIntervalForResource = Self.requestTimeout
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        switch endpoint.target {
        case .external(let url):
            let base = try Elastic.checkExternalURL(url, auth: auth)
            let delegate = ElasticTrustDelegate(
                hostname: nil, anchor: nil, insecure: endpoint.skipTLSVerify)
            return Connection(
                endpoint: endpoint,
                session: URLSession(configuration: config, delegate: delegate, delegateQueue: nil),
                base: base, authorization: try Elastic.checkedHeader(auth), tunnel: nil)
        case .inCluster(let namespace, let service, let port, let https):
            return try await connectInCluster(
                context: context, endpoint: endpoint, auth: auth, config: config,
                namespace: namespace, service: service, port: port, https: https)
        }
    }

    // swiftlint:disable:next function_parameter_count
    private func connectInCluster(
        context: String, endpoint: EsEndpoint, auth: EsAuth, config: URLSessionConfiguration,
        namespace: String, service: String, port: Int, https: Bool
    ) async throws -> Connection {
        let ns = try Self.pathSegment(namespace)
        let svc: ElasticK8s.Service = try await get(
            "/api/v1/namespaces/\(ns)/services/\(try Self.pathSegment(service))", context: context)
        guard let selector = Elastic.selector(svc) else {
            throw ElasticError.config("Service \(namespace)/\(service) has no pod selector")
        }
        let encoded =
            selector.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? selector
        let pods: ElasticK8s.List<ElasticK8s.Pod> = try await get(
            "/api/v1/namespaces/\(ns)/pods?labelSelector=\(encoded)", context: context)
        guard let pod = Elastic.readyPod(pods.items), let podName = pod.metadata.name else {
            throw ElasticError.connect("no ready pod behind \(namespace)/\(service)")
        }
        guard let remote = Elastic.targetPort(svc, port: port, pod: pod) else {
            throw ElasticError.config("Service \(namespace)/\(service) has no port \(port)")
        }
        var anchor: SecCertificate?
        if https, !endpoint.skipTLSVerify {
            anchor = try await eckCA(context: context, namespace: namespace, service: service)
        }
        let header = try Elastic.checkedHeader(
            auth == .eckUser
                ? try await eckCredentials(context: context, namespace: namespace, service: service)
                : auth)
        let cluster = self.cluster
        let (tunnel, local) = try await ElasticTunnel.open {
            try await cluster.portForwardWebSocket(
                namespace: try Self.pathSegment(namespace), pod: try Self.pathSegment(podName),
                remotePort: remote, inContext: context)
        }
        // The tunnel is local: never route it through a proxy.
        config.connectionProxyDictionary = [:]
        let delegate = ElasticTrustDelegate(
            hostname: Elastic.serviceHost(namespace: namespace, service: service),
            anchor: anchor, insecure: endpoint.skipTLSVerify)
        guard let base = URL(string: "\(https ? "https" : "http")://127.0.0.1:\(local)") else {
            tunnel.close()
            throw ElasticError.connect("invalid local port \(local)")
        }
        return Connection(
            endpoint: endpoint,
            session: URLSession(configuration: config, delegate: delegate, delegateQueue: nil),
            base: base, authorization: header, tunnel: tunnel)
    }

    /// ECK publishes the HTTP CA in `{service}-certs-public` (`ca.crt`).
    /// nil when the secret does not exist (not ECK: system roots apply); an
    /// error when it cannot be read, so a TLS failure names its cause.
    private func eckCA(context: String, namespace: String, service: String) async throws
        -> SecCertificate?
    {
        let name = "\(service)-certs-public"
        let data: Data?
        do {
            data = try await cluster.getIfPresent(
                path: "/api/v1/namespaces/\(try Self.pathSegment(namespace))/secrets/\(try Self.pathSegment(name))",
                inContext: context)
        } catch {
            throw ElasticError.connect(
                "cannot read the CA secret \(namespace)/\(name): \(error.localizedDescription)")
        }
        guard let data,
            let pem = (try? JSONDecoder().decode(ElasticK8s.Secret.self, from: data))?.value(
                "ca.crt")
        else { return nil }
        guard let der = Elastic.firstPEMCertificate(pem),
            let certificate = SecCertificateCreateWithData(nil, der as CFData)
        else {
            throw ElasticError.connect("the CA in \(namespace)/\(name) is not a PEM certificate")
        }
        return certificate
    }

    /// ECK's built-in `elastic` user from `{cluster}-es-elastic-user`, for a
    /// `{cluster}-es-http` service.
    private func eckCredentials(context: String, namespace: String, service: String) async throws
        -> EsAuth
    {
        guard service.hasSuffix("-es-http") else {
            throw ElasticError.config("\"\(service)\" is not an ECK service (name-es-http)")
        }
        let cluster = String(service.dropLast("-es-http".count))
        let data: Data?
        do {
            data = try await self.cluster.getIfPresent(
                path:
                    "/api/v1/namespaces/\(try Self.pathSegment(namespace))/secrets/\(try Self.pathSegment("\(cluster)-es-elastic-user"))",
                inContext: context)
        } catch {
            throw ElasticError.config(
                "Cannot read the ECK credentials: \(error.localizedDescription)")
        }
        guard let data else {
            throw ElasticError.config(
                "Cannot read the ECK credentials: \(namespace)/\(cluster)-es-elastic-user not found")
        }
        guard let secret = try? JSONDecoder().decode(ElasticK8s.Secret.self, from: data),
            let raw = secret.value("elastic"), let password = String(data: raw, encoding: .utf8)
        else {
            throw ElasticError.config("The ECK secret has no `elastic` key")
        }
        return .basic(username: "elastic", password: password)
    }

    /// GET (or POST with a JSON body) against the connection, error-mapped.
    private func send(_ connection: Connection, path: String, body: Data? = nil) async throws
        -> JSONValue
    {
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        guard let url = URL(string: connection.base.absoluteString + "/" + trimmed) else {
            throw ElasticError.config("Invalid request path \(path)")
        }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let authorization = connection.authorization {
            request.setValue(authorization, forHTTPHeaderField: "Authorization")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await connection.session.data(for: request)
        } catch let error as URLError {
            throw ElasticError.connect(Self.describe(error))
        } catch {
            throw ElasticError.connect(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let text = String(decoding: data, as: UTF8.self)
        guard (200..<300).contains(status) else {
            throw ElasticError.http(
                status: status, reason: Elastic.errorReason(body: text, status: status))
        }
        guard let json = JSONValue.parse(text) else {
            throw ElasticError.response("the body is not JSON")
        }
        return json
    }

    private static func describe(_ error: URLError) -> String {
        switch error.code {
        case .timedOut: "timed out after 15 s"
        case _ where KubeAPIService.isTLSError(error):
            "TLS certificate not trusted (\(error.localizedDescription)); check the CA or enable skip verification"
        default: error.localizedDescription
        }
    }

    /// One percent-encoded path segment; `.`/`..` and empty names are refused
    /// (they would be normalised into another API path).
    static func pathSegment(_ text: String) throws -> String {
        guard !text.isEmpty, text != ".", text != ".." else {
            throw ElasticError.config("Invalid name \"\(text)\"")
        }
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        return text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text
    }
}
