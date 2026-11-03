import Foundation

// Prometheus history for pods and deployments and Grafana deep links
// (#484, #511). The pure half, mirroring
// `crates/cubelite-core/src/prometheus/mod.rs` with the same test vectors:
// endpoint model, PromQL builder, step and window maths, response parsing,
// Grafana Explore URL, Azure CLI token parsing. `PrometheusService` reaches
// Prometheus.

/// A context's Prometheus endpoint (no secrets: those live in the keychain).
/// Same JSON shape as the desktop's `PromEndpoint`.
struct PromEndpoint: Hashable, Sendable, Codable {
    var target: IntegrationTarget
    /// Value of the `cluster` label added to every query (a shared Azure
    /// Monitor workspace or Thanos holds many clusters).
    var cluster: String?
    var grafanaURL: String?
    /// Grafana datasource UID or name; nil uses Grafana's default.
    var grafanaDatasource: String?
    /// In-cluster Grafana opened through a port-forward when there is no URL (#525).
    var grafanaService: GrafanaService?
    var skipTLSVerify = false

    private enum CodingKeys: String, CodingKey {
        case target, cluster, grafanaDatasource, grafanaService
        case grafanaURL = "grafanaUrl"
        case skipTLSVerify = "skipTlsVerify"
    }

    init(
        target: IntegrationTarget, cluster: String? = nil, grafanaURL: String? = nil,
        grafanaDatasource: String? = nil, grafanaService: GrafanaService? = nil,
        skipTLSVerify: Bool = false
    ) {
        self.target = target
        self.cluster = cluster
        self.grafanaURL = grafanaURL
        self.grafanaDatasource = grafanaDatasource
        self.grafanaService = grafanaService
        self.skipTLSVerify = skipTLSVerify
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        target = try c.decode(IntegrationTarget.self, forKey: .target)
        cluster = try c.decodeIfPresent(String.self, forKey: .cluster)
        grafanaURL = try c.decodeIfPresent(String.self, forKey: .grafanaURL)
        grafanaDatasource = try c.decodeIfPresent(String.self, forKey: .grafanaDatasource)
        grafanaService = try c.decodeIfPresent(GrafanaService.self, forKey: .grafanaService)
        skipTLSVerify = try c.decodeIfPresent(Bool.self, forKey: .skipTLSVerify) ?? false
    }
}

/// A Grafana service in the cluster (from Detect; kube-prometheus-stack's
/// is `monitoring/<release>-grafana:80`, plain HTTP); same JSON as the desktop.
typealias GrafanaService = ServiceRef

/// Credentials for an endpoint. Never printed: `description`,
/// `debugDescription` and the mirror name only the method.
enum PromAuth: Equatable, Sendable {
    case none
    /// Basic auth (Grafana Cloud: instance id + token).
    case basic(username: String, password: String)
    case bearer(String)
    /// Azure Monitor managed Prometheus: an Entra ID token from the Azure
    /// CLI, fetched when connecting and never stored.
    case azureCLI

    /// Tag shared with the desktop (`none`, `basic`, `bearer`, `azure-cli`).
    var method: String {
        switch self {
        case .none: "none"
        case .basic: "basic"
        case .bearer: "bearer"
        case .azureCLI: "azure-cli"
        }
    }

    /// `Authorization` value of the stored methods (`azureCLI` is resolved
    /// to a bearer token per request).
    var header: String? {
        switch self {
        case .none, .azureCLI: nil
        case .basic(let username, let password):
            "Basic " + Data("\(username):\(password)".utf8).base64EncodedString()
        case .bearer(let token): "Bearer " + token.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}

extension PromAuth: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    var description: String { "PromAuth(\(method))" }
    var debugDescription: String { description }
    var customMirror: Mirror { Mirror(self, children: ["method": method]) }
}

extension PromAuth: Codable {
    private enum CodingKeys: String, CodingKey {
        case method, username, password, token
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .method) {
        case "none": self = .none
        case "basic":
            self = .basic(
                username: try c.decode(String.self, forKey: .username),
                password: try c.decode(String.self, forKey: .password))
        case "bearer": self = .bearer(try c.decode(String.self, forKey: .token))
        case "azure-cli": self = .azureCLI
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .method, in: c, debugDescription: "Unknown auth method \(other)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(method, forKey: .method)
        switch self {
        case .none, .azureCLI: break
        case .basic(let username, let password):
            try c.encode(username, forKey: .username)
            try c.encode(password, forKey: .password)
        case .bearer(let token): try c.encode(token, forKey: .token)
        }
    }
}

/// Errors of the Prometheus integration, with user-facing text.
enum PromError: Error, Equatable, LocalizedError {
    case config(String)
    case connect(String)
    case http(status: Int, reason: String)
    case response(String)

