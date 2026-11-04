import AppKit
import SwiftUI

/// The charts of the cluster history or of a node (#530): one chart per
/// panel, its exporter after the title, "not available" when no exporter
/// has the series.
struct HostChartsView: View {
    let result: HostMetrics
    let range: MetricsRange
    let panels: [HostPanel]
    /// Opens Grafana Explore on the given queries; nil hides the links.
    let onGrafana: (([String]) -> Void)?

    var body: some View {
        // The chart only reads the range bounds of a MetricsResult.
        let frame = MetricsResult(start: result.start, end: result.end, step: result.step, charts: [])
        ForEach(panels, id: \.title) { panel in
            MetricChartView(
                title: panel.title, unit: panel.unit, summary: panel.summary(result), lines: lines(panel),
                result: frame, range: range, error: panel.error(result), emptyText: panel.emptyText,
                onGrafana: onGrafana.map { open in { open(panel.queries(result)) } },
                note: panel.source(result))
        }
    }

    private func lines(_ panel: HostPanel) -> [ChartLine] {
        panel.lines(result).map { line in
            ChartLine(
                label: line.label,
                color: line.dashed
                    ? DesignTokens.textTertiary
                    : MetricsSectionView.palette[line.index % MetricsSectionView.palette.count],
                points: line.points, dashed: line.dashed)
        }
    }
}

/// The 1h · 6h · 24h · 7d control of the Metrics sections and the cluster
/// history.
struct MetricsRangePicker: View {
    let label: String
    @Binding var selection: MetricsRange

    var body: some View {
        Picker(label, selection: $selection) {
            ForEach(MetricsRange.allCases, id: \.self) { Text($0.rawValue).tag($0) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
    }
}

/// Opens Grafana Explore on `queries` over `range` for a context's endpoint;
/// `failure` gets the reason it could not (#530).
@MainActor
enum GrafanaLink {
    static func open(
        store: PrometheusStore?, context: String?, endpoint: PromEndpoint, queries: [String], range: MetricsRange,
        failure: @escaping @MainActor (String) -> Void
    ) {
        guard let store, let context else { return }
        WebUI.open({
            try await store.grafanaExploreURL(context: context, endpoint: endpoint, queries: queries, range: range)
        }, failure: failure)
    }
}
