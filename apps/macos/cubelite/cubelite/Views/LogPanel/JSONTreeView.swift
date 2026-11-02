import AppKit
import SwiftUI

/// Expanded form of a JSON log line (#477, desktop `JsonTree`): one row per
/// key, nested containers open down to depth 2 and collapsed beyond, scalar
/// colours by type, with Copy JSON / Copy raw on top.
struct JSONTreeView: View {
    let value: JSONValue
    /// The line exactly as received, for Copy raw.
    let raw: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 10) {
                copyButton("Copy JSON", text: value.prettyText, id: "logpanel.json-copy")
                copyButton("Copy raw", text: raw, id: "logpanel.json-copy-raw")
            }
            .padding(.bottom, 2)
            JSONNodeView(value: value, depth: 0)
        }
        .accessibilityIdentifier("logpanel.json-tree")
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
}

/// The children of one JSON container; recursive for nested containers.
private struct JSONNodeView: View {
    let value: JSONValue
    let depth: Int

    /// Keys whose open state differs from the depth default.
    @State private var flipped: Set<String> = []

    private struct Entry {
        let key: String
        let value: JSONValue
    }

    private var isArray: Bool {
        if case .array = value { return true }
        return false
    }

    private var entries: [Entry] {
        switch value {
        case .object(let members): members.map { Entry(key: $0.key, value: $0.value) }
        case .array(let items): items.enumerated().map { Entry(key: "\($0.offset)", value: $0.element) }
        default: []
        }
    }

    /// Children of the root start open; deeper containers start collapsed.
    private var defaultOpen: Bool { depth + 1 < 2 }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(entries, id: \.key) { entry in
                row(entry)
            }
        }
        .padding(.leading, depth > 0 ? 12 : 0)
    }

    @ViewBuilder
    private func row(_ entry: Entry) -> some View {
        if let count = Self.childCount(entry.value) {
            let open = defaultOpen != flipped.contains(entry.key)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    if count > 0 {
                        Button {
                            if flipped.remove(entry.key) == nil { flipped.insert(entry.key) }
                        } label: {
                            Image(systemName: "chevron.right")
                                .iconSize(DesignTokens.iconXs, weight: .semibold)
                                .rotationEffect(.degrees(open ? 90 : 0))
                                .foregroundStyle(DesignTokens.textTertiary)
                                .frame(width: 10)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Toggle \(entry.key)")
                        .accessibilityValue(open ? "Expanded" : "Collapsed")
                    }
                    label(entry.key)
                    if count == 0 {
                        mono(Self.isArrayValue(entry.value) ? "[]" : "{}", DesignTokens.textTertiary)
                    } else if !open {
                        mono(Self.placeholder(entry.value, count: count), DesignTokens.textTertiary)
                    }
                }
                if open, count > 0 {
                    JSONNodeView(value: entry.value, depth: depth + 1)
                }
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                label(entry.key)
                mono(entry.value.compactText, Self.scalarColor(entry.value))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func label(_ key: String) -> some View {
        if isArray {
            mono("[\(key)]", DesignTokens.textTertiary)
        } else {
            HStack(spacing: 0) {
                mono(key, DesignTokens.textSecondary)
                mono(":", DesignTokens.textTertiary)
            }
        }
    }

    private func mono(_ text: String, _ color: Color) -> some View {
        Text(verbatim: text)
            .typeStyle(DesignTokens.Typography.micro.monospaced, color: color)
    }

    /// Child count for containers, nil for scalars.
    private static func childCount(_ value: JSONValue) -> Int? {
        switch value {
        case .object(let members): members.count
        case .array(let items): items.count
        default: nil
        }
    }

    private static func isArrayValue(_ value: JSONValue) -> Bool {
        if case .array = value { return true }
        return false
    }

    private static func placeholder(_ value: JSONValue, count: Int) -> String {
        isArrayValue(value) ? "[\(count) items]" : "{\(count) keys}"
    }

    /// Desktop palette: strings teal, numbers amber, booleans and null violet.
    private static func scalarColor(_ value: JSONValue) -> Color {
        switch value {
        case .string: DesignTokens.clusterTeal
        case .number: DesignTokens.clusterAmber
        default: DesignTokens.clusterViolet
        }
    }
}