    init(_ failure: IntegrationFailure) {
        switch failure {
        case .config(let text): self = .config(text)
        case .connect(let text): self = .connect(text)
        }
    }

    var errorDescription: String? {
        switch self {
        case .config(let text): text
        case .connect(let text): "Cannot reach Prometheus: \(text)"
        case .http(let status, let reason): "Prometheus returned \(status): \(reason)"
        case .response(let text): "Unexpected Prometheus response: \(text)"
        }
    }
}

/// What the charts are about.
enum Workload: Hashable, Sendable {
    case pod(String)
    /// A deployment's pods (`name-<replicaset hash>-<suffix>`).
    case deployment(String)
    /// A StatefulSet's pods (`name-<ordinal>`).
    case statefulSet(String)
}

/// Chart ranges (spec §4).
enum MetricsRange: String, CaseIterable, Sendable {
    case hour = "1h"
    case sixHours = "6h"
    case day = "24h"
    case week = "7d"

    var seconds: Int {
        switch self {
        case .hour: 3_600
        case .sixHours: 6 * 3_600
        case .day: 24 * 3_600
        case .week: 7 * 24 * 3_600
        }
    }

    /// About 240 points per chart, never under 15 s.
    var step: Int { max(seconds / 240, 15) }

    /// Rate window: four steps (a missed scrape leaves no gap), at least 1 m.
    var window: Int { max(4 * step, 60) }

    /// Grafana / Prometheus relative start (`now-1h`).
    var grafanaFrom: String { "now-\(rawValue)" }
}

/// One chart of the Metrics section.
enum Chart: String, CaseIterable, Sendable {
    case cpu
    case cpuRequest = "cpu-request"
    case cpuLimit = "cpu-limit"
    case memory
    case memoryRequest = "memory-request"
    case memoryLimit = "memory-limit"
    /// Cumulative restart counter (the line; a new pod starts again from 0).
    case restarts
    /// Restarts over the whole range, computed per pod and container by
    /// Prometheus, one point.
    case restartsTotal = "restarts-total"
    case networkRx = "network-rx"
    case networkTx = "network-tx"
}

/// What the Metrics section asks for.
struct MetricsRequest: Hashable, Sendable {
    var namespace: String
    var workload: Workload
    var range: MetricsRange
    /// One line per container instead of the sum.
    var perContainer: Bool
}

/// `[unix seconds, value]`; nil for NaN/Inf, so lines break.
struct MetricPoint: Equatable, Sendable {
    let time: Double
    let value: Double?
}

/// One line of a chart: container, `namespace/pod`, or empty for a sum.
struct MetricSeries: Equatable, Sendable {
    let label: String
    let points: [MetricPoint]
}

struct ChartData: Equatable, Sendable {
    let chart: Chart
    /// Its PromQL (for Open in Grafana).
    let query: String
    /// Lines; empty when the series does not exist.
    let series: [MetricSeries]
    /// Why this chart failed, when the others did not.
    let error: String?
}

struct MetricsResult: Equatable, Sendable {
    let start: Int
    let end: Int
    let step: Int
    let charts: [ChartData]

    func data(_ chart: Chart) -> ChartData? { charts.first { $0.chart == chart } }
}

/// Last hour of CPU (cores) and memory (bytes) per `namespace/pod`.
struct Sparklines: Equatable, Sendable {
    var cpu: [String: [MetricPoint]] = [:]
    var memory: [String: [MetricPoint]] = [:]
}

/// Server facts for Settings → Test connection.
struct PromInfo: Equatable, Sendable {
    let version: String
    let cadvisor: Bool
    let kubeStateMetrics: Bool
    let clusters: [String]
}

/// A Prometheus or Grafana (#525) service found in the cluster.
struct DetectedPrometheus: Hashable, Sendable, Identifiable {
    enum Kind: String, Sendable { case prometheus, grafana }

    var kind = Kind.prometheus
    let namespace: String
    let name: String
    let port: Int
    let https: Bool

    var id: String { "\(kind.rawValue):\(namespace)/\(name):\(port)" }

    /// The service as stored on an endpoint (`grafanaService`).
    var serviceRef: ServiceRef { ServiceRef(namespace: namespace, service: name, port: port, https: https) }
}

// MARK: - Pure functions

enum Prometheus {

