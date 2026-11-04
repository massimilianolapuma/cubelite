import Foundation

// Firing alerts for the Overview (#530), mirroring
// `crates/cubelite-core/src/prometheus/alerts.rs`. `/api/v1/alerts` is
// preferred (annotations, activeAt); without it (Azure Monitor, some
// proxies) the `ALERTS{alertstate="firing"}` series. The alerting rules give
// each alert its expression for Open in Grafana, else its `ALERTS` series.

/// A firing alert.
struct PromAlert: Equatable, Sendable, Identifiable {
    let name: String
    let severity: String?
    let namespace: String?
    let pod: String?
    let node: String?
    /// `summary` annotation, else `description` / `message`.
    let summary: String?
    /// Firing since (RFC 3339), when the source has it.
    let activeAt: String?
    /// PromQL for Open in Grafana.
    var expr: String
    let labels: [String: String]

    var id: String { labels.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ",") }
}

struct PromAlertsResult: Equatable, Sendable {
    enum Source: String, Sendable {
        case alertsAPI = "alerts-api"
        case alertsMetric = "alerts-metric"
    }

    let alerts: [PromAlert]
    let source: Source
}

/// An alerting rule's name, extra labels and expression.
struct PromAlertRule: Equatable, Sendable {
    let name: String
    let labels: [String: String]
    let query: String
}

enum PromAlerts {

    private static func strings(_ value: JSONValue?) -> [String: String] {
        guard case .object(let members)? = value else { return [:] }
        var out: [String: String] = [:]
        for member in members {
            if case .string(let s) = member.value { out[member.key] = s }
        }
        return out
    }

    private static func string(_ value: JSONValue?) -> String? {
        if case .string(let s)? = value { s } else { nil }
    }

    private static func clusterMatcher(_ cluster: String?) -> String {
        guard let c = cluster?.trimmingCharacters(in: .whitespaces), !c.isEmpty else { return "" }
        return ", cluster=\(Prometheus.escape(c))"
    }

    /// `ALERTS{alertname="…", alertstate="firing"}`: the fallback expression.
    static func seriesQuery(name: String, cluster: String?) -> String {
        #"ALERTS{alertname=\#(Prometheus.escape(name)), alertstate="firing"\#(clusterMatcher(cluster))}"#
    }

    /// Every firing alert's series (the fallback list).
    static func metricQuery(cluster: String?) -> String {
        #"ALERTS{alertstate="firing"\#(clusterMatcher(cluster))}"#
    }

