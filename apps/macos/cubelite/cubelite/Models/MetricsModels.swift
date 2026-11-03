import Foundation
import Observation

/// What the Metrics section and list sparklines need from Prometheus
/// (PrometheusService in the app, a stub in tests).
protocol PrometheusQuerying: Sendable {
    func metrics(context: String, endpoint: PromEndpoint, request: MetricsRequest) async throws
        -> MetricsResult
    func sparklines(context: String, endpoint: PromEndpoint, namespace: String?) async throws
        -> Sparklines
}

extension PrometheusService: PrometheusQuerying {}

/// Prometheus endpoints and list sparklines for the views (#512). Sparklines
/// load after the rows, at most every 30 s per scope, and fail silently
/// (the reason is kept for the column help).
@Observable @MainActor
final class PrometheusStore {

    /// Minimum time between two sparkline loads for the same scope.
    static let sparklineInterval: TimeInterval = 30

    let endpoints: PrometheusEndpointStore
    let querying: (any PrometheusQuerying)?

    private(set) var sparklines: Sparklines?
    private(set) var sparklineError: String?
    @ObservationIgnored private var scope: Scope?
    @ObservationIgnored private var loadedAt: Date?

    init(endpoints: PrometheusEndpointStore, querying: (any PrometheusQuerying)?) {
        self.endpoints = endpoints
        self.querying = querying
    }

    func endpoint(for context: String?) -> PromEndpoint? {
        querying == nil ? nil : endpoints.endpoint(for: context)
    }

    /// Loads the last hour of CPU and memory for `namespace` (nil = every
    /// namespace) unless a recent load covers the same scope. Another
    /// cluster, namespace or endpoint clears the old data at once; a late
    /// answer for it is dropped.
    func loadSparklines(context: String?, namespace: String?, now: Date = Date()) async {
        let endpoint = endpoint(for: context)
        let key: Scope? =
            context != nil && endpoint != nil
            ? Scope(context: context, namespace: namespace, endpoint: endpoint) : nil
        if key != scope {
            scope = key
            loadedAt = nil
            sparklines = nil
            sparklineError = nil
        }
        guard let key, let context, let endpoint, let querying else { return }
        if let loadedAt, now.timeIntervalSince(loadedAt) < Self.sparklineInterval { return }
        loadedAt = now
        do {
            let data = try await querying.sparklines(context: context, endpoint: endpoint, namespace: namespace)
            guard key == scope else { return }
            sparklines = data
            sparklineError = nil
        } catch is CancellationError {
            // The view went away mid-load: let the next call load at once.
            if key == scope { loadedAt = nil }
        } catch {
            if key == scope { sparklineError = error.localizedDescription }
        }
    }

    /// Identity of what the lists show (reload when it changes).
    struct Scope: Hashable {
        let context: String?
        let namespace: String?
        let endpoint: PromEndpoint?
    }

    func scope(context: String?, namespace: String?) -> Scope {
        Scope(context: context, namespace: namespace, endpoint: endpoint(for: context))
    }

    func cpu(namespace: String, pod: String) -> [MetricPoint]? {
        sparklines?.cpu["\(namespace)/\(pod)"]
    }

    func memory(namespace: String, pod: String) -> [MetricPoint]? {
        sparklines?.memory["\(namespace)/\(pod)"]
    }
}

/// State of one Metrics section (#512, spec §5.1): range, split, the last
/// result for the shown pod or deployment.
@Observable @MainActor
final class MetricsSectionModel {

    var range = MetricsRange.hour
    var perContainer = true
    private(set) var result: MetricsResult?
    /// Range of `result` (the selection may already be another one).
    private(set) var resultRange = MetricsRange.hour
    private(set) var isLoading = false
    private(set) var error: String?
    @ObservationIgnored private var key = ""
    @ObservationIgnored private var generation = 0

    /// Loads the charts of `workload`; another pod or deployment never shows
    /// the previous one's charts, and only the newest call lands.
    func load(
        context: String, endpoint: PromEndpoint, namespace: String, workload: Workload,
        querying: any PrometheusQuerying
    ) async {
        let subject = "\(context)|\(namespace)|\(workload)"
        if subject != key {
            key = subject
            result = nil
            error = nil
        }
        generation += 1
        let mine = generation
        error = nil
        let request = MetricsRequest(
            namespace: namespace, workload: workload, range: range, perContainer: perContainer)
        isLoading = true
        defer { if mine == generation { isLoading = false } }
        do {
            let data = try await querying.metrics(context: context, endpoint: endpoint, request: request)
            guard mine == generation else { return }
            result = data
            resultRange = request.range
        } catch is CancellationError {
        } catch {
            guard mine == generation else { return }
            self.error = error.localizedDescription
            result = nil
        }
    }

    func series(_ chart: Chart) -> [MetricSeries] { result?.data(chart)?.series ?? [] }

    func chartError(_ charts: Chart...) -> String? {
        charts.lazy.compactMap { self.result?.data($0)?.error }.first
    }

    func queries(_ charts: Chart...) -> [String] {
        charts.compactMap { result?.data($0)?.query }
    }
}

/// Number helpers of the Metrics section.
enum MetricsMath {

    /// Last non-nil value.
    static func latest(_ points: [MetricPoint]) -> Double? {
        points.last { $0.value != nil }?.value
    }

    /// Sum of every series' latest value (nil when none has one).
    static func latestTotal(_ series: [MetricSeries]) -> Double? {
        let values = series.compactMap { latest($0.points) }
        return values.isEmpty ? nil : values.reduce(0, +)
    }

    /// Point-wise sum of series sharing timestamps (deployment sparklines,
    /// request and limit totals).
    static func sum(_ series: [[MetricPoint]]) -> [MetricPoint] {
        var byTime: [Double: Double] = [:]
        for points in series {
            for point in points {
                if let v = point.value { byTime[point.time, default: 0] += v }
            }
        }
        return byTime.sorted { $0.key < $1.key }.map { MetricPoint(time: $0.key, value: $0.value) }
    }

    enum Unit { case cores, bytes, bytesPerSecond, count }

    static func format(_ value: Double, _ unit: Unit) -> String {
        switch unit {
        case .cores:
            let millis = value * 1000
            if millis < 1000 { return "\(Int(millis.rounded()))m" }
            return value == value.rounded() ? String(Int(value)) : String(format: "%.2f", value)
        case .bytes: return bytes(value)
        case .bytesPerSecond: return bytes(value) + "/s"
        case .count: return String(Int(value.rounded()))
        }
    }

    /// Binary units ("512Mi", "2.0Gi"), like the desktop.
    private static func bytes(_ value: Double) -> String {
        let units = ["B", "Ki", "Mi", "Gi", "Ti"]
        var v = value
        var unit = 0
        while v >= 1024, unit < units.count - 1 {
            v /= 1024
            unit += 1
        }
        let text = v >= 10 || v == v.rounded() ? String(Int(v.rounded())) : String(format: "%.1f", v)
        return text + units[unit]
    }
}