    /// Sparkline range and step: the last hour at 2 m.
    static let sparklineRange = 3_600
    static let sparklineStep = 120

    /// Alphabet of ReplicaSet hashes and generated name suffixes (Kubernetes'
    /// `rand.SafeEncodeString`), which also keeps CronJob pods out.
    private static let safe = "[bcdfghjklmnpqrstvwxz2456789]"
    /// Generated names are cut to 58 characters before the 5-character suffix.
    static let generatedPrefixMax = 58

    /// PromQL string literal: `"…"` with `\`, `"` and newlines escaped.
    static func escape(_ value: String) -> String {
        var out = "\""
        for c in value {
            switch c {
            case "\\": out += "\\\\"
            case "\"": out += "\\\""
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            default: out.append(c)
            }
        }
        return out + "\""
    }

    /// Escapes regex metacharacters (RE2) so a name matches literally.
    static func regexLiteral(_ name: String) -> String {
        var out = ""
        for c in name {
            if "\\.+*?()|[]{}^$".contains(c) { out.append("\\") }
            out.append(c)
        }
        return out
    }

    /// Regex for a deployment's pods: `name-<hash>-<suffix>`, or for long
    /// names the truncated `generateName` prefix followed by the suffix.
    /// `literal` escapes the name for the regex dialect (RE2 for PromQL,
    /// Lucene for Kibana links, #526).
    static func deploymentPods(_ name: String, literal: (String) -> String = regexLiteral) -> String {
        if name.count + 12 <= generatedPrefixMax {
            return "\(literal(name))-\(safe){6,10}-\(safe){5}"
        }
        let kept = String(name.prefix(generatedPrefixMax))
        return "\(literal(kept))(-\(safe){0,10}-?)?\(safe){5}"
    }

    /// Regex for a StatefulSet's pods: `name-<ordinal>`.
    static func statefulSetPods(_ name: String, literal: (String) -> String = regexLiteral) -> String {
        "\(literal(name))-[0-9]+"
    }

    /// Label matchers for a workload: namespace, pod and the optional `cluster`.
    static func selector(namespace: String, workload: Workload, cluster: String?) -> String {
        let pod: String
        switch workload {
        case .pod(let name): pod = "pod=\(escape(name))"
        case .deployment(let name): pod = "pod=~\(escape(deploymentPods(name)))"
        case .statefulSet(let name): pod = "pod=~\(escape(statefulSetPods(name)))"
        }
        var out = "namespace=\(escape(namespace)), \(pod)"
        if let c = cluster?.trimmingCharacters(in: .whitespaces), !c.isEmpty {
            out += ", cluster=\(escape(c))"
        }
        return out
    }

    /// The CPU chart's PromQL for a workload over the last hour, per
    /// container (Metrics in Grafana, #526).
    static func workloadCPUQuery(namespace: String, workload: Workload, cluster: String?) -> String {
        chartQuery(
            .cpu, selector: selector(namespace: namespace, workload: workload, cluster: cluster),
            perContainer: true, window: MetricsRange.hour.window)
    }

    /// The PromQL of one chart. Per container charts group `by (container)`;
    /// network and the restarts total are pod level and always summed.
    /// `window` is the whole range for `restartsTotal`.
    static func chartQuery(_ chart: Chart, selector sel: String, perContainer: Bool, window: Int)
        -> String
    {
        let containers = #"container!="", container!="POD""#
        let inner: String
        switch chart {
        case .cpu:
            inner = "rate(container_cpu_usage_seconds_total{\(sel), \(containers)}[\(window)s])"
        case .cpuRequest, .cpuLimit, .memoryRequest, .memoryLimit:
            let metric = chart == .cpuRequest || chart == .memoryRequest ? "requests" : "limits"
            let resource = chart == .cpuRequest || chart == .cpuLimit ? "cpu" : "memory"
            inner = #"kube_pod_container_resource_\#(metric){\#(sel), resource="\#(resource)"}"#
        case .memory:
            inner = "container_memory_working_set_bytes{\(sel), \(containers)}"
        case .restarts:
            inner = "kube_pod_container_status_restarts_total{\(sel)}"
        case .restartsTotal:
            return "sum(increase(kube_pod_container_status_restarts_total{\(sel)}[\(window)s]))"
        case .networkRx:
            return "sum(rate(container_network_receive_bytes_total{\(sel)}[\(window)s]))"
        case .networkTx:
            return "sum(rate(container_network_transmit_bytes_total{\(sel)}[\(window)s]))"
        }
        return perContainer ? "sum by (container) (\(inner))" : "sum(\(inner))"
    }

