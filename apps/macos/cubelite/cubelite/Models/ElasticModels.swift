import Foundation

// Elasticsearch log history and Kibana deep links (#483, #502).
//
// Spec: docs/superpowers/specs/2026-11-03-elastic-kibana-design.md.
// The pure half of the integration — endpoint model, `_search` body,
// hit → line mapping, Kibana Discover URL, credential binding — mirroring
// `crates/cubelite-core/src/elastic/mod.rs` with the same test vectors.
// `ElasticService` reaches the cluster.

/// Where the Elasticsearch HTTP API lives (shared with the other integrations).
typealias EsTarget = IntegrationTarget

/// Which log shipper wrote the documents, i.e. which field names to filter on.
enum FieldPreset: String, Codable, CaseIterable, Sendable {
    /// Elastic Agent / Filebeat (ECS): `kubernetes.pod.name`, `message`.
    case ecs
    /// Fluent Bit / Fluentd: `kubernetes.pod_name`, `log`.
    case fluentBit = "fluent-bit"

    struct Fields: Equatable, Sendable {
        let namespace: String
        let pod: String
        /// Exact filters also try the `.keyword` subfield (#529): Fluent Bit
        /// indices without a template map strings as `text` + `.keyword`
        /// (a `term` on a hyphenated name never matches the plain field),
        /// while a keyword template has no subfield. ECS fields are keywords.
        let keywordSubfields: Bool
        /// The `batch.kubernetes.io/job-name` label, when the shipper stores
        /// it under a predictable field (Filebeat / Elastic Agent dedot label
        /// keys); a Job's history also matches it.
        let jobLabel: String?
        let container: String
        let message: String
    }

    var fields: Fields {
        switch self {
        case .ecs:
            Fields(
                namespace: "kubernetes.namespace", pod: "kubernetes.pod.name",
                keywordSubfields: false,
                jobLabel: "kubernetes.labels.batch_kubernetes_io/job-name",
                container: "kubernetes.container.name", message: "message")
        case .fluentBit:
            Fields(
                namespace: "kubernetes.namespace_name", pod: "kubernetes.pod_name",
                keywordSubfields: true, jobLabel: nil,
                container: "kubernetes.container_name", message: "log")
        }
    }
}

/// A context's Elasticsearch endpoint (no secrets: those live in the keychain).
/// Same JSON shape as the desktop's `EsEndpoint`.
struct EsEndpoint: Hashable, Sendable, Codable {
    /// Default index pattern: Elastic Agent data streams, Filebeat, Logstash.
    static let defaultIndexPattern = "logs-*,filebeat-*,logstash-*"

    var target: EsTarget
    var indexPattern: String = Self.defaultIndexPattern
    var preset: FieldPreset = .ecs
    /// Kibana base URL, when known.
    var kibanaURL: String?
    /// In-cluster Kibana opened through a port-forward when there is no URL (#519).
    var kibanaService: KibanaService?
    /// Accept any certificate (opt-in, for self-signed endpoints without a CA).
    var skipTLSVerify = false

    private enum CodingKeys: String, CodingKey {
        case target, indexPattern, preset
        case kibanaURL = "kibanaUrl"
        case kibanaService
        case skipTLSVerify = "skipTlsVerify"
    }

    init(
        target: EsTarget, indexPattern: String = Self.defaultIndexPattern,
        preset: FieldPreset = .ecs, kibanaURL: String? = nil, kibanaService: KibanaService? = nil,
        skipTLSVerify: Bool = false
    ) {
        self.target = target
        self.indexPattern = indexPattern
        self.preset = preset
        self.kibanaURL = kibanaURL
        self.kibanaService = kibanaService
        self.skipTLSVerify = skipTLSVerify
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        target = try c.decode(EsTarget.self, forKey: .target)
        indexPattern = try c.decode(String.self, forKey: .indexPattern)
        preset = try c.decodeIfPresent(FieldPreset.self, forKey: .preset) ?? .ecs
        kibanaURL = try c.decodeIfPresent(String.self, forKey: .kibanaURL)
        kibanaService = try c.decodeIfPresent(KibanaService.self, forKey: .kibanaService)
        skipTLSVerify = try c.decodeIfPresent(Bool.self, forKey: .skipTLSVerify) ?? false
    }
}

/// A Kibana service in the cluster (from Detect); same JSON as the desktop.
typealias KibanaService = ServiceRef

