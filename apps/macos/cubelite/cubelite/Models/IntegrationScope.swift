import Foundation

// Integration endpoints shared across kube contexts (#528), mirroring the
// desktop's `endpoint-scope.ts` and the core's `cluster_filter.rs` /
// `label_values`: a default endpoint used by every context without one of
// its own, per-context overrides and "off", the Elasticsearch cluster
// filter and the Prometheus `cluster` label picker.

// MARK: - Default endpoint

extension Integration {
    /// Keychain account of the default endpoint's credentials, next to one
    /// account per kube context (same as the desktop).
    static let defaultAccount = "*default*"

    /// A default endpoint shared by every context must be external: an
    /// in-cluster service is per cluster by nature.
    static func checkShared(_ target: IntegrationTarget, shared: Bool) throws {
        if shared, case .inCluster = target {
            throw IntegrationFailure.config("A default endpoint shared by every context must be an external URL")
        }
    }
}

/// An endpoint a store can share across contexts.
protocol ScopedEndpoint: Codable, Equatable, Sendable {
    /// A context's own settings applied to the default endpoint.
    associatedtype ContextSettings: Codable, Equatable, Sendable
    var target: IntegrationTarget { get }
    /// Resolved from the default: the backend uses the default's credentials.
    var shared: Bool { get set }
    func merged(with settings: ContextSettings) -> Self
}

/// How a context gets its endpoint.
enum EndpointUse: Equatable, Sendable {
    case own, shared, off, none
}

/// Which endpoint the preferences edit.
enum EndpointScopeKind: String, CaseIterable, Sendable {
    case context
    case allContexts = "default"

    var label: String {
        switch self {
        case .context: "This context"
        case .allContexts: "All contexts (default)"
        }
    }
}

/// What the preferences show for a context.
enum ScopeView: Equatable, Sendable {
    /// Editing the default endpoint.
    case sharedDefault
    /// Editing the context's own endpoint.
    case own
    /// The context uses the default (its own settings only).
    case inherited
    /// The default is off for the context.
    case off

    static func of(scope: EndpointScopeKind, use: EndpointUse, overriding: Bool) -> ScopeView {
        if scope == .allContexts { return .sharedDefault }
        if overriding || use == .own || use == .none { return .own }
        return use == .shared ? .inherited : .off
    }
}

/// Same copy as the desktop.
enum ScopeText {
    static let usingDefault = "Using the default endpoint"
    static let offForContext = "Off for this context: the default endpoint is not used."
    static let overridesDefault = "This context overrides the default endpoint."
    static let override = "Override"
    static let turnOff = "Turn off for this context"
    static let useDefault = "Use the default endpoint"
    static let defaultHint =
        "Only external URLs can be shared by every context. Credentials are saved once, for this URL only."
    static let usedByNone = "No context uses the default endpoint yet."

    static func usedBy(_ contexts: [String]) -> String {
        contexts.isEmpty ? usedByNone : "Used by: \(contexts.joined(separator: ", "))"
    }
}

extension EndpointStore {
    /// `own ?? (off ? nil : default)`, the default carrying the context's
    /// settings and marked `shared`.
    static func resolve(
        own: Endpoint?, fallback: Endpoint?, off: Bool, settings: Endpoint.ContextSettings?
    ) -> Endpoint? {
        if let own { return own }
        guard !off, var fallback, case .external = fallback.target else { return nil }
        if let settings { fallback = fallback.merged(with: settings) }
        fallback.shared = true
        return fallback
    }
}

// MARK: - Context settings

/// A context's `cluster` label on the shared default (Prometheus).
struct PrometheusContextSettings: Codable, Equatable, Sendable {
    var cluster: String?
}

/// A context's cluster filter on the shared default (Elasticsearch).
struct ElasticContextSettings: Codable, Equatable, Sendable {
    var clusterFilter: ClusterFilter?
}

extension PromEndpoint: ScopedEndpoint {
    func merged(with settings: PrometheusContextSettings) -> PromEndpoint {
        var copy = self
        if let cluster = settings.cluster, !cluster.isEmpty { copy.cluster = cluster }
        return copy
    }
}

extension EsEndpoint: ScopedEndpoint {
    /// A blank field takes the default's.
    func merged(with settings: ElasticContextSettings) -> EsEndpoint {
        guard let own = settings.clusterFilter else { return self }
        var copy = self
        let field = own.field.isEmpty ? (clusterFilter?.field ?? "") : own.field
        copy.clusterFilter = ClusterFilter(field: field, value: own.value)
        return copy
    }
}

