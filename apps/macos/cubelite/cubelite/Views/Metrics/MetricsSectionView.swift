import AppKit
import Charts
import SwiftUI

/// One line of a chart; dashed for reference lines (requests, limits).
struct ChartLine: Identifiable {
    let label: String
    let color: Color
    let points: [MetricPoint]
    var dashed = false

    var id: String { label + (dashed ? "-ref" : "") }
}

/// Metrics section of a pod or deployment detail (#512, spec §5.1): the
/// recent history from Prometheus, only when the context has an endpoint.
struct MetricsSectionView: View {

    @Environment(PrometheusStore.self) private var store: PrometheusStore?
    let context: String?
    let namespace: String
    let workload: Workload

    @State private var model = MetricsSectionModel()

    private static let palette: [Color] = [
        DesignTokens.accentDefault, DesignTokens.clusterTeal, DesignTokens.clusterViolet,
        DesignTokens.clusterAmber, DesignTokens.clusterPink, DesignTokens.clusterBlue,
    ]

    var body: some View {
        if let context, let store, let endpoint = store.endpoint(for: context), let querying = store.querying {
            VStack(alignment: .leading, spacing: 8) {
                header(endpoint)
                content(endpoint)
            }
            .padding(.top, 16)
            .task(id: "\(context)|\(namespace)|\(workload)|\(model.range.rawValue)|\(model.perContainer)") {
                await model.load(
                    context: context, endpoint: endpoint, namespace: namespace, workload: workload,
                    querying: querying)
            }
            .accessibilityIdentifier("detail.metrics")
        }
    }