/// Credentials for an endpoint. Never printed: `description`, `debugDescription`
/// and the mirror name only the method.
enum EsAuth: Equatable, Sendable {
    /// No authentication (security disabled).
    case none
    case basic(username: String, password: String)
    /// Elasticsearch API key (base64 `id:key`, as Kibana shows it).
    case apiKey(String)
    case bearer(String)
    /// ECK's built-in `elastic` user, read from the cluster at connect time
    /// (never stored, so rotations are picked up).
    case eckUser

    /// Tag shared with the desktop (`none`, `basic`, `api-key`, `bearer`, `eck-user`).
    var method: String {
        switch self {
        case .none: "none"
        case .basic: "basic"
        case .apiKey: "api-key"
        case .bearer: "bearer"
        case .eckUser: "eck-user"
        }
    }

    /// `Authorization` header value, if any (`eckUser` is resolved to
    /// `basic` before a connection is made).
    var header: String? {
        switch self {
        case .none, .eckUser:
            nil
        case .basic(let username, let password):
            "Basic " + Data("\(username):\(password)".utf8).base64EncodedString()
        case .apiKey(let key):
            "ApiKey " + key.trimmingCharacters(in: .whitespacesAndNewlines)
        case .bearer(let token):
            "Bearer " + token.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}

extension EsAuth: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    var description: String { "EsAuth(\(method))" }
    var debugDescription: String { description }
    var customMirror: Mirror { Mirror(self, children: ["method": method]) }
}

extension EsAuth: Codable {
    private enum CodingKeys: String, CodingKey {
        case method, username, password, key, token
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .method) {
        case "none": self = .none
        case "basic":
            self = .basic(
                username: try c.decode(String.self, forKey: .username),
                password: try c.decode(String.self, forKey: .password))
        case "api-key": self = .apiKey(try c.decode(String.self, forKey: .key))
        case "bearer": self = .bearer(try c.decode(String.self, forKey: .token))
        case "eck-user": self = .eckUser
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .method, in: c, debugDescription: "Unknown auth method \(other)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(method, forKey: .method)
        switch self {
        case .none, .eckUser: break
        case .basic(let username, let password):
            try c.encode(username, forKey: .username)
            try c.encode(password, forKey: .password)
        case .apiKey(let key): try c.encode(key, forKey: .key)
        case .bearer(let token): try c.encode(token, forKey: .token)
        }
    }
}

/// Errors of the Elasticsearch integration, with user-facing text.
enum ElasticError: Error, Equatable, LocalizedError {
    /// The endpoint configuration is unusable.
    case config(String)
    /// Could not reach the endpoint (port-forward, DNS, TLS, timeout).
    case connect(String)
    /// Elasticsearch answered with an error status.
    case http(status: Int, reason: String)
    /// The response was not what `_search` returns.
    case response(String)

    var errorDescription: String? {
        switch self {
        case .config(let text): text
        case .connect(let text): "Cannot reach Elasticsearch: \(text)"
        case .http(let status, let reason): "Elasticsearch returned \(status): \(reason)"
        case .response(let text): "Unexpected Elasticsearch response: \(text)"
        }
    }
}

extension ElasticError {
    init(_ failure: IntegrationFailure) {
        switch failure {
        case .config(let text): self = .config(text)
        case .connect(let text): self = .connect(text)
        }
    }
}

/// A page request for the history of one pod, a workload's pods (#529) or
/// a whole namespace.
struct HistoryQuery: Equatable, Sendable {
    /// Default and maximum page size.
    static let defaultPage = 500
    static let maxPage = 1000

    var namespace: String
    /// Pod name; empty (with no `workload`) for every pod of the namespace.
    var pod = ""
    /// The pods of a workload instead of `pod`: a regexp on the pod name
    /// (see `Elastic.podFilter`). Takes precedence over `pod`.
    var workload: Workload?
    /// Container filter; nil for every container.
    var container: String?
    /// RFC 3339 or Elasticsearch date math (`now-1h`) lower bound.
    var from: String
    /// Upper bound (`now`).
    var to: String
    /// Free text, as a `simple_query_string` on the message field.
    var text: String?
    /// Where the previous page ended (its `next`); nil for the first page.
    var searchAfter: HistoryCursor?
    /// Page size (default 500, capped at 1000).
    var size: Int?

