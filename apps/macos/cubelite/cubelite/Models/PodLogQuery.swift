import Foundation

/// Builds the Kubernetes `/log` subresource path for a pod.
///
/// Single source of truth for log-query parameters, shared by the live
/// follow stream and the static previous-instance fetch. `timestamps=true`
/// is always sent; hiding timestamps is a render-time concern.
struct PodLogQuery: Equatable, Sendable {

    let namespace: String
    let pod: String
    var container: String?
    var follow: Bool
    var previous: Bool
    var tailLines: Int
    var sinceTime: String?

    init(
        namespace: String,
        pod: String,
        container: String? = nil,
        follow: Bool = true,
        previous: Bool = false,
        tailLines: Int = 500,
        sinceTime: String? = nil
    ) {
        self.namespace = namespace
        self.pod = pod
        self.container = container
        // Previous-instance logs are terminated output: never follow them.
        self.follow = previous ? false : follow
        self.previous = previous
        self.tailLines = tailLines
        self.sinceTime = sinceTime
    }

    /// API path with query string, percent-encoded.
    var path: String {
        var items: [String] = []
        if follow { items.append("follow=true") }
        if previous { items.append("previous=true") }
        items.append("timestamps=true")
        items.append("tailLines=\(tailLines)")
        if let container {
            items.append("container=\(Self.encode(container))")
        }
        if let sinceTime {
            items.append("sinceTime=\(Self.encode(sinceTime))")
        }
        return "/api/v1/namespaces/\(Self.encode(namespace))/pods/\(Self.encode(pod))/log"
            + "?" + items.joined(separator: "&")
    }

    private static func encode(_ value: String) -> String {
        value.addingPercentEncoding(
            withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-._~")))
            ?? value
    }
}
