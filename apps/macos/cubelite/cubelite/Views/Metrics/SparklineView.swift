import Charts
import SwiftUI

/// Last hour of one value next to a list cell (#512); nothing without data.
struct SparklineView: View {
    let points: [MetricPoint]?
    let label: String

    var body: some View {
        if let points, points.count > 1 {
            Charts.Chart(points.indices, id: \.self) { index in
                if let value = points[index].value {
                    LineMark(x: .value("Time", points[index].time), y: .value(label, value))
                        .foregroundStyle(DesignTokens.accentDefault)
                        .lineStyle(StrokeStyle(lineWidth: 1))
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartLegend(.hidden)
            .frame(width: 48, height: 14)
            .accessibilityLabel(label)
            .accessibilityValue(MetricsMath.latest(points).map { String(format: "%.3g", $0) } ?? "no data")
        }
    }
}