    private func header(_ endpoint: PromEndpoint) -> some View {
        HStack(spacing: 8) {
            Text("METRICS")
                .typeStyle(DesignTokens.Typography.caption.weighted(.semibold), color: DesignTokens.textTertiary)
            if model.isLoading {
                ProgressView().controlSize(.mini).accessibilityLabel("Loading metrics")
            }
            Spacer()
            Picker("Metrics range", selection: $model.range) {
                ForEach(MetricsRange.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            Picker("Per container or total", selection: $model.perContainer) {
                Text("per container").tag(true)
                Text("total").tag(false)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            if endpoint.grafanaURL != nil, model.result != nil {
                Button {
                    openGrafana(endpoint, Chart.allCases)
                } label: {
                    Label("Grafana", systemImage: "arrow.up.forward.square")
                }
                .buttonStyle(.borderless)
                .help("Open these charts in Grafana Explore")
            }
        }
    }

    @ViewBuilder
    private func content(_ endpoint: PromEndpoint) -> some View {
        if let error = model.error {
            Text(error)
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.statusErr)
                .textSelection(.enabled)
        } else if let result = model.result {
            let grafana = endpoint.grafanaURL == nil ? nil : { (charts: [Chart]) in openGrafana(endpoint, charts) }
            MetricChartView(
                title: "CPU", unit: .cores, summary: usageSummary(.cpu, .cpuRequest, .cpuLimit, .cores),
                lines: usageLines(.cpu, .cpuRequest, .cpuLimit), result: result, range: model.resultRange,
                error: model.chartError(.cpu), emptyText: Self.emptyCadvisor,
                onGrafana: grafana.map { open in { open([.cpu, .cpuRequest, .cpuLimit]) } })
            MetricChartView(
                title: "Memory", unit: .bytes,
                summary: usageSummary(.memory, .memoryRequest, .memoryLimit, .bytes),
                lines: usageLines(.memory, .memoryRequest, .memoryLimit), result: result,
                range: model.resultRange, error: model.chartError(.memory), emptyText: Self.emptyCadvisor,
                onGrafana: grafana.map { open in { open([.memory, .memoryRequest, .memoryLimit]) } })
            MetricChartView(
                title: "Restarts", unit: .count, summary: restartsSummary, lines: lines(.restarts),
                result: result, range: model.resultRange, error: model.chartError(.restarts, .restartsTotal),
                emptyText: Self.emptyKSM,
                onGrafana: grafana.map { open in { open([.restarts, .restartsTotal]) } })
            MetricChartView(
                title: "Network", unit: .bytesPerSecond, summary: networkSummary, lines: networkLines,
                result: result, range: model.resultRange, error: model.chartError(.networkRx, .networkTx),
                emptyText: Self.emptyCadvisor,
                onGrafana: grafana.map { open in { open([.networkRx, .networkTx]) } })
        } else {
            Text("loading metrics…")
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textDisabled)
        }
    }

    private static let emptyCadvisor = "no data — needs cAdvisor metrics in Prometheus"
    private static let emptyKSM = "no data — needs kube-state-metrics in Prometheus"

    private func lines(_ chart: Chart) -> [ChartLine] {
        model.series(chart).enumerated().map { index, series in
            ChartLine(label: series.label, color: Self.palette[index % Self.palette.count], points: series.points)
        }
    }

    /// Usage lines plus dashed request and limit totals.
    private func usageLines(_ usage: Chart, _ request: Chart, _ limit: Chart) -> [ChartLine] {
        var out = lines(usage)
        for (chart, label) in [(request, "request"), (limit, "limit")] {
            let reference = model.series(chart)
            if !reference.isEmpty {
                out.append(
                    ChartLine(
                        label: label, color: DesignTokens.textTertiary,
                        points: MetricsMath.sum(reference.map(\.points)), dashed: true))
            }
        }
        return out
    }

    private func usageSummary(_ usage: Chart, _ request: Chart, _ limit: Chart, _ unit: MetricsMath.Unit)
        -> String
    {
        var parts = [MetricsMath.latestTotal(model.series(usage)).map { MetricsMath.format($0, unit) } ?? "—"]
        if let req = MetricsMath.latestTotal(model.series(request)) {
            parts.append("req \(MetricsMath.format(req, unit))")
        }
        if let lim = MetricsMath.latestTotal(model.series(limit)) {
            parts.append("lim \(MetricsMath.format(lim, unit))")
        }
        return parts.joined(separator: " / ")
    }

    private var restartsSummary: String {
        guard let total = model.series(.restartsTotal).first.flatMap({ MetricsMath.latest($0.points) }) else {
            return "—"
        }
        return "\(Int(total.rounded())) in range"
    }

    private var networkLines: [ChartLine] {
        model.series(.networkRx).map { ChartLine(label: "rx", color: Self.palette[0], points: $0.points) }
            + model.series(.networkTx).map { ChartLine(label: "tx", color: Self.palette[1], points: $0.points) }
    }

    private var networkSummary: String {
        func latest(_ chart: Chart) -> String {
            model.series(chart).first.flatMap { MetricsMath.latest($0.points) }
                .map { MetricsMath.format($0, .bytesPerSecond) } ?? "—"
        }
        return "↓ \(latest(.networkRx)) ↑ \(latest(.networkTx))"
    }

    private func openGrafana(_ endpoint: PromEndpoint, _ charts: [Chart]) {
        guard let base = endpoint.grafanaURL else { return }
        let text = Prometheus.grafanaExploreURL(
            grafanaBase: base, datasource: endpoint.grafanaDatasource,
            queries: charts.compactMap { model.result?.data($0)?.query },
            from: model.resultRange.grafanaFrom, to: "now")
        guard let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased()) else {
            return
        }
        NSWorkspace.shared.open(url)
    }
}

/// One Metrics chart: lines over the range, dashed reference lines, the
/// hovered time's values.
private struct MetricChartView: View {
    let title: String
    let unit: MetricsMath.Unit
    let summary: String
    let lines: [ChartLine]
    let result: MetricsResult
    let range: MetricsRange
    let error: String?
    let emptyText: String
    let onGrafana: (() -> Void)?

    @State private var hovered: Double?

