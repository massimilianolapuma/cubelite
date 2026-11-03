import Foundation
import Observation

/// Per-context integration endpoints (Elasticsearch #503, Prometheus #512).
/// Only endpoints live here, in UserDefaults; credentials are in the
/// keychain. Same JSON as the desktop's stores.
@Observable @MainActor
final class EndpointStore<Endpoint: Codable & Equatable & Sendable> {

    let defaultsKey: String
    private(set) var endpoints: [String: Endpoint]
    @ObservationIgnored private let defaults: UserDefaults

    init(key: String, defaults: UserDefaults = .standard) {
        defaultsKey = key
        self.defaults = defaults
        endpoints =
            defaults.data(forKey: key).flatMap {
                try? JSONDecoder().decode([String: Endpoint].self, from: $0)
            } ?? [:]
    }

    func endpoint(for context: String?) -> Endpoint? {
        context.flatMap { endpoints[$0] }
    }

    /// Stores (or with nil removes) the endpoint of `context`.
    func setEndpoint(_ endpoint: Endpoint?, for context: String) {
        endpoints[context] = endpoint
        if let data = try? JSONEncoder().encode(endpoints) {
            defaults.set(data, forKey: defaultsKey)
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