    var pageSize: Int { min(max(size ?? Self.defaultPage, 1), Self.maxPage) }
}

/// Opaque paging cursor (#531): the `sort` values of the last hit (exact
/// numbers) and, when the search runs on a point in time, its id. The log
/// panel passes it back untouched for the next (older) page.
struct HistoryCursor: Equatable, Sendable {
    /// Point-in-time id; nil when the server has no PIT (plain `search_after`).
    var pitID: String?
    /// `sort` values of the last hit.
    var sort: [JSONValue]
}

/// One history line, newest first in a page.
struct HistoryLine: Equatable, Sendable {
    /// `@timestamp`.
    let time: String?
    /// Level from `log.level` / `level` / `severity`, else detected from the message.
    let level: LogLine.Level
    /// The message text (what Raw mode shows).
    let message: String
    /// Container, when the document names it.
    let container: String?
    /// The stored `_source`, compact JSON (what JSON / ECS modes render).
    let document: String
    /// `_index` of the hit (with `docID`, drops repeats between pages).
    var docIndex: String? = nil
    /// `_id` of the hit.
    var docID: String? = nil
    /// Pod, when the document names it (a workload's or namespace's history
    /// spans several pods, #529).
    var pod: String? = nil
}

/// One page of history, newest first.
struct HistoryPage: Equatable, Sendable {
    let lines: [HistoryLine]
    /// Total hits, when Elasticsearch counted them.
    let total: Int?
    /// `total` is a lower bound (more than 10 000 hits).
    let totalIsLowerBound: Bool
    /// Cursor of the next (older) page; nil at the end.
    let next: HistoryCursor?
}

/// Server facts for Preferences → Test connection.
struct EsInfo: Equatable, Sendable {
    let version: String
    let clusterName: String
    /// `green` / `yellow` / `red`, when the user may read cluster health.
    let health: String?
    /// Indices and data streams matching the pattern, when the user may list them.
    let indices: Int?
}

/// An Elasticsearch or Kibana service found in the cluster.
struct DetectedService: Hashable, Sendable, Identifiable {
    enum Kind: String, Sendable { case elasticsearch, kibana }

    let kind: Kind
    let namespace: String
    let name: String
    let port: Int
    let https: Bool

    var id: String { "\(kind.rawValue):\(namespace)/\(name):\(port)" }
}

// MARK: - Pure functions

enum Elastic {

    /// Characters Elasticsearch allows in index names and patterns (no `/`,
    /// `\`, `?`, `"`, `<`, `>`, `|`, `#`, space), so the pattern is safe in a path.
    static func validateIndexPattern(_ pattern: String) throws {
        let allowed = Set("._-*,:+")
        let segmentsSafe = pattern.split(separator: ",", omittingEmptySubsequences: false)
            .allSatisfy { segment in
                // `.`/`..` segments would be normalised away and escape the base path.
                let name = segment.split(separator: ":", omittingEmptySubsequences: false).last
                return name != "." && name != ".."
            }
        let ok =
            !pattern.trimmingCharacters(in: .whitespaces).isEmpty
            && pattern.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || allowed.contains($0) }
            && !(pattern.first.map { "_-+".contains($0) } ?? false)
            && segmentsSafe
        if !ok {
            throw ElasticError.config(
                "Invalid index pattern \"\(pattern)\": use names and wildcards separated by commas")
        }
    }

    /// How long Elasticsearch keeps a history point in time between pages.
    static let pitKeepAlive = "5m"

    /// `search_after` that resumes on a new point in time from the boundary
    /// timestamp of `sort`: the largest `_shard_doc` keeps every hit of that
    /// millisecond (newest first, descending tiebreaker).
    static func resumeSort(_ sort: [JSONValue]) -> [JSONValue] {
        [sort.first ?? .null, .number(String(Int64.max))]
    }

