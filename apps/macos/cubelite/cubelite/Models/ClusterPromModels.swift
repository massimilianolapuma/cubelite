import Foundation
import Observation

/// What a cluster or node chart shows (#530, mirrors the desktop's
/// `host-metrics.ts`): usage lines and an optional dashed reference.
struct HostPanel: Sendable {
    let title: String
    let unit: MetricsMath.Unit
    /// One line per chart, labelled with `labels` (same order).
    let usage: [HostChart]
    var labels: [String] = []
    var reference: HostChart?
    /// Name of the reference in the summary ("capacity", "size"); "alloc"
    /// when it comes from kube-state-metrics (allocatable).
    var referenceLabel = ""
    let emptyText: String

    static let clusterHint = "Cluster CPU and memory history and firing alerts from Prometheus."
    static let nodeHint = "CPU, memory, pods, network and filesystem history from Prometheus."
    private static let needsCadvisor = "no data — needs cAdvisor metrics in Prometheus"
    private static let needsKSM = "not available — needs kube-state-metrics or kubelet metrics in Prometheus"
    private static let needsExporter = "not available — needs node-exporter or cAdvisor metrics for this node"

    private static func cpu(_ empty: String) -> HostPanel {
        HostPanel(
            title: "CPU", unit: .cores, usage: [.cpu], reference: .cpuAllocatable, referenceLabel: "capacity",
            emptyText: empty)
    }

    private static func memory(_ empty: String) -> HostPanel {
        HostPanel(
            title: "Memory", unit: .bytes, usage: [.memory], reference: .memoryAllocatable,
            referenceLabel: "capacity", emptyText: empty)
    }

    static let cluster = [cpu(needsCadvisor), memory(needsCadvisor)]

    static let node = [
        cpu(needsExporter),
        memory(needsExporter),
        HostPanel(title: "Pods", unit: .count, usage: [.pods], emptyText: needsKSM),
        HostPanel(
            title: "Network", unit: .bytesPerSecond, usage: [.networkRx, .networkTx], labels: ["rx", "tx"],
            emptyText: needsExporter),
        HostPanel(
            title: "Filesystem", unit: .bytes, usage: [.filesystem], reference: .filesystemCapacity,
            referenceLabel: "size", emptyText: needsExporter),
    ]

    private func latest(_ result: HostMetrics, _ chart: HostChart) -> Double? {
        result.data(chart)?.series.first.flatMap { MetricsMath.latest($0.points) }
    }

    /// Usage lines (palette index per chart) and the reference, as
    /// `(label, points, dashed)`.
    func lines(_ result: HostMetrics) -> [(label: String, index: Int, points: [MetricPoint], dashed: Bool)] {
        var out = usage.enumerated().flatMap { index, chart in
            (result.data(chart)?.series ?? []).map {
                (label: index < labels.count ? labels[index] : "", index: index, points: $0.points, dashed: false)
            }
        }
        if let reference, let ref = result.data(reference)?.series.first {
            out.append((label: referenceName(result), index: 0, points: ref.points, dashed: true))
        }
        return out
    }

    /// The reference's name: "alloc" from kube-state-metrics, else the panel's.
    func referenceName(_ result: HostMetrics) -> String {
        reference.flatMap { result.data($0)?.source } == .kubeStateMetrics ? "alloc" : referenceLabel
    }

    /// "250m / alloc 4", or "↓ 1Ki/s ↑ 2Ki/s" for network.
    func summary(_ result: HostMetrics) -> String {
        func fmt(_ v: Double?) -> String { v.map { MetricsMath.format($0, unit) } ?? "—" }
        if usage.count == 2 {
            return "↓ \(fmt(latest(result, usage[0]))) ↑ \(fmt(latest(result, usage[1])))"
        }
        var parts = [fmt(latest(result, usage[0]))]
        if let reference, let ref = latest(result, reference) { parts.append("\(referenceName(result)) \(fmt(ref))") }
        return parts.joined(separator: " / ")
    }

    /// The usage charts' error (the reference is optional).
    func error(_ result: HostMetrics) -> String? {
        usage.lazy.compactMap { result.data($0)?.error }.first
    }

    /// Every query of the panel (Open in Grafana).
    func queries(_ result: HostMetrics) -> [String] {
        (usage + (reference.map { [$0] } ?? [])).compactMap { result.data($0)?.query }
    }

    /// "from node-exporter" for the first usage chart, when known.
    func source(_ result: HostMetrics) -> String? {
        result.data(usage[0])?.source.map { "from \($0.displayName)" }
    }
}

/// The Overview's Prometheus data (#530): cluster history and firing
/// alerts, loaded on the Overview's refresh cadence (every resource load),
/// at most every 30 s like the list sparklines; another range loads the
/// history at once. Another context or endpoint clears everything, and a
/// late answer for it is dropped.
@Observable @MainActor
final class OverviewPromModel {

    /// Minimum time between two loads of the same data.
    static let interval: TimeInterval = 30

