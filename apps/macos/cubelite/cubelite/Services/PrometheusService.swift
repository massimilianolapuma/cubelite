import Foundation

/// Entra ID tokens for Azure Monitor managed Prometheus from the Azure CLI
/// the user is logged in with (spec §6): kept in memory until five minutes
/// before they expire, never stored; one `az` run at a time.
actor AzureCLIToken {

    typealias Runner = @Sendable () async throws -> (status: Int32, stdout: Data, stderr: Data)

    /// Tokens are refreshed this long before they expire.
    static let margin: TimeInterval = 300
    static let timeout: TimeInterval = 30

    private var cached: (token: String, expires: Date)?
    private var pending: Task<String, Error>?
    private let run: Runner

    /// - Parameter run: runs `az account get-access-token` (tests stub it).
    init(run: Runner? = nil) {
        self.run = run ?? Self.runAzureCLI
    }

    func token(now: Date = Date()) async throws -> String {
        if let cached, now.addingTimeInterval(Self.margin) < cached.expires {
            return cached.token
        }
        if let pending { return try await pending.value }
        let run = self.run
        let task = Task { () throws -> String in
            let output = try await run()
            guard output.status == 0 else {
                throw Prometheus.azureCLIError(String(decoding: output.stderr, as: UTF8.self))
            }
            let parsed = try Prometheus.parseAzureToken(output.stdout, now: now)
            self.store(parsed)
            return parsed.token
        }
        pending = task
        defer { pending = nil }
        return try await task.value
    }

    /// Forgets the token (Azure Monitor rejected it: expired, revoked, or
    /// `az` now points at another tenant).
    func forget() {
        cached = nil
    }

    private func store(_ token: (token: String, expires: Date)) {
        cached = token
    }

    private static let runAzureCLI: Runner = {
        guard let az = ExecCredentialService.resolveExecutable("az") else {
            throw PromError.config("Azure CLI (az) not found — install it or choose another method")
        }
        return try await ExecCredentialService.runProcess(
            az,
            arguments: [
                "account", "get-access-token", "--resource", Prometheus.azureResource, "--output",
                "json",
            ],
            environment: ExecCredentialService.searchEnvironment(), timeout: timeout
        ) { error in
            PromError.config("Cannot run the Azure CLI: \(error.localizedDescription)")
        }
    }
}

