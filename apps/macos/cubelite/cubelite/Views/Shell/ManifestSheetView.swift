import SwiftUI

/// Shared read-only manifest sheet: pretty-printed JSON on the sunken
/// surface, text-selectable, with a copy action.
struct ManifestSheetView: View {

    let title: String
    let text: String
    let onClose: () -> Void

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Button(copied ? "Copied" : "Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                    copied = true
                }
                .controlSize(.small)
                Button("Done", action: onClose)
                    .keyboardShortcut(.defaultAction)
                    .controlSize(.small)
            }
            .padding(12)
            Divider()
            ScrollView([.vertical, .horizontal]) {
                Text(text)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(DesignTokens.textLog)
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(DesignTokens.surfaceSunken)
        }
        .frame(minWidth: 560, minHeight: 420)
    }
}