    /// The `_search` body for a history page: filter on namespace, pod,
    /// optional container and time range; newest first; `search_after` paging.
    ///
    /// With a point in time (`pit`), the search names no index and
    /// `_shard_doc` breaks every tie, so pages on one PIT neither skip nor
    /// repeat hits with equal timestamps (#531). When an expired PIT is
    /// replaced, paging resumes at the boundary millisecond, whose hits may
    /// repeat (never skip); `LogHistory` drops repeats by `_index` + `_id`.
    /// Without one (servers without PIT),
    /// `_index` + `_doc` break most ties; equal timestamps on different
    /// shards can still share sort values (rare), as on the desktop.
    static func searchBody(_ query: HistoryQuery, preset: FieldPreset, pit: String? = nil)
        -> JSONValue
    {
        let f = preset.fields
        var filter: [JSONValue] = [exact("term", f.namespace, .string(query.namespace), preset: preset)]
        if let pods = podFilter(query, preset: preset) { filter.append(pods) }
        filter += [
            object([
                "range": object([
                    "@timestamp": object(["gte": .string(query.from), "lte": .string(query.to)])
                ])
            ]),
        ]
        if let container = query.container, !container.isEmpty {
            filter.append(exact("term", f.container, .string(container), preset: preset))
        }
        var must: [JSONValue] = []
        if let text = query.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            must.append(
                object([
                    "simple_query_string": object([
                        "query": .string(text),
                        "fields": .array([.string(f.message)]),
                        "default_operator": .string("and"),
                    ])
                ]))
        }
        // `unmapped_type` keeps indices without `@timestamp` from failing.
        let timestamp = object([
            "@timestamp": object(["order": .string("desc"), "unmapped_type": .string("date")])
        ])
        let tiebreakers =
            pit == nil
            ? [object(["_index": .string("asc")]), object(["_doc": .string("asc")])]
            : [object(["_shard_doc": .string("desc")])]
        var members: [(String, JSONValue)] = [
            ("size", .number(String(query.pageSize))),
            ("track_total_hits", .number("10000")),
            ("query", object(["bool": object(["filter": .array(filter), "must": .array(must)])])),
            ("sort", .array([timestamp] + tiebreakers)),
        ]
        if let pit {
            members.append(
                ("pit", object(["id": .string(pit), "keep_alive": .string(pitKeepAlive)])))
        }
        if let after = query.searchAfter {
            members.append(("search_after", .array(after.sort)))
        }
        return .object(members.map { JSONMember(key: $0.0, value: $0.1) })
    }

    /// The pod clause of a history search: a `term` on one pod, a `regexp`
    /// on the keyword pod name for a workload's pods (the Prometheus regexp,
    /// so `api` never matches `api-gateway-…`; Lucene regexps match the
    /// whole term), or nil for the whole namespace. A Job's pods also match
    /// its `job-name` label when the preset stores it. Mirrors the core.
    static func podFilter(_ query: HistoryQuery, preset: FieldPreset) -> JSONValue? {
        let f = preset.fields
        guard let workload = query.workload else {
            return query.pod.isEmpty ? nil : exact("term", f.pod, .string(query.pod), preset: preset)
        }
        guard let pods = Prometheus.workloadPods(workload, literal: luceneRegexLiteral) else {
            return exact("term", f.pod, .string(workload.name), preset: preset)
        }
        let regexp = exact("regexp", f.pod, object(["value": .string(pods)]), preset: preset)
        guard case .job(let name) = workload, let label = f.jobLabel else { return regexp }
        return object([
            "bool": object([
                "should": .array([regexp, object(["term": object([label: .string(name)])])]),
                "minimum_should_match": .number("1"),
            ])
        ])
    }

    /// An exact clause (`term`, or `regexp` with `{"value": …}`) on `field`;
    /// with keyword subfields (Fluent Bit), either the field or its
    /// `.keyword` may match. Mirrors the core's `PresetFields::exact`.
    static func exact(_ kind: String, _ field: String, _ value: JSONValue, preset: FieldPreset) -> JSONValue {
        func clause(_ name: String) -> JSONValue {
            .object([JSONMember(key: kind, value: .object([JSONMember(key: name, value: value)]))])
        }
        guard preset.fields.keywordSubfields else { return clause(field) }
        return object([
            "bool": object([
                "should": .array([clause(field), clause("\(field).keyword")]),
                "minimum_should_match": .number("1"),
            ])
        ])
    }

    /// Maps a `_search` response to a history page. The cursor carries the
    /// response's `pit_id` (Elasticsearch may update it between pages).
    static func mapResponse(_ response: JSONValue, preset: FieldPreset, pageSize: Int) throws
        -> HistoryPage
    {
        let f = preset.fields
        guard case .array(let hits)? = response["hits"]?["hits"] else {
            throw ElasticError.response("no hits.hits array")
        }
        let lines = hits.map { hit -> HistoryLine in
            let source = hit["_source"] ?? .object([])
            var message =
                stringField(source, f.message) ?? stringField(source, "event.original")
                ?? source.compactText
            while message.hasSuffix("\n") || message.hasSuffix("\r") {
                message.removeLast()
            }
            let level =
                ["log.level", "level", "severity"].lazy
                .compactMap { stringField(source, $0).flatMap(mapLevel) }.first
                ?? LogLine.detectLevel(message)
            var docIndex: String?
            var docID: String?
            if case .string(let index)? = hit["_index"] { docIndex = index }
            if case .string(let id)? = hit["_id"] { docID = id }
            return HistoryLine(
                time: stringField(source, "@timestamp"), level: level, message: message,
                container: stringField(source, f.container), document: source.compactText,
                docIndex: docIndex, docID: docID, pod: stringField(source, f.pod))
        }
        var total: Int?
        var lowerBound = false
        switch response["hits"]?["total"] {
        case .number(let n)?:
            total = Int(n)
        case let obj?:
            if case .number(let n)? = obj["value"] { total = Int(n) }
            lowerBound = obj["relation"] == .string("gte")
        case nil:
            break
        }
        var next: HistoryCursor?
        if hits.count >= pageSize, case .array(let sort)? = hits.last?["sort"] {
            var pit: String?
            if case .string(let id)? = response["pit_id"] { pit = id }
            next = HistoryCursor(pitID: pit, sort: sort)
        }
        return HistoryPage(lines: lines, total: total, totalIsLowerBound: lowerBound, next: next)
    }

    /// The server's reason from an error body (`error.root_cause[0].reason`,
    /// `error.reason`, `error`), else a status explanation.
    static func errorReason(body: String, status: Int) -> String {
        if let error = JSONValue.parse(body)?["error"] {
            if case .array(let causes)? = error["root_cause"],
                case .string(let reason)? = causes.first?["reason"]
            {
                return reason
            }
            if case .string(let reason)? = error["reason"] { return reason }
            if case .string(let text) = error { return text }
        }
        switch status {
        case 401: return "authentication failed — check the credentials"
        case 403: return "the user may not read these indices"
        case 404: return "not found — check the index pattern"
        default: return String(body.prefix(200))
        }
    }

    /// Kibana Discover URL for one pod's logs over `[from, to]`.
    static func kibanaDiscoverURL(
        kibanaBase: String, preset: FieldPreset, namespace: String, pod: String,
        container: String?, from: String, to: String
    ) -> String {
        let f = preset.fields
        var query = "\(f.namespace):\(kql(namespace)) and \(f.pod):\(kql(pod))"
        if let container, !container.isEmpty {
            query += " and \(f.container):\(kql(container))"
        }
        return kibanaDiscoverURL(kibanaBase: kibanaBase, query: query, from: from, to: to)
    }

    /// Kibana Discover running `query` (KQL `kuery`, or `lucene`) over `[from, to]`.
    static func kibanaDiscoverURL(
        kibanaBase: String, query: String, language: String = "kuery", from: String, to: String
    ) -> String {
        let g = "(time:(from:\(rison(from)),to:\(rison(to))))"
        let a = "(query:(language:\(language),query:\(rison(query))))"
        return
            "\(kibanaHomeURL(kibanaBase: kibanaBase))?_g=\(Integration.percentEncode(g))&_a=\(Integration.percentEncode(a))"
    }

    /// Plain Kibana Discover, no filter (command palette, #526).
    static func kibanaHomeURL(kibanaBase: String) -> String {
        "\(Integration.trimmedBase(kibanaBase))/app/discover#/"
    }

    /// Kibana Discover for a workload's logs since `from` (#526, #529): one
    /// pod (KQL), else the Lucene query of `workloadLuceneQuery` — the
    /// history's filter.
    static func kibanaWorkloadURL(
        kibanaBase: String, preset: FieldPreset, namespace: String, workload: Workload?,
        from: String = "now-1h"
    ) -> String {
        if case .pod(let name)? = workload {
            return kibanaDiscoverURL(
                kibanaBase: kibanaBase, preset: preset, namespace: namespace, pod: name, container: nil,
                from: from, to: "now")
        }
        let query = workloadLuceneQuery(preset: preset, namespace: namespace, workload: workload)
        return kibanaDiscoverURL(kibanaBase: kibanaBase, query: query, language: "lucene", from: from, to: "now")
    }

    /// Lucene query for a workload's pods in `namespace` (#526, #529): ECS
    /// has no deployment field, so the pod name must match the regexp of
    /// `podFilter` (same as the Prometheus selector: `api-<hash>-<suffix>`,
    /// never `api-gateway-…`). A Job also matches its `job-name` label when
    /// the preset stores it; nil is the whole namespace. Mirrors the core.
    static func workloadLuceneQuery(preset: FieldPreset, namespace: String, workload: Workload?) -> String {
        let f = preset.fields
        // Lucene's quoted phrase escapes `\` and `"` like the KQL literal.
        let query = "\(f.namespace):\(kql(namespace))"
        guard let workload else { return query }
        let pods =
            Prometheus.workloadPods(workload, literal: luceneRegexLiteral).map { regexp in
                f.keywordSubfields
                    ? "(\(f.pod):/\(regexp)/ OR \(f.pod).keyword:/\(regexp)/)" : "\(f.pod):/\(regexp)/"
            }
            ?? "\(f.pod):\(kql(workload.name))"
        if case .job(let name) = workload, let label = f.jobLabel {
            return "\(query) AND (\(pods) OR \(luceneField(label)):\(kql(name)))"
        }
        return "\(query) AND \(pods)"
    }

    /// Escapes a field name for a Lucene query string (`/` and `-` in label
    /// fields such as `batch_kubernetes_io/job-name`).
    static func luceneField(_ name: String) -> String {
        var out = ""
        for c in name {
            if !(c.isASCII && (c.isLetter || c.isNumber)) && c != "." && c != "_" { out.append("\\") }
            out.append(c)
        }
        return out
    }

    /// Escapes Lucene regexp metacharacters so a name matches literally
    /// (Lucene regexps match the whole term).
    static func luceneRegexLiteral(_ name: String) -> String {
        var out = ""
        for c in name {
            if ".?+*|{}[]()\"\\#@&<>~/".contains(c) { out.append("\\") }
            out.append(c)
        }
        return out
    }

    /// What stored credentials are bound to (see `Integration.binding`).
    static func binding(_ endpoint: EsEndpoint) throws -> String {
        try mapped { try Integration.binding(endpoint.target, skipTLSVerify: endpoint.skipTLSVerify) }
    }

    /// Checks an external URL (see `Integration.checkExternalURL`); ECK's
    /// user applies to in-cluster endpoints only.
    static func checkExternalURL(_ url: String, auth: EsAuth) throws -> URL {
        if auth == .eckUser {
            throw ElasticError.config("ECK credentials apply to in-cluster endpoints only")
        }
        return try mapped { try Integration.checkExternalURL(url, sendsCredentials: auth != .none) }
    }

    /// The `Authorization` value for `auth`, refusing what cannot travel in a header.
    static func checkedHeader(_ auth: EsAuth) throws -> String? {
        try mapped { try Integration.checkedHeader(auth.header) }
    }

    /// Runs a shared integration helper, reporting its failure as an `ElasticError`.
    static func mapped<T>(_ body: () throws -> T) throws -> T {
        do {
            return try body()
        } catch let failure as IntegrationFailure {
            throw ElasticError(failure)
        }
    }

    // MARK: Helpers

    static func mapLevel(_ raw: String) -> LogLine.Level? {
        switch raw.trimmingCharacters(in: .whitespaces).lowercased() {
        case "trace", "debug", "verbose": .debug
        case "info", "information", "notice": .info
        case "warn", "warning": .warn
        case "error", "err", "fatal", "critical", "crit", "alert", "emerg", "panic": .error
        default: nil
        }
    }

    /// Reads a dotted path from a document that may be nested
    /// (`{"log":{"level":…}}`), flat (`{"log.level":…}`) or mixed.
    static func field(_ doc: JSONValue, _ path: String) -> JSONValue? {
        if let value = doc[path] { return value }
        guard let dot = path.firstIndex(of: ".") else { return nil }
        let head = String(path[..<dot])
        let rest = String(path[path.index(after: dot)...])
        guard let child = doc[head] else { return nil }
        return field(child, rest) ?? child[rest]
    }

    static func stringField(_ doc: JSONValue, _ path: String) -> String? {
        switch field(doc, path) {
        case .string(let s)?: s
        case .array(let items)?:
            if case .string(let s)? = items.first { s } else { nil }
        default: nil
        }
    }

    private static func object(_ pairs: KeyValuePairs<String, JSONValue>) -> JSONValue {
        .object(pairs.map { JSONMember(key: $0.key, value: $0.value) })
    }

    /// Rison string literal (Kibana URL state): `'…'` with `!` → `!!`, `'` → `!'`.
    private static func rison(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "!", with: "!!").replacingOccurrences(of: "'", with: "!'")
            + "'"
    }

    /// KQL string literal: `"…"` with `\` and `"` escaped.
    private static func kql(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
            + "\""
    }

}

// MARK: - JSONValue access

extension JSONValue {
    /// Member of an object (the last one for duplicate keys, like `JSON.parse`).
    subscript(key: String) -> JSONValue? {
        guard case .object(let members) = self else { return nil }
        return members.last { $0.key == key }?.value
    }
}
