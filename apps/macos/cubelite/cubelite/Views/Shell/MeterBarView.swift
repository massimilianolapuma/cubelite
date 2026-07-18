import SwiftUI

/// Horizontal usage meter: label + percentage + a 6pt capsule fill bar.
///
/// A nil `fraction` renders an em dash and an empty track ("unavailable").
/// Fill color escalates statusOk → statusWarn (≥ 70%) → statusErr (≥ 90%).
struct MeterBarView: View {

    let label: String
    /// Usage fraction in 0...1; nil means the value is unavailable.
    let fraction: Double?
    /// Optional secondary line, e.g. "3.2 / 8 cores".
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(DesignTokens.textSecondary)
                Spacer()
                Text(percentText)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(DesignTokens.textPrimary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(DesignTokens.surfaceSunken)
                    if let fraction {
                        Capsule()
                            .fill(fillColor)
                            .frame(width: max(0, geo.size.width * min(max(fraction, 0), 1)))
                    }
                }
            }
            .frame(height: 6)
            if let detail {
                Text(detail)
                    .font(.system(size: 10))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label) \(percentText)")
    }

    private var percentText: String {
        guard let fraction else { return "—" }
        return "\(Int((fraction * 100).rounded()))%"
    }

    private var fillColor: Color {
        guard let fraction else { return DesignTokens.textTertiary }
        if fraction >= 0.9 { return DesignTokens.statusErr }
        if fraction >= 0.7 { return DesignTokens.statusWarn }
        return DesignTokens.statusOk
    }
}

// MARK: - Preview

#Preview("Meters") {
    VStack(spacing: 16) {
        MeterBarView(label: "CPU", fraction: 0.42, detail: "3.4 / 8 cores")
        MeterBarView(label: "MEM", fraction: 0.78, detail: "25.0 / 32 GiB")
        MeterBarView(label: "CPU", fraction: 0.95)
        MeterBarView(label: "MEM", fraction: nil)
    }
    .padding(20)
    .frame(width: 260)
}