    private static func alert(labels: [String: String], annotations: [String: String], activeAt: String?)
        -> PromAlert?
    {
        guard let name = labels["alertname"] else { return nil }
        func label(_ key: String) -> String? { labels[key].flatMap { $0.isEmpty ? nil : $0 } }
        let summary = ["summary", "description", "message"].lazy
            .compactMap { annotations[$0]?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        return PromAlert(
            name: name, severity: label("severity"), namespace: label("namespace"), pod: label("pod"),
            node: label("node"), summary: summary, activeAt: activeAt, expr: "", labels: labels)
    }

    /// Firing alerts of an `/api/v1/alerts` `data` object (pending ones left out).
    static func parseAlertsAPI(_ data: JSONValue) throws -> [PromAlert] {
        guard case .array(let items)? = data["alerts"] else { throw PromError.response("no data.alerts array") }
        return items.compactMap { item in
            guard string(item["state"]) == "firing" else { return nil }
            return alert(
                labels: strings(item["labels"]), annotations: strings(item["annotations"]),
                activeAt: string(item["activeAt"]))
        }
    }

    /// Alerts of an `ALERTS{alertstate="firing"}` vector (`data`).
    static func parseAlertsMetric(_ data: JSONValue) throws -> [PromAlert] {
        guard case .array(let items)? = data["result"] else { throw PromError.response("no data.result array") }
        return items.compactMap { item in
            var labels = strings(item["metric"])
            labels["__name__"] = nil
            labels["alertstate"] = nil
            return alert(labels: labels, annotations: [:], activeAt: nil)
        }
    }

    /// Alerting rules of an `/api/v1/rules` `data` object.
    static func parseRules(_ data: JSONValue) -> [PromAlertRule] {
        guard case .array(let groups)? = data["groups"] else { return [] }
        return groups.flatMap { group -> [PromAlertRule] in
            guard case .array(let rules)? = group["rules"] else { return [] }
            return rules.compactMap { rule in
                guard (string(rule["type"]) ?? "alerting") == "alerting", let name = string(rule["name"]),
                    let query = string(rule["query"])
                else { return nil }
                return PromAlertRule(name: name, labels: strings(rule["labels"]), query: query)
            }
        }
    }

    /// Gives each alert its rule's expression (same name, the rule's labels
    /// on the alert), else its `ALERTS` series.
    static func attachExprs(_ alerts: [PromAlert], rules: [PromAlertRule], cluster: String?) -> [PromAlert] {
        alerts.map { alert in
            var out = alert
            out.expr =
                rules.first { rule in
                    rule.name == alert.name && rule.labels.allSatisfy { alert.labels[$0.key] == $0.value }
                }?.query ?? seriesQuery(name: alert.name, cluster: cluster)
            return out
        }
    }

    static func severityRank(_ severity: String?) -> Int {
        switch severity?.lowercased() {
        case "critical", "page": 0
        case "error", "high": 1
        case "warning", "warn": 2
        case "info", "low": 3
        case "none": 5
        default: 4
        }
    }

    /// Keeps the alerts of `cluster` (and those without a `cluster` label),
    /// most severe first, then oldest first, then by name.
    static func finish(_ alerts: [PromAlert], cluster: String?) -> [PromAlert] {
        var kept = alerts
        if let c = cluster?.trimmingCharacters(in: .whitespaces), !c.isEmpty {
            kept = kept.filter { $0.labels["cluster"].map { $0 == c } ?? true }
        }
        return kept.sorted { a, b in
            let (ra, rb) = (severityRank(a.severity), severityRank(b.severity))
            if ra != rb { return ra < rb }
            switch (a.activeAt, b.activeAt) {
            case (let x?, let y?) where x != y: return x < y
            case (.some, nil): return true
            case (nil, .some): return false
            default: break
            }
            if a.name != b.name { return a.name < b.name }
            return a.id < b.id
        }
    }

    // MARK: Display

    enum Tone: Equatable { case err, warn, neutral }

    /// Critical/error red, warning amber, else neutral.
    static func tone(_ severity: String?) -> Tone {
        switch severity?.lowercased() {
        case "critical", "page", "error", "high": .err
        case "warning", "warn": .warn
        default: .neutral
        }
    }

    /// What the alert is about: `namespace/pod`, the node, or the namespace.
    static func subject(_ alert: PromAlert) -> String? {
        if let namespace = alert.namespace, let pod = alert.pod { return "\(namespace)/\(pod)" }
        return alert.node ?? alert.namespace
    }

    /// The resource an alert row opens.
    enum Target: Equatable {
        case pod(PodInfo.ID)
        case node(String)
    }

    /// A loaded pod, else the node by name; nil when neither resolves.
    static func target(_ alert: PromAlert, pods: [PodInfo]) -> Target? {
        if let namespace = alert.namespace, let name = alert.pod,
            let pod = pods.first(where: { $0.namespace == namespace && $0.name == name })
        {
            return .pod(pod.id)
        }
        return alert.node.map(Target.node)
    }

    /// "firing 3h" from `activeAt`, or "firing" without a time. Prometheus
    /// writes nanoseconds, which ISO8601DateFormatter does not read: the
    /// fraction is dropped.
    static func firingSince(_ activeAt: String?, now: Date = Date()) -> String {
        guard let activeAt else { return "firing" }
        let trimmed = activeAt.replacingOccurrences(of: #"\.[0-9]+"#, with: "", options: .regularExpression)
        guard let date = ISO8601DateFormatter().date(from: trimmed) else { return "firing" }
        return "firing \(age(seconds: Int(now.timeIntervalSince(date))))"
    }

    /// Like the desktop's `formatAge` ("3h", "1d4h", "5m").
    static func age(seconds: Int) -> String {
        let s = max(seconds, 0)
        let (days, hours, minutes) = (s / 86_400, s % 86_400 / 3_600, s % 3_600 / 60)
        if days >= 10 { return "\(days)d" }
        if days >= 1 { return hours > 0 ? "\(days)d\(hours)h" : "\(days)d" }
        if hours >= 10 { return "\(hours)h" }
        if hours >= 1 { return minutes > 0 ? "\(hours)h\(minutes)m" : "\(hours)h" }
        if minutes >= 1 { return "\(minutes)m" }
        return "\(s)s"
    }
}
