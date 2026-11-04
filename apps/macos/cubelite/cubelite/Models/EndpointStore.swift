import Foundation
import Observation

/// Per-context integration endpoints (Elasticsearch #503, Prometheus #512)
/// and the default shared by every context (#528). Only endpoints live
/// here, in UserDefaults; credentials are in the keychain. Same JSON and
/// rules as the desktop's stores.
///
/// A context's endpoint is `own ?? (off ? nil : default)`; the default
/// carries the context's own settings (Prometheus `cluster` label,
/// Elasticsearch cluster filter). Older settings (endpoints only) load as
/// they were: no default, nothing off.
@Observable @MainActor
final class EndpointStore<Endpoint: ScopedEndpoint> {

    let defaultsKey: String
    private(set) var endpoints: [String: Endpoint]
    /// The default endpoint (external only), stored without `shared`.
    private(set) var defaultEndpoint: Endpoint?
    /// Contexts where the default is off.
    private(set) var off: Set<String>
    private(set) var contextSettings: [String: Endpoint.ContextSettings]
    @ObservationIgnored private let defaults: UserDefaults

    init(key: String, defaults: UserDefaults = .standard) {
        defaultsKey = key
        self.defaults = defaults
        func decode<T: Decodable>(_ suffix: String, _ type: T.Type) -> T? {
            defaults.data(forKey: key + suffix).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
        }
        endpoints = decode("", [String: Endpoint].self) ?? [:]
        defaultEndpoint = decode(".default", Endpoint.self)
        off = Set(decode(".off", [String].self) ?? [])
        contextSettings = decode(".contexts", [String: Endpoint.ContextSettings].self) ?? [:]
    }

    /// The endpoint `context` uses: its own, else the default unless off.
    func endpoint(for context: String?) -> Endpoint? {
        guard let context else { return nil }
        return Self.resolve(
            own: endpoints[context], fallback: defaultEndpoint, off: off.contains(context),
            settings: contextSettings[context])
    }

    /// The default resolved with `settings` (a form's draft).
    func defaultEndpoint(with settings: Endpoint.ContextSettings?) -> Endpoint? {
        Self.resolve(own: nil, fallback: defaultEndpoint, off: false, settings: settings)
    }

    func ownEndpoint(for context: String?) -> Endpoint? {
        context.flatMap { endpoints[$0] }
    }

    func use(of context: String?) -> EndpointUse {
        guard let context else { return .none }
        if endpoints[context] != nil { return .own }
        if defaultEndpoint == nil { return .none }
        return off.contains(context) ? .off : .shared
    }

    /// The contexts among `contexts` that use the default.
    func usersOfDefault(_ contexts: [String]) -> [String] {
        contexts.filter { use(of: $0) == .shared }
    }

    /// Stores (or with nil removes) the endpoint of `context`; one of its
    /// own is never off.
    func setEndpoint(_ endpoint: Endpoint?, for context: String) {
        endpoints[context] = endpoint
        persist("", endpoints)
        if endpoint != nil { setOff(false, for: context) }
    }

    /// Stores (or with nil removes) the default; false for an in-cluster target.
    @discardableResult
    func setDefault(_ endpoint: Endpoint?) -> Bool {
        guard var endpoint else {
            defaultEndpoint = nil
            defaults.removeObject(forKey: defaultsKey + ".default")
            return true
        }
        guard case .external = endpoint.target else { return false }
        endpoint.shared = false
        defaultEndpoint = endpoint
        persist(".default", endpoint)
        return true
    }

    /// Turns the default off (or back on) for `context`.
    func setOff(_ isOff: Bool, for context: String) {
        guard off.contains(context) != isOff else { return }
        if isOff { off.insert(context) } else { off.remove(context) }
        persist(".off", off.sorted())
    }

    func setSettings(_ settings: Endpoint.ContextSettings?, for context: String) {
        contextSettings[context] = settings
        persist(".contexts", contextSettings)
    }

    private func persist<T: Encodable>(_ suffix: String, _ value: T) {
        if let data = try? JSONEncoder().encode(value) {
            defaults.set(data, forKey: defaultsKey + suffix)
        }
    }
}

typealias ElasticEndpointStore = EndpointStore<EsEndpoint>
typealias PrometheusEndpointStore = EndpointStore<PromEndpoint>

extension EndpointStore where Endpoint == EsEndpoint {
    convenience init(defaults: UserDefaults = .standard) {
        self.init(key: "elastic.endpoints", defaults: defaults)
    }
}

extension EndpointStore where Endpoint == PromEndpoint {
    convenience init(defaults: UserDefaults = .standard) {
        self.init(key: "prometheus.endpoints", defaults: defaults)
    }
}