/// Prometheus history for the Metrics section, list sparklines and
/// Settings (#511): in-cluster through the API server's service proxy with
/// the user's kube credentials (a port-forward when the proxy is forbidden
/// or unavailable), external endpoints over HTTPS with credentials from the
/// keychain bound to their endpoint, or an Azure CLI token.
actor PrometheusService {

    private typealias Connection = IntegrationConnection<PromEndpoint>

    /// How an in-cluster endpoint is reached, decided by a probe.
    private enum Route {
        case proxy
        case tunnel
    }

    private let cluster: any IntegrationClusterAccess
    private let vault: IntegrationVault<PromAuth>
    private let configuration: URLSessionConfiguration
    private let azure: AzureCLIToken
    private let pool = ConnectionPool<PromEndpoint>()
    private var routes: [String: (endpoint: PromEndpoint, route: Route)] = [:]

    init(
        cluster: any IntegrationClusterAccess,
        secrets: any IntegrationSecretStore = KeychainSecrets(tag: .prometheusAuth),
        configuration: URLSessionConfiguration = .ephemeral,
        azure: AzureCLIToken = AzureCLIToken()
    ) {
        self.cluster = cluster
        self.vault = IntegrationVault(store: secrets, none: .none)
        self.configuration = configuration
        self.azure = azure
    }

    // MARK: Discovery and credentials

    /// Prometheus servers in every namespace the user can list,
    /// `prometheus-operated` (kube-prometheus-stack) first.
    func detect(context: String) async throws -> [DetectedPrometheus] {
        let list: IntegrationK8s.List<IntegrationK8s.Service> = try await prom {
            try await Integration.get("/api/v1/services", context: context, from: cluster)
        }
        return list.items.compactMap(Prometheus.classify).sorted {
            ($0.name == "prometheus-operated" ? 0 : 1, $0.namespace, $0.name)
                < ($1.name == "prometheus-operated" ? 0 : 1, $1.namespace, $1.name)
        }
    }

    /// The auth method stored for `endpoint`, never the secret.
    func authMethod(context: String, endpoint: PromEndpoint) async throws -> String {
        let binding = try binding(endpoint)
        return try await prom { try await vault.stored(context: context, binding: binding) }?
            .method ?? PromAuth.none.method
    }

    /// Saves `auth` for `context`, bound to `endpoint` (`none` deletes it).
    func saveAuth(context: String, endpoint: PromEndpoint, auth: PromAuth) async throws {
        if auth != .none {
            _ = try checkAuth(auth, for: endpoint)
        }
        let binding = auth == .none ? "" : try binding(endpoint)
        try await prom { try await vault.save(context: context, binding: binding, auth: auth) }
        await disconnect(context: context)
    }

    /// Closes the context's connection (and its port-forward).
    func disconnect(context: String) async {
        routes[context] = nil
        await pool.disconnect(context: context)
    }

    // MARK: Queries

    /// Version, exporters present and `cluster` label values. `auth` tests
    /// credentials before saving them; nil uses the stored ones.
    func test(context: String, endpoint: PromEndpoint, auth: PromAuth?) async throws -> PromInfo {
        if let auth { _ = try checkAuth(auth, for: endpoint) }
        let resolved: PromAuth
        if let auth {
            resolved = auth
        } else {
            resolved = try await loadAuth(context: context, endpoint: endpoint)
        }
        let session = try await open(context: context, endpoint: endpoint, auth: resolved, cached: false)
        defer { session.connection?.close() }
        _ = try await query(session, "vector(1)")
        let version: String
        if let build = try? await get(session, "/api/v1/status/buildinfo"),
            case .string(let v)? = build["data"]?["version"]
        {
            version = v
        } else {
            version = "unknown"
        }
        let filter = endpoint.cluster?.trimmingCharacters(in: .whitespaces).isEmpty == false
            ? "{cluster=\(Prometheus.escape(endpoint.cluster ?? ""))}" : ""
        func present(_ q: String) async -> Bool {
            guard let data = try? await query(session, q),
                let series = try? Prometheus.parseSeries(data, labels: [])
            else { return false }
            return !series.isEmpty
        }
        let cadvisor = await present("count(container_cpu_usage_seconds_total\(filter))")
        let ksm = await present("count(kube_pod_container_resource_requests\(filter))")
        let clusters =
            (try? await query(session, "count by (cluster) (up)"))
            .flatMap { try? Prometheus.parseSeries($0, labels: ["cluster"]) }?
            .map(\.label).filter { !$0.isEmpty } ?? []
        return PromInfo(version: version, cadvisor: cadvisor, kubeStateMetrics: ksm, clusters: clusters)
    }

    /// Every chart of the Metrics section, queried concurrently; a failing
    /// chart carries its error while the others render.
    func metrics(context: String, endpoint: PromEndpoint, request: MetricsRequest) async throws
        -> MetricsResult
    {
        let session = try await open(context: context, endpoint: endpoint)
        let step = request.range.step
        let end = Int(Date().timeIntervalSince1970) / step * step
        let start = end - request.range.seconds
        let queries = Prometheus.metricsQueries(request, cluster: endpoint.cluster)
        let results = await withTaskGroup(of: (Int, Result<[MetricSeries], Error>).self) { group in
            for (index, (chart, q)) in queries.enumerated() {
                let labels =
                    [.networkRx, .networkTx, .restartsTotal].contains(chart) || !request.perContainer
                    ? [] : ["container"]
                // The total is one evaluation at the end of the range.
                let from = chart == .restartsTotal ? end : start
                group.addTask {
                    do {
                        let data = try await self.queryRange(session, q, start: from, end: end, step: step)
                        return (index, .success(try Prometheus.parseSeries(data, labels: labels)))
                    } catch {
                        return (index, .failure(error))
                    }
                }
            }
            var out = [Result<[MetricSeries], Error>?](repeating: nil, count: queries.count)
            for await (index, result) in group { out[index] = result }
            return out.compactMap { $0 }
        }
        let errors = results.compactMap { if case .failure(let e) = $0 { e as? PromError } else { nil } }
        // Unreachable or rejected credentials are everyone's problem: report them once.
        if errors.count == results.count, let first = errors.first, Self.isFatal(first) {
            await dropConnection(context: context, session: session, after: first)
            throw first
        }
        let charts = zip(queries, results).map { pair, result -> ChartData in
            switch result {
            case .success(let series):
                ChartData(chart: pair.0, query: pair.1, series: series, error: nil)
            case .failure(let error):
                ChartData(chart: pair.0, query: pair.1, series: [], error: error.localizedDescription)
            }
        }
        return MetricsResult(start: start, end: end, step: step, charts: charts)
    }

    /// Last hour of CPU and memory per pod of `namespace` (every namespace
    /// with nil), keyed `namespace/pod`.
    func sparklines(context: String, endpoint: PromEndpoint, namespace: String?) async throws
        -> Sparklines
    {
        let session = try await open(context: context, endpoint: endpoint)
        let step = Prometheus.sparklineStep
        let end = Int(Date().timeIntervalSince1970) / step * step
        let start = end - Prometheus.sparklineRange
        let (cpuQuery, memoryQuery) = Prometheus.sparklineQueries(
            namespace: namespace, cluster: endpoint.cluster)
        do {
            async let cpu = queryRange(session, cpuQuery, start: start, end: end, step: step)
            async let memory = queryRange(session, memoryQuery, start: start, end: end, step: step)
            func byPod(_ data: JSONValue) throws -> [String: [MetricPoint]] {
                Dictionary(
                    try Prometheus.parseSeries(data, labels: ["namespace", "pod"])
                        .filter { !$0.label.hasPrefix("/") && !$0.label.hasSuffix("/") }
                        .map { ($0.label, $0.points) },
                    uniquingKeysWith: { first, _ in first })
            }
            return Sparklines(cpu: try byPod(try await cpu), memory: try byPod(try await memory))
        } catch let error as PromError {
            await dropConnection(context: context, session: session, after: error)
            throw error
        }
    }

    // MARK: - Transport

    /// The proxy route (no connection) or an HTTP connection.
    private struct Session: Sendable {
        let endpoint: PromEndpoint
        let context: String
        let connection: IntegrationConnection<PromEndpoint>?
    }

    private static func isFatal(_ error: PromError) -> Bool {
        switch error {
        case .connect: true
        case .http(let status, _): status == 401 || status == 403
        default: false
        }
    }

    private func dropConnection(context: String, session: Session, after error: PromError) async {
        guard Self.isFatal(error) else { return }
        if case .http(401, _) = error, case .external = session.endpoint.target {
            await azure.forget()
        }
        if let connection = session.connection {
            await pool.invalidate(context: context, connection: connection)
        } else {
            routes[context] = nil
        }
    }

    private func prom<T>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch let failure as IntegrationFailure {
            throw PromError(failure)
        }
    }

    private func binding(_ endpoint: PromEndpoint) throws -> String {
        do {
            return try Integration.binding(endpoint.target, skipTLSVerify: endpoint.skipTLSVerify)
        } catch let failure as IntegrationFailure {
            throw PromError(failure)
        }
    }

    private func loadAuth(context: String, endpoint: PromEndpoint) async throws -> PromAuth {
        let binding = try binding(endpoint)
        return try await prom { try await vault.load(context: context, binding: binding) }
    }

    /// Checks `auth` against the endpoint's rules; returns the external base URL.
    @discardableResult
    private func checkAuth(_ auth: PromAuth, for endpoint: PromEndpoint) throws -> URL? {
        switch endpoint.target {
        case .inCluster:
            guard auth == .none else {
                throw PromError.config(
                    "In-cluster Prometheus is reached with your cluster credentials; choose No authentication")
            }
            return nil
        case .external(let url):
            let base: URL
            do {
                base = try Integration.checkExternalURL(url, sendsCredentials: auth != .none)
            } catch let failure as IntegrationFailure {
                throw PromError(failure)
            }
            if auth == .azureCLI, !Prometheus.isAzureMonitorURL(base) {
                throw PromError.config(
                    "Azure CLI sign-in works only with https://…prometheus.monitor.azure.com endpoints")
            }
            return base
        }
    }

    /// A session for `endpoint`: the proxy route, or a (cached) connection.
    private func open(
        context: String, endpoint: PromEndpoint, auth: PromAuth? = nil, cached: Bool = true
    ) async throws -> Session {
        switch endpoint.target {
        case .external:
            let connect: @Sendable () async throws -> Connection = {
                let resolved: PromAuth
                if let auth {
                    resolved = auth
                } else {
                    resolved = try await self.loadAuth(context: context, endpoint: endpoint)
                }
                return try await self.connectExternal(endpoint: endpoint, auth: resolved)
            }
            let connection =
                cached ? try await pool.connection(context: context, endpoint: endpoint, connect: connect)
                : try await connect()
            return Session(endpoint: endpoint, context: context, connection: connection)
        case .inCluster(let namespace, let service, let port, let https):
            do {
                try Integration.checkNames(namespace: namespace, service: service)
            } catch let failure as IntegrationFailure {
                throw PromError(failure)
            }
            if let auth { _ = try checkAuth(auth, for: endpoint) }
            var route = routes[context].flatMap { $0.endpoint == endpoint ? $0.route : nil }
            if route == nil {
                route = try await probeProxy(context: context, endpoint: endpoint)
                routes[context] = (endpoint, route ?? .tunnel)
            }
            guard route == .tunnel else {
                return Session(endpoint: endpoint, context: context, connection: nil)
            }
            let connect: @Sendable () async throws -> Connection = {
                try await self.connectTunnel(
                    context: context, endpoint: endpoint, namespace: namespace, service: service,
                    port: port, https: https)
            }
            let connection =
                cached ? try await pool.connection(context: context, endpoint: endpoint, connect: connect)
                : try await connect()
            return Session(endpoint: endpoint, context: context, connection: connection)
        }
    }

    /// Whether the API server's service proxy reaches Prometheus: its own
    /// `Status` errors say no (403 without `services/proxy` RBAC, 5xx when it
    /// cannot reach the pod: use a port-forward; 404: no such service).
    private func probeProxy(context: String, endpoint: PromEndpoint) async throws -> Route {
        let answer = try await fetchProxy(context: context, endpoint: endpoint, path: "/api/v1/status/buildinfo")
        guard answer.fromAPIServer else { return .proxy }
        switch answer.status {
        case 404:
            throw PromError.config(
                "Service not found: \(Prometheus.errorReason(body: answer.body, status: 404))")
        case 403, 500, 502, 503:
            return .tunnel
        default:
            throw PromError.http(
                status: answer.status,
                reason: Prometheus.errorReason(body: answer.body, status: answer.status))
        }
    }

    private func fetchProxy(context: String, endpoint: PromEndpoint, path: String) async throws -> (
        status: Int, body: String, fromAPIServer: Bool
    ) {
        guard case .inCluster(let namespace, let service, let port, let https) = endpoint.target else {
            throw PromError.config("Not an in-cluster endpoint")
        }
        let base = Prometheus.proxyBase(namespace: namespace, service: service, port: port, https: https)
        let raw: (status: Int, body: Data)
        do {
            raw = try await cluster.rawGet(path: base + path, inContext: context)
        } catch {
            throw PromError.connect(error.localizedDescription)
        }
        let body = String(decoding: raw.body, as: UTF8.self)
        // The API server's own errors are `Status` objects; Prometheus
        // answers `{"status":"error",…}` or its data.
        let fromAPIServer =
            !(200..<300).contains(raw.status) && JSONValue.parse(body)?["kind"] == .string("Status")
        return (raw.status, body, fromAPIServer)
    }

    private func connectExternal(endpoint: PromEndpoint, auth: PromAuth) async throws -> Connection {
        guard let base = try checkAuth(auth, for: endpoint) else {
            throw PromError.config("Not an external endpoint")
        }
        let authorize: Connection.Authorize
        if auth == .azureCLI {
            let azure = self.azure
            // Fail early (az missing, logged out) rather than per chart.
            _ = try await azure.token()
            authorize = { "Bearer \(try await azure.token())" }
        } else {
            let header = auth.header
            authorize = { header }
        }
        let delegate = IntegrationTrustDelegate(hostname: nil, anchor: nil, insecure: endpoint.skipTLSVerify)
        return Connection(
            endpoint: endpoint,
            session: URLSession(
                configuration: Integration.sessionConfiguration(from: configuration),
                delegate: delegate, delegateQueue: nil),
            base: base, tunnel: nil, authorize: authorize)
    }

    // swiftlint:disable:next function_parameter_count
    private func connectTunnel(
        context: String, endpoint: PromEndpoint, namespace: String, service: String, port: Int,
        https: Bool
    ) async throws -> Connection {
        let (tunnel, local) = try await prom {
            try await Integration.openServiceTunnel(
                cluster: cluster, context: context, namespace: namespace, service: service, port: port)
        }
        let config = Integration.sessionConfiguration(from: configuration)
        // The tunnel is local: never route it through a proxy.
        config.connectionProxyDictionary = [:]
        let delegate = IntegrationTrustDelegate(
            hostname: Integration.serviceHost(namespace: namespace, service: service), anchor: nil,
            insecure: endpoint.skipTLSVerify)
        guard let base = URL(string: "\(https ? "https" : "http")://127.0.0.1:\(local)") else {
            tunnel.close()
            throw PromError.connect("invalid local port \(local)")
        }
        return Connection(
            endpoint: endpoint,
            session: URLSession(configuration: config, delegate: delegate, delegateQueue: nil),
            base: base, tunnel: tunnel, authorize: { nil })
    }

    /// GET `path` through the session, parsed as JSON.
    private func get(_ session: Session, _ path: String) async throws -> JSONValue {
        let status: Int
        let body: String
        if let connection = session.connection {
            (status, body) = try await prom { try await connection.send(path) }
            if status == 401, case .external = session.endpoint.target {
                // An expired or revoked Azure token: fetch a new one next time.
                await azure.forget()
            }
        } else {
            let answer = try await fetchProxy(context: session.context, endpoint: session.endpoint, path: path)
            (status, body) = (answer.status, answer.body)
        }
        guard (200..<300).contains(status) else {
            throw PromError.http(status: status, reason: Prometheus.errorReason(body: body, status: status))
        }
        guard let json = JSONValue.parse(body) else { throw PromError.response("the body is not JSON") }
        return json
    }

    private func query(_ session: Session, _ promql: String) async throws -> JSONValue {
        try Prometheus.unwrapData(try await get(session, "/api/v1/query?" + Self.form(["query": promql])))
    }

    private func queryRange(_ session: Session, _ promql: String, start: Int, end: Int, step: Int)
        async throws -> JSONValue
    {
        let params = Self.form([
            "query": promql, "start": String(start), "end": String(end), "step": String(step),
        ])
        return try Prometheus.unwrapData(try await get(session, "/api/v1/query_range?" + params))
    }

    /// `application/x-www-form-urlencoded` query string (stable key order).
    static func form(_ pairs: [String: String]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return pairs.sorted { $0.key < $1.key }.map { key, value in
            "\(key)=\(value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value)"
        }.joined(separator: "&")
    }
}
