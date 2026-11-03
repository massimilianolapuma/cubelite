import Foundation
import Security

extension Elastic {

    /// Classifies a service as Elasticsearch / Kibana by ECK labels, the
    /// `app.kubernetes.io/name` label or its name.
    static func classify(_ service: IntegrationK8s.Service) -> DetectedService? {
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

    private typealias Connection = IntegrationConnection<EsEndpoint>

    private let cluster: any IntegrationClusterAccess
    private let vault: IntegrationVault<EsAuth>
    private let configuration: URLSessionConfiguration
    private let pool = ConnectionPool<EsEndpoint>()
    /// Endpoints whose server has no point in time for us, per context
    /// (#531): their history pages with plain `search_after`.
    private var noPIT: [String: EsEndpoint] = [:]

    /// Port-forwards to in-cluster Kibanas (#519).
    private let kibana: ServiceForwards

    /// - Parameter configuration: base session configuration (tests inject
    ///   `URLProtocol` stubs through it).
    init(
        cluster: any IntegrationClusterAccess,
        secrets: any IntegrationSecretStore = KeychainSecrets(tag: .elasticAuth),
        configuration: URLSessionConfiguration = .ephemeral
    ) {
        self.cluster = cluster
        self.vault = IntegrationVault(store: secrets, none: .none)
        self.configuration = configuration
        self.kibana = ServiceForwards(cluster: cluster)
    }

    // MARK: Discovery

    /// Elasticsearch and Kibana services in every namespace the user can list.
    func detect(context: String) async throws -> [DetectedService] {
        let list: IntegrationK8s.List<IntegrationK8s.Service> = try await elastic {
            try await Integration.get("/api/v1/services", context: context, from: cluster)
        }
        return list.items.compactMap(Elastic.classify)
    }

    // MARK: Credentials

    /// The auth method stored for `endpoint`, never the secret; `none`
    /// when nothing is stored or it belongs to another endpoint.
    func authMethod(context: String, endpoint: EsEndpoint) async throws -> String {
        let binding = try Elastic.binding(endpoint)
        return try await elastic { try await vault.stored(context: context, binding: binding) }?
            .method ?? EsAuth.none.method
    }

    /// Saves `auth` for `context`, bound to `endpoint` (`none` deletes it),
    /// and closes the context's connection.
    func saveAuth(context: String, endpoint: EsEndpoint, auth: EsAuth) async throws {
        // Deleting must work even when the endpoint URL is broken.
        if auth != .none, case .external(let url) = endpoint.target {
            _ = try Elastic.checkExternalURL(url, auth: auth)
        }
        let binding = auth == .none ? "" : try Elastic.binding(endpoint)
        try await elastic { try await vault.save(context: context, binding: binding, auth: auth) }
        await disconnect(context: context)
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
    ///
    /// The first page opens a point in time over the index pattern and the
    /// cursor carries it to the next pages (#531), so hits with equal
    /// timestamps are neither skipped nor repeated between pages. The PIT
    /// is closed after the last page or a failed first page; the log panel
    /// closes it earlier with `closeCursor` when the search is replaced.
    /// Servers without PIT (or users without the privilege) fall back to
    /// plain `search_after`, remembered until the context disconnects.
    func search(context: String, endpoint: EsEndpoint, query: HistoryQuery) async throws
        -> HistoryPage
    {
        try Elastic.validateIndexPattern(endpoint.indexPattern)
        let connection = try await pool.connection(context: context, endpoint: endpoint) {
            let auth = try await self.loadAuth(context: context, endpoint: endpoint)
            return try await self.connect(context: context, endpoint: endpoint, auth: auth)
        }
        do {
            return try await search(connection, context: context, endpoint: endpoint, query: query)
        } catch ElasticError.connect(let reason) {
            // A dead port-forward or network change: reconnect on the next page.
            await pool.invalidate(context: context, connection: connection)
            throw ElasticError.connect(reason)
        }
    }

    /// Closes the point in time a cursor carries (#531), when its search was
    /// replaced or closed. Best effort, only through the context's open
    /// connection: the PIT expires on its own otherwise.
    func closeCursor(context: String, endpoint: EsEndpoint, cursor: HistoryCursor) async {
        guard let id = cursor.pitID,
            let connection = try? await pool.connection(
                context: context, endpoint: endpoint,
                connect: { throw ElasticError.connect("not connected") })
        else { return }
        await closePIT(connection, id: id)
    }

    /// Closes the context's connection, its port-forward and its Kibana forwards.
    func disconnect(context: String) async {
        noPIT[context] = nil
        await kibana.close(context: context)
        await pool.disconnect(context: context)
    }

    /// Closes every connection (app quit, kubeconfig reload).
    func disconnectAll() async {
        noPIT = [:]
        await kibana.closeAll()
        await pool.disconnectAll()
    }

    // MARK: Kibana

    /// Local port of a loopback forward to an in-cluster Kibana (#519),
    /// shared and reused as `ServiceForwards` describes.
    func kibanaForward(context: String, service: KibanaService) async throws -> UInt16 {
        try await elastic { try await kibana.port(context: context, service: service) }
    }

    /// The pod a context's Kibana forward goes to (tests).
    func kibanaPod(context: String, service: KibanaService) async -> String? {
        await kibana.pod(context: context, service: service)
    }

    // MARK: - Private

    /// Runs shared integration code, reporting its failures as `ElasticError`.
    private func elastic<T: Sendable>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch let failure as IntegrationFailure {
            throw ElasticError(failure)
        }
    }

    /// Stored credentials usable with `endpoint`; `.none` when nothing is stored.
    private func loadAuth(context: String, endpoint: EsEndpoint) async throws -> EsAuth {
        let binding = try Elastic.binding(endpoint)
        return try await elastic { try await vault.load(context: context, binding: binding) }
    }

    private func connect(context: String, endpoint: EsEndpoint, auth: EsAuth) async throws
        -> Connection
    {
        let config = Integration.sessionConfiguration(from: configuration)
        switch endpoint.target {
        case .external(let url):
            let base = try Elastic.checkExternalURL(url, auth: auth)
            let header = try Elastic.checkedHeader(auth)
            let delegate = IntegrationTrustDelegate(
                hostname: nil, anchor: nil, insecure: endpoint.skipTLSVerify)
            return Connection(
                endpoint: endpoint,
                session: URLSession(configuration: config, delegate: delegate, delegateQueue: nil),
                base: base, tunnel: nil, authorize: { header })
        case .inCluster(let namespace, let service, let port, let https):
            try Elastic.mapped { try Integration.checkNames(namespace: namespace, service: service) }
            var anchor: SecCertificate?
            if https, !endpoint.skipTLSVerify {
                anchor = try await eckCA(context: context, namespace: namespace, service: service)
            }
            let header = try Elastic.checkedHeader(
                auth == .eckUser
                    ? try await eckCredentials(context: context, namespace: namespace, service: service)
                    : auth)
            // Opened last: nothing to forward when the secrets cannot be read.
            let (tunnel, local, _) = try await elastic {
                try await Integration.openServiceTunnel(
                    cluster: cluster, context: context, namespace: namespace, service: service,
                    port: port)
            }
            // The tunnel is local: never route it through a proxy.
            config.connectionProxyDictionary = [:]
            let delegate = IntegrationTrustDelegate(
                hostname: Integration.serviceHost(namespace: namespace, service: service),
                anchor: anchor, insecure: endpoint.skipTLSVerify)
            guard let base = URL(string: "\(https ? "https" : "http")://127.0.0.1:\(local)") else {
                tunnel.close()
                throw ElasticError.connect("invalid local port \(local)")
            }
            return Connection(
                endpoint: endpoint,
                session: URLSession(configuration: config, delegate: delegate, delegateQueue: nil),
                base: base, tunnel: tunnel, authorize: { header })
        }
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
                path: "/api/v1/namespaces/\(namespace)/secrets/\(name)", inContext: context)
        } catch {
            throw ElasticError.connect(
                "cannot read the CA secret \(namespace)/\(name): \(error.localizedDescription)")
        }
        guard let data,
            let pem = (try? JSONDecoder().decode(IntegrationK8s.Secret.self, from: data))?.value(
                "ca.crt")
        else { return nil }
        guard let der = Integration.firstPEMCertificate(pem),
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
        try Elastic.mapped { try Integration.checkNames(namespace: namespace, service: service) }
        let eck = String(service.dropLast("-es-http".count))
        let data: Data?
        do {
            data = try await cluster.getIfPresent(
                path: "/api/v1/namespaces/\(namespace)/secrets/\(eck)-es-elastic-user",
                inContext: context)
        } catch {
            throw ElasticError.config(
                "Cannot read the ECK credentials: \(error.localizedDescription)")
        }
        guard let data else {
            throw ElasticError.config(
                "Cannot read the ECK credentials: \(namespace)/\(eck)-es-elastic-user not found")
        }
        guard let secret = try? JSONDecoder().decode(IntegrationK8s.Secret.self, from: data),
            let raw = secret.value("elastic"), let password = String(data: raw, encoding: .utf8)
        else {
            throw ElasticError.config("The ECK secret has no `elastic` key")
        }
        return .basic(username: "elastic", password: password)
    }

    // MARK: Point in time (#531)

    /// Statuses of a PIT open that mean "no PIT here" rather than a failure:
    /// no privilege, or an older Elasticsearch / OpenSearch without
    /// `/{index}/_pit`.
    private static let noPITStatuses: Set<Int> = [400, 403, 404, 405]

    /// One page on `connection`: on a point in time when the server has
    /// one, else with plain `search_after`.
    private func search(
        _ connection: Connection, context: String, endpoint: EsEndpoint, query: HistoryQuery
    ) async throws -> HistoryPage {
        let first = query.searchAfter == nil
        let opened: String?
        if let cursor = query.searchAfter {
            opened = cursor.pitID
        } else {
            opened = try await openPIT(connection, context: context, endpoint: endpoint)
        }
        guard var pit = opened else {
            let body = Data(Elastic.searchBody(query, preset: endpoint.preset).compactText.utf8)
            let response = try await send(
                connection,
                path: "\(endpoint.indexPattern)/_search?ignore_unavailable=true&allow_no_indices=true",
                body: body)
            return try Elastic.mapResponse(
                response, preset: endpoint.preset, pageSize: query.pageSize)
        }
        var openedHere = first
        do {
            let result: (page: HistoryPage, pit: String)
            do {
                result = try await searchPIT(connection, endpoint: endpoint, query: query, pit: pit)
            } catch ElasticError.http(let status, let reason) where status == 404 && !first {
                // The PIT expired (idle longer than its keep-alive): continue
                // from the same sort values on a new one.
                guard
                    let fresh = try? await openPIT(
                        connection, context: context, endpoint: endpoint)
                else { throw ElasticError.http(status: status, reason: reason) }
                pit = fresh
                openedHere = true
                result = try await searchPIT(connection, endpoint: endpoint, query: query, pit: fresh)
            }
            if result.page.next == nil { await closePIT(connection, id: result.pit) }
            return result.page
        } catch {
            if openedHere { await closePIT(connection, id: pit) }
            throw error
        }
    }

    /// Opens a point in time over the index pattern; nil when the server has
    /// no PIT for us (see `noPITStatuses`), remembered for the context.
    private func openPIT(_ connection: Connection, context: String, endpoint: EsEndpoint)
        async throws -> String?
    {
        if noPIT[context] == endpoint { return nil }
        var id: String?
        do {
            let response = try await send(
                connection,
                path:
                    "\(endpoint.indexPattern)/_pit?keep_alive=\(Elastic.pitKeepAlive)&ignore_unavailable=true",
                method: "POST")
            if case .string(let value)? = response["id"] { id = value }
        } catch ElasticError.http(let status, _) where Self.noPITStatuses.contains(status) {
            id = nil
        }
        if id == nil { noPIT[context] = endpoint }
        return id
    }

    /// One page on point in time `pit`, and the PIT id to use next (the
    /// response's `pit_id`, which Elasticsearch may update).
    private func searchPIT(
        _ connection: Connection, endpoint: EsEndpoint, query: HistoryQuery, pit: String
    ) async throws -> (page: HistoryPage, pit: String) {
        let body = Data(
            Elastic.searchBody(query, preset: endpoint.preset, pit: pit).compactText.utf8)
        // A PIT search names no index (the PIT holds them).
        let response = try await send(connection, path: "_search", body: body)
        var latest = pit
        if case .string(let id)? = response["pit_id"] { latest = id }
        let page = try Elastic.mapResponse(
            response, preset: endpoint.preset, pageSize: query.pageSize)
        let next = page.next.map { HistoryCursor(pitID: latest, sort: $0.sort) }
        return (
            HistoryPage(
                lines: page.lines, total: page.total, totalIsLowerBound: page.totalIsLowerBound,
                next: next),
            latest
        )
    }

    /// `DELETE /_pit`, best effort.
    private func closePIT(_ connection: Connection, id: String) async {
        let body = JSONValue.object([JSONMember(key: "id", value: .string(id))])
        _ = try? await send(
            connection, path: "_pit", body: Data(body.compactText.utf8), method: "DELETE")
    }

    /// GET (or POST with a JSON body) against the connection, error-mapped;
    /// `method` overrides the verb.
    private func send(
        _ connection: Connection, path: String, body: Data? = nil, method: String? = nil
    ) async throws -> JSONValue {
        let (status, text) = try await elastic {
            try await connection.send(path, body: body, method: method)
        }
        guard (200..<300).contains(status) else {
            throw ElasticError.http(
                status: status, reason: Elastic.errorReason(body: text, status: status))
        }
        guard let json = JSONValue.parse(text) else {
            throw ElasticError.response("the body is not JSON")
        }
        return json
    }
}
