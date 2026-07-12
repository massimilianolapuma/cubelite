import SwiftUI

/// Shared manifest sheet: pretty-printed JSON on the sunken surface,
/// text-selectable, with copy — and, when `onApply` is provided, an edit
/// mode that PUTs the modified manifest back (kubectl replace semantics).
struct ManifestSheetView: View {

    let title: String
    let text: String
    let onClose: () -> Void
    /// Enables Edit/Apply; throws surface inline (e.g. resourceVersion
    /// conflicts, validation errors).
    var onApply: ((String) async throws -> Void)?

    @State private var copied = false
    @State private var editing = false
    @State private var draft = ""
    @State private var applying = false
    @State private var applyError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                if editing {
                    Button("Cancel") {
                        editing = false
                        applyError = nil
                    }
                    .controlSize(.small)
                    Button(applying ? "Applying…" : "Apply") {
                        apply()
                    }
                    .controlSize(.small)
                    .disabled(applying)
                } else {
                    if onApply != nil {
                        Button("Edit") {
                            draft = text
                            editing = true
                        }
                        .controlSize(.small)
                    }
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
            }
            .padding(12)
            if let applyError {
                Text(applyError)
                    .font(.system(size: 11))
                    .foregroundStyle(DesignTokens.statusErr)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                    .textSelection(.enabled)
            }
            Divider()
            if editing {
                TextEditor(text: $draft)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(DesignTokens.textLog)
                    .scrollContentBackground(.hidden)
                    .background(DesignTokens.surfaceSunken)
            } else {
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
        }
        .frame(minWidth: 560, minHeight: 420)
    }

    private func apply() {
        guard let onApply else { return }
        // Validate JSON locally before shipping it to the API server.
        guard let data = draft.data(using: .utf8),
            (try? JSONSerialization.jsonObject(with: data)) != nil
        else {
            applyError = "Draft is not valid JSON."
            return
        }
        applying = true
        applyError = nil
        Task {
            defer { applying = false }
            do {
                try await onApply(draft)
                editing = false
                onClose()
            } catch {
                applyError = error.localizedDescription
            }
        }
    }
}
