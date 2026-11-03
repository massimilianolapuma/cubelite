import Foundation

/// A workload the Logs view narrows to (#529): its pods, live and in
/// Elasticsearch history. Mirrors the desktop's `LogScope`.
struct LogScope: Hashable, Sendable, Identifiable {
    let namespace: String
    /// A deployment, StatefulSet, DaemonSet or Job (one pod opens the log panel).
    let workload: Workload

    var id: String { "\(kindLabel):\(namespace)/\(workload.name)" }

    var kindLabel: String {
        switch workload {
        case .pod: "Pod"
        case .deployment: "Deployment"
        case .statefulSet: "StatefulSet"
        case .daemonSet: "DaemonSet"
        case .job: "Job"
        }
    }

    /// Whether `pod` belongs to the workload: its namespace, and a name the
    /// workload's pod regexp matches (the one history and Prometheus use).
    func matcher() -> (PodInfo) -> Bool {
        let pattern = Prometheus.workloadPods(workload).map { "^(?:\($0))$" }
        let regex = pattern.flatMap { try? NSRegularExpression(pattern: $0) }
        let namespace = namespace
        let exact = workload.name
        return { pod in
            guard pod.namespace == namespace else { return false }
            guard let regex else { return pod.name == exact }
            let range = NSRange(pod.name.startIndex..., in: pod.name)
            return regex.firstMatch(in: pod.name, range: range) != nil
        }
    }
}

/// The Logs view's filter as a history query, or why History cannot
/// express it (#529).
enum LogsHistoryMapping: Equatable, Sendable {
    /// Search `namespace`, narrowed to `target` (nil: every pod).
    case query(namespace: String, target: Workload?)
    /// No history query for this filter; the reason is History's help text.
    case unavailable(String)

    static let selectorHint = "History can't filter by label selector — clear it to search Elasticsearch"
    static let namespaceHint = "Pick a namespace (or a workload) to search its history"

    /// A workload's pods, else the selected namespace. A label selector has
    /// no Elasticsearch equivalent, and every namespace at once is too broad.
    static func map(namespace: String?, scope: LogScope?, selector: String) -> Self {
        if !selector.trimmingCharacters(in: .whitespaces).isEmpty { return .unavailable(selectorHint) }
        if let scope { return .query(namespace: scope.namespace, target: scope.workload) }
        guard let namespace, !namespace.isEmpty else { return .unavailable(namespaceHint) }
        return .query(namespace: namespace, target: nil)
    }

    var reason: String? {
        if case .unavailable(let reason) = self { reason } else { nil }
    }
}
