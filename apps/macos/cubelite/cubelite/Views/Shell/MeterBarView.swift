import SwiftUI

/// Horizontal usage meter: label + percentage + a 6pt capsule fill bar.
///
/// A nil `fraction` renders an em dash and an empty track ("unavailable").
/// Fill color (parity v2 §4, unified with the desktop `MeterBar`): accent
/// below 60%, statusWarn from 60%, statusErr from 75%.
struct MeterBarView: View {

    /// Fill level for a usage fraction.
    enum Level: Equatable {
        case unavailable, normal, warn, err
    }

    /// Threshold mapping, shared with the desktop: < 0.6 / ≥ 0.6 / ≥ 0.75.
    nonisolated static func level(for fraction: Double?) -> Level {
        guard let fraction else { return .unavailable }
        if fraction >= 0.75 { return .err }
        if fraction >= 0.6 { return .warn }
        return .normal
    }

    let label: String
    /// Usage fraction in 0...1; nil means the value is unavailable.
    let fraction: Double?
    /// Optional secondary line, e.g. "3.2 / 8 cores".
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                    .typeStyle(DesignTokens.Typography.colhead, color: DesignTokens.textTertiary)
                Spacer()
                Text(percentText)
                    .typeStyle(
                        DesignTokens.Typography.micro.monospaced, color: DesignTokens.textTertiary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(DesignTokens.borderFaint)
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
                    .typeStyle(DesignTokens.Typography.dataSm, color: DesignTokens.textTertiary)
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
        switch Self.level(for: fraction) {
        case .unavailable: DesignTokens.textTertiary
        case .normal: DesignTokens.accentDefault
        case .warn: DesignTokens.statusWarn
        case .err: DesignTokens.statusErr
        }
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