    private var hasData: Bool { lines.contains { $0.points.contains { $0.value != nil } } }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(title.uppercased())
                    .typeStyle(DesignTokens.Typography.micro.weighted(.semibold), color: DesignTokens.textTertiary)
                if let onGrafana {
                    Button(action: onGrafana) {
                        Image(systemName: "arrow.up.forward.square").iconSize(DesignTokens.iconXs)
                    }
                    .buttonStyle(.borderless)
                    .help("Open \(title) in Grafana")
                    .accessibilityLabel("Open \(title) in Grafana")
                }
                Spacer()
                Text(summary)
                    .typeStyle(DesignTokens.Typography.dataSm, color: DesignTokens.textSecondary)
                    .lineLimit(1)
            }
            if let error {
                Text(error).typeStyle(DesignTokens.Typography.caption, color: DesignTokens.statusErr)
            } else if !hasData {
                Text(emptyText).typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textDisabled)
            } else {
                chart
                legend
            }
        }
        .padding(10)
        .background(DesignTokens.surfaceSurface, in: RoundedRectangle(cornerRadius: DesignTokens.radiusMd))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.radiusMd).stroke(DesignTokens.borderFaint, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(title): \(summary)")
    }

    private var chart: some View {
        Charts.Chart {
            ForEach(lines) { line in
                ForEach(line.points.indices, id: \.self) { index in
                    if let value = line.points[index].value {
                        LineMark(
                            x: .value("Time", Date(timeIntervalSince1970: line.points[index].time)),
                            y: .value(title, value),
                            series: .value("Line", line.id))
                            .foregroundStyle(line.color)
                            .lineStyle(StrokeStyle(lineWidth: 1.25, dash: line.dashed ? [3, 3] : []))
                    }
                }
            }
            if let hovered {
                RuleMark(x: .value("Time", Date(timeIntervalSince1970: hovered)))
                    .foregroundStyle(DesignTokens.borderStrong)
            }
        }
        .chartXScale(
            domain: Date(timeIntervalSince1970: Double(result.start))...Date(
                timeIntervalSince1970: Double(result.end)))
        .chartYAxis {
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                AxisGridLine().foregroundStyle(DesignTokens.borderFaint)
                AxisValueLabel {
                    if let v = value.as(Double.self) {
                        Text(MetricsMath.format(v, unit))
                            .typeStyle(DesignTokens.Typography.micro.monospaced, color: DesignTokens.textTertiary)
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisValueLabel(format: range == .week ? .dateTime.weekday().hour() : .dateTime.hour().minute())
                    .foregroundStyle(DesignTokens.textTertiary)
            }
        }
        .chartLegend(.hidden)
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let location):
                            guard let frame = proxy.plotFrame else { return }
                            let x = location.x - geometry[frame].origin.x
                            hovered = (proxy.value(atX: x, as: Date.self))?.timeIntervalSince1970
                        case .ended:
                            hovered = nil
                        }
                    }
            }
        }
        .frame(height: 70)
    }

    @ViewBuilder
    private var legend: some View {
        HStack(spacing: 10) {
            if let hovered {
                Text(Date(timeIntervalSince1970: hovered), format: .dateTime.hour().minute())
                    .typeStyle(DesignTokens.Typography.micro.monospaced, color: DesignTokens.textTertiary)
            }
            ForEach(lines) { line in
                HStack(spacing: 4) {
                    Rectangle().fill(line.color).frame(width: 10, height: 2).accessibilityHidden(true)
                    Text(legendText(line))
                        .typeStyle(DesignTokens.Typography.micro.monospaced, color: DesignTokens.textTertiary)
                }
            }
        }
    }

    private func legendText(_ line: ChartLine) -> String {
        let name = line.label.isEmpty ? title : line.label
        guard let hovered else { return name }
        let nearest = line.points.min { abs($0.time - hovered) < abs($1.time - hovered) }
        return "\(name) \(nearest?.value.map { MetricsMath.format($0, unit) } ?? "—")"
    }
}