// MARK: - Elasticsearch cluster filter

/// A `field: value` term added to every history query.
struct ClusterFilter: Codable, Hashable, Sendable {
    /// ECS field naming the cluster a document comes from.
    static let ecsField = "orchestrator.cluster.name"

    /// Empty uses `ecsField` with the ECS preset.
    var field: String
    var value: String

    init(field: String = "", value: String) {
        self.field = field
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        field = try c.decodeIfPresent(String.self, forKey: .field) ?? ""
        value = try c.decode(String.self, forKey: .value)
    }

    /// The filter typed in a form; nil when both are blank.
    static func typed(field: String, value: String) -> ClusterFilter? {
        let f = field.trimmed
        let v = value.trimmed
        return f.isEmpty && v.isEmpty ? nil : ClusterFilter(field: f, value: v)
    }

    /// Placeholder of the field: the one used when left blank.
    static func fieldHint(preset: FieldPreset, fallback: String?) -> String {
        if let fallback, !fallback.isEmpty { return fallback }
        return preset == .ecs ? ecsField : "cluster field"
    }

    /// `(field, value)` to filter on; nil without a value, or without a field
    /// for a preset that has no cluster field.
    func term(preset: FieldPreset) -> (field: String, value: String)? {
        let v = value.trimmed
        guard !v.isEmpty else { return nil }
        let f = field.trimmed
        if !f.isEmpty { return (f, v) }
        return preset == .ecs ? (Self.ecsField, v) : nil
    }
}

extension Elastic {
    /// Adds the cluster term to a `searchBody` (its `query.bool.filter`).
    static func addingClusterFilter(_ body: JSONValue, _ filter: ClusterFilter?, preset: FieldPreset)
        -> JSONValue
    {
        guard let (field, value) = filter?.term(preset: preset) else { return body }
        let term = JSONValue.object([
            JSONMember(key: "term", value: .object([JSONMember(key: field, value: .string(value))]))
        ])
        return body.updating(["query", "bool", "filter"]) { list in
            guard case .array(let items) = list else { return list }
            return .array(items + [term])
        }
    }
}

extension JSONValue {
    /// The value with the member at `path` replaced by `change(old)`.
    fileprivate func updating(_ path: ArraySlice<String>, _ change: (JSONValue) -> JSONValue) -> JSONValue {
        guard let key = path.first else { return change(self) }
        guard case .object(let members) = self else { return self }
        return .object(
            members.map { member in
                member.key == key
                    ? JSONMember(key: key, value: member.value.updating(path.dropFirst(), change)) : member
            })
    }

    fileprivate func updating(_ path: [String], _ change: (JSONValue) -> JSONValue) -> JSONValue {
        updating(path[...], change)
    }
}

// MARK: - Prometheus cluster label

enum ClusterLabel {
    /// Series whose `cluster` label names the clusters with Kubernetes
    /// metrics (cAdvisor, kube-state-metrics), not every scraped job.
    static let series = ["container_cpu_usage_seconds_total", "kube_pod_info"]

    /// `/api/v1/label/<label>/values` with one `match[]` per selector.
    static func valuesPath(label: String, matches: [String]) throws -> String {
        let valid =
            label.first.map { $0.isASCII && ($0.isLetter || $0 == "_") } == true
            && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
        guard valid else { throw PromError.config("Invalid label name \"\(label)\"") }
        let query = matches.map { "match%5B%5D=\(Integration.percentEncode($0))" }.joined(separator: "&")
        return "/api/v1/label/\(label)/values" + (query.isEmpty ? "" : "?\(query)")
    }

    /// The values of a label values answer's `data`: sorted, unique, no blanks.
    static func values(_ data: JSONValue) -> [String] {
        guard case .array(let items) = data else { return [] }
        let strings = items.compactMap { item -> String? in
            guard case .string(let s) = item, !s.trimmed.isEmpty else { return nil }
            return s
        }
        return Array(Set(strings)).sorted()
    }

    /// The value matching a kube context: equal to its name, else the
    /// shortest value containing it, else the longest value the name
    /// contains (`admin@aks-prod` → `aks-prod`). Case-insensitive.
    static func match(_ values: [String], context: String) -> String? {
        let name = context.lowercased()
        if let exact = values.first(where: { $0.lowercased() == name }) { return exact }
        let containing = values.filter { $0.lowercased().contains(name) }
        if let shortest = containing.min(by: { $0.count < $1.count }) { return shortest }
        return values.filter { !$0.isEmpty && name.contains($0.lowercased()) }.max { $0.count < $1.count }
    }
}