    var range = MetricsRange.hour
    private(set) var usage: HostMetrics?
    /// Range of `usage` (the selection may already be another one).
    private(set) var usageRange = MetricsRange.hour
    private(set) var usageError: String?
    private(set) var isLoadingUsage = false
    private(set) var alerts: [PromAlert]?
    private(set) var alertsError: String?
    @ObservationIgnored private var scope: String?
    @ObservationIgnored private var usageAt: Date?
    @ObservationIgnored private var usageLoaded: MetricsRange?
    @ObservationIgnored private var alertsAt: Date?

    /// Loads what is due for `context` (nothing without an endpoint).
    func load(
        context: String?, endpoint: PromEndpoint?, querying: (any PrometheusClusterQuerying)?, now: Date = Date()
    ) async {
        let key = context.flatMap { c in endpoint.map { "\(c)|\($0)" } }
        if key != scope {
            scope = key
            usageAt = nil
            usageLoaded = nil
            alertsAt = nil
            usage = nil
            usageError = nil
            isLoadingUsage = false
            alerts = nil
            alertsError = nil
        }
        guard let key, let context, let endpoint, let querying else { return }
        let range = self.range
        let usageDue = range != usageLoaded || usageAt.map { now.timeIntervalSince($0) >= Self.interval } ?? true
        let alertsDue = alertsAt.map { now.timeIntervalSince($0) >= Self.interval } ?? true
        if usageDue {
            usageAt = now
            usageLoaded = range
        }
        if alertsDue { alertsAt = now }
        await withTaskGroup(of: Void.self) { group in
            if usageDue {
                group.addTask {
                    await self.loadUsage(
                        key: key, context: context, endpoint: endpoint, range: range, querying: querying)
                }
            }
            if alertsDue {
                group.addTask {
                    await self.loadAlerts(key: key, context: context, endpoint: endpoint, querying: querying)
                }
            }
        }
    }

    private func loadUsage(
        key: String, context: String, endpoint: PromEndpoint, range: MetricsRange,
        querying: any PrometheusClusterQuerying
    ) async {
        isLoadingUsage = true
        defer { if key == scope, range == usageLoaded { isLoadingUsage = false } }
        do {
            let data = try await querying.clusterUsage(context: context, endpoint: endpoint, range: range)
            guard key == scope, range == usageLoaded else { return }
            usage = data
            usageRange = range
            usageError = nil
        } catch is CancellationError {
            if key == scope { usageAt = nil }
        } catch {
            if key == scope, range == usageLoaded { usageError = error.localizedDescription }
        }
    }

    private func loadAlerts(
        key: String, context: String, endpoint: PromEndpoint, querying: any PrometheusClusterQuerying
    ) async {
        do {
            let data = try await querying.alerts(context: context, endpoint: endpoint)
            guard key == scope else { return }
            alerts = data.alerts
            alertsError = nil
        } catch is CancellationError {
            if key == scope { alertsAt = nil }
        } catch {
            if key == scope { alertsError = error.localizedDescription }
        }
    }
}

/// The newest of overlapping loads of one subject (a pod's or a node's
/// Metrics section, #512 #530): result, error and loading state. A late
/// answer of an older load is dropped, and another subject clears the
/// previous one's result at once.
@Observable @MainActor
final class LatestLoad<Value: Sendable, Args: Sendable> {
    private(set) var result: Value?
    private(set) var error: String?
    private(set) var isLoading = false
    /// What `result` was loaded with (its range).
    private(set) var args: Args
    @ObservationIgnored private var subject = ""
    @ObservationIgnored private var generation = 0

    init(_ initial: Args) {
        args = initial
    }

    /// Loads `subject` with `args`; only the newest call lands.
    func run(subject: String, args: Args, _ fetch: () async throws -> Value) async {
        if subject != self.subject {
            self.subject = subject
            result = nil
            error = nil
        }
        generation += 1
        let mine = generation
        error = nil
        isLoading = true
        defer { if mine == generation { isLoading = false } }
        do {
            let data = try await fetch()
            guard mine == generation else { return }
            result = data
            self.args = args
        } catch is CancellationError {
        } catch {
            guard mine == generation else { return }
            self.error = error.localizedDescription
            result = nil
        }
    }
}

/// State of a node's Metrics section (#530): range and the last result for
/// the shown node; only the newest call lands.
@Observable @MainActor
final class NodeMetricsModel {

    var range = MetricsRange.hour
    private let latest = LatestLoad<HostMetrics, MetricsRange>(.hour)
    var result: HostMetrics? { latest.result }
    var resultRange: MetricsRange { latest.args }
    var isLoading: Bool { latest.isLoading }
    var error: String? { latest.error }

    func load(
        context: String, endpoint: PromEndpoint, node: String, querying: any PrometheusClusterQuerying
    ) async {
        let range = self.range
        await latest.run(subject: "\(context)|\(node)", args: range) {
            try await querying.nodeMetrics(context: context, endpoint: endpoint, node: node, range: range)
        }
    }
}
