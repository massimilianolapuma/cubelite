import AppKit
import SwiftUI

/// Expanded form of a line in ECS mode (#493, desktop `EcsFieldTable`): a
/// Kibana-like table of flattened ECS fields sorted by name, values coloured
/// by type, fields added by the conversion marked, Copy ECS / Copy raw on top.
struct ECSFieldTableView: View {
    let document: ECSDocument
    /// The line exactly as received, for Copy raw.
    let raw: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 10) {
                copyButton("Copy ECS", text: document.prettyJSON, id: "logpanel.ecs-copy")
                copyButton("Copy raw", text: raw, id: "logpanel.ecs-copy-raw")
            }
            .padding(.bottom, 2)
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 16, verticalSpacing: 1) {
                ForEach(document.table, id: \.key) { field in
                    GridRow {
                        mono(field.key, DesignTokens.textSecondary)
                            .gridColumnAlignment(.leading)
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            mono(Self.text(field.value), Self.color(field.value))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            if field.added {
                                mono("added", DesignTokens.textTertiary)
                                    .help("Added by CubeLite, not in the log line")
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                    .accessibilityIdentifier("logpanel.ecs-field.\(field.key)")
                }
            }
        }
        .accessibilityIdentifier("logpanel.ecs-table")
    }

    private func copyButton(_ title: String, text: String, id: String) -> some View {
        Button(title) {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
        .buttonStyle(.plain)
        .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textSecondary)
        .accessibilityIdentifier(id)
    }

    private func mono(_ text: String, _ color: Color) -> some View {
        Text(verbatim: text)
            .typeStyle(DesignTokens.Typography.micro.monospaced, color: color)
    }

    /// Strings as logged (newlines kept), everything else as compact JSON.
    private static func text(_ value: JSONValue) -> String {
        if case .string(let s) = value { return s }
        return value.compactText
    }

    /// JSON tree palette: strings teal, numbers amber, booleans and null
    /// violet, containers secondary.
    private static func color(_ value: JSONValue) -> Color {
        switch value {
        case .string: DesignTokens.clusterTeal
        case .number: DesignTokens.clusterAmber
        case .bool, .null: DesignTokens.clusterViolet
        case .array, .object: DesignTokens.textSecondary
        }
    }
}