    /// Every chart's PromQL for `request`.
    static func metricsQueries(_ request: MetricsRequest, cluster: String?) -> [(Chart, String)] {
        let sel = selector(namespace: request.namespace, workload: request.workload, cluster: cluster)
        return Chart.allCases.map { chart in
            let window = chart == .restartsTotal ? request.range.seconds : request.range.window
            return (
                chart,
                chartQuery(chart, selector: sel, perContainer: request.perContainer, window: window)
            )
        }
    }

    /// The two sparkline queries (CPU, memory) of a namespace, or of every
    /// namespace with nil, `by (namespace, pod)`.
    static func sparklineQueries(namespace: String?, cluster: String?) -> (cpu: String, memory: String) {
        var matchers = [#"container!="", container!="POD""#]
        if let namespace { matchers.insert("namespace=\(escape(namespace))", at: 0) }
        if let c = cluster?.trimmingCharacters(in: .whitespaces), !c.isEmpty {
            matchers.append("cluster=\(escape(c))")
        }
        let sel = matchers.joined(separator: ", ")
        return (
            "sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{\(sel)}[5m]))",
            "sum by (namespace, pod) (container_memory_working_set_bytes{\(sel)})"
        )
    }

    private static func sample(_ value: JSONValue) -> MetricPoint? {
        guard case .array(let pair) = value, pair.count == 2, case .number(let t) = pair[0],
            let time = Double(t)
        else { return nil }
        var number: Double?
        if case .string(let text) = pair[1], let v = Double(text), v.isFinite { number = v }
        return MetricPoint(time: time, value: number)
    }

    /// Parses a `query_range` (matrix) or `query` (vector) `data` object into
    /// series labelled by the values of `labels` joined with `/`.
    static func parseSeries(_ data: JSONValue, labels: [String]) throws -> [MetricSeries] {
        guard case .array(let result)? = data["result"] else {
            throw PromError.response("no data.result array")
        }
        return result.map { item -> MetricSeries in
            let name = labels.map { label -> String in
                if case .string(let v)? = item["metric"]?[label] { v } else { "" }
            }.joined(separator: "/")
            var points: [MetricPoint] = []
            if case .array(let values)? = item["values"] {
                points = values.compactMap(sample)
            } else if let value = item["value"], let point = sample(value) {
                points = [point]
            }
            return MetricSeries(label: name, points: points)
        }.sorted { $0.label < $1.label }
    }

    /// The `data` of a successful API response, or the server's error.
    static func unwrapData(_ body: JSONValue) throws -> JSONValue {
        switch body["status"] {
        case .string("success")?:
            guard let data = body["data"] else { throw PromError.response("no data") }
            return data
        case .string("error")?:
            if case .string(let reason)? = body["error"] {
                throw PromError.http(status: 400, reason: reason)
            }
            throw PromError.http(status: 400, reason: "query failed")
        default:
            throw PromError.response("no status field")
        }
    }

    /// The server's reason from an error body (`error`), else a status explanation.
    static func errorReason(body: String, status: Int) -> String {
        if case .string(let reason)? = JSONValue.parse(body)?["error"] { return reason }
        switch status {
        case 401: return "authentication failed — check the credentials"
        case 403: return "access denied"
        case 404: return "not found — check the URL (it should end before /api/v1)"
        default: return String(body.prefix(200))
        }
    }

    /// Grafana Explore with `queries` over `[from, to]` (Grafana 10+ `panes`
    /// state). An empty datasource uses Grafana's default.
    static func grafanaExploreURL(
        grafanaBase: String, datasource: String?, queries: [String], from: String, to: String
    ) -> String {
        let ds = datasource?.trimmingCharacters(in: .whitespaces).nilIfEmpty
        let items: [JSONValue] = queries.enumerated().map { n, expr in
            var members = [
                JSONMember(key: "refId", value: .string(refID(n))),
                JSONMember(key: "expr", value: .string(expr)),
            ]
            if let ds {
                members.append(
                    JSONMember(key: "datasource", value: .object([JSONMember(key: "uid", value: .string(ds))])))
            }
            return .object(members)
        }
        var pane = [
            JSONMember(key: "queries", value: .array(items)),
            JSONMember(
                key: "range",
                value: .object([
                    JSONMember(key: "from", value: .string(from)),
                    JSONMember(key: "to", value: .string(to)),
                ])),
        ]
        if let ds { pane.insert(JSONMember(key: "datasource", value: .string(ds)), at: 0) }
        let panes = JSONValue.object([JSONMember(key: "a", value: .object(pane))]).compactText
        return "\(Integration.trimmedBase(grafanaBase))/explore?schemaVersion=1&panes=\(Integration.percentEncode(panes))"
    }

    /// refId A, B, …, Z, AA, …
    private static func refID(_ index: Int) -> String {
        var id = ""
        var k = index
        while true {
            id.insert(Character(Unicode.Scalar(UInt8(65 + k % 26))), at: id.startIndex)
            if k < 26 { break }
            k = k / 26 - 1
        }
        return id
    }

    /// The API server path proxying to a service port.
    static func proxyBase(namespace: String, service: String, port: Int, https: Bool) -> String {
        "/api/v1/namespaces/\(namespace)/services/\(https ? "https" : "http"):\(service):\(port)/proxy"
    }

    /// Classifies a service as a Prometheus server (not Alertmanager, node
    /// exporter, operator, Pushgateway or kube-state-metrics) or a Grafana
    /// (#525), like the core.
    static func classify(_ service: IntegrationK8s.Service) -> DetectedPrometheus? {
        guard let name = service.metadata.name else { return nil }
        let excluded = [
            "alertmanager", "node-exporter", "operator", "pushgateway", "kube-state-metrics", "headless",
            "image-renderer",
        ]
        if excluded.contains(where: name.contains) { return nil }
        let labels = service.metadata.labels ?? [:]
        let grafana =
            labels["app.kubernetes.io/name"] == "grafana" || labels["app"] == "grafana"
            || name == "grafana" || name.hasSuffix("-grafana")
        let prometheus =
            labels["app.kubernetes.io/name"] == "prometheus"
            || labels["operated-prometheus"] == "true" || labels["app"] == "prometheus"
            || ["prometheus-operated", "prometheus-server", "prometheus"].contains(name)
            || name.hasSuffix("-prometheus")
        guard grafana || prometheus else { return nil }
        let wanted = grafana ? [80, 3000] : [9090]
        let ports = service.spec?.ports ?? []
        guard
            let port = ports.first(where: { wanted.contains($0.port) })
                ?? ports.first(where: { ["web", "http", "http-web", "service"].contains($0.name ?? "") })
                ?? ports.first
        else { return nil }
        return DetectedPrometheus(
            kind: grafana ? .grafana : .prometheus, namespace: service.metadata.namespace ?? "",
            name: name, port: port.port, https: port.name?.contains("https") ?? false)
    }

    // MARK: Azure CLI

    /// The resource Azure Monitor's query endpoints accept tokens for.
    static let azureResource = "https://prometheus.monitor.azure.com"

    /// Whether `url` is an Azure Monitor query endpoint — the only place an
    /// Azure token may be sent.
    static func isAzureMonitorURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https"
            && (url.host?.lowercased().hasSuffix(".prometheus.monitor.azure.com") ?? false)
    }

    /// Token and expiry from `az account get-access-token --output json`
    /// (`expires_on` in epoch seconds; older CLIs only have a local-time
    /// `expiresOn`, treated as a ten-minute lifetime).
    static func parseAzureToken(_ output: Data, now: Date) throws -> (token: String, expires: Date) {
        guard let json = JSONValue.parse(String(decoding: output, as: UTF8.self)) else {
            throw PromError.config("Unexpected Azure CLI output")
        }
        guard case .string(let token)? = json["accessToken"], !token.isEmpty else {
            throw PromError.config("The Azure CLI returned no access token")
        }
        var expires = now.addingTimeInterval(600)
        switch json["expires_on"] {
        case .number(let n)?: if let secs = Double(n) { expires = Date(timeIntervalSince1970: secs) }
        case .string(let s)?: if let secs = Double(s) { expires = Date(timeIntervalSince1970: secs) }
        default: break
        }
        return (token, expires)
    }

    /// Maps a failed `az` run to what the user should do.
    static func azureCLIError(_ stderr: String) -> PromError {
        if stderr.lowercased().contains("az login") {
            return .config("Not logged in to the Azure CLI — run `az login` and try again")
        }
        let first =
            stderr.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? "unknown error"
        return .config("Azure CLI failed: \(first)")
    }
}

extension String {
    fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
}
