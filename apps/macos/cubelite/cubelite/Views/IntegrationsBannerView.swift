import SwiftUI

/// One-line banner above the detail area offering the Elasticsearch and
/// Prometheus found when the context connected (#527): Enable · Review · ✕.
/// Same copy as the desktop's IntegrationsBanner.
struct IntegrationsBannerView: View {
    let context: String

    @Environment(IntegrationsSuggestionStore.self) private var store: IntegrationsSuggestionStore?
    @Environment(AppSettings.self) private var settings: AppSettings?
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        if let store, let line = store.message(for: context) {
            HStack(spacing: DesignTokens.spacing2) {
                Image(systemName: line.ok ? "sparkles" : "exclamationmark.circle")
                    .foregroundStyle(line.ok ? DesignTokens.accentDefault : DesignTokens.statusErr)
                    .accessibilityHidden(true)
                Text(line.text)
                    .typeStyle(DesignTokens.Typography.caption, color: line.ok ? DesignTokens.textSecondary : DesignTokens.statusErr)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(line.text)
                Spacer(minLength: DesignTokens.spacing2)
                actions(store)
            }
            .padding(.horizontal, DesignTokens.spacing3)
            .padding(.vertical, DesignTokens.spacing1)
            .frame(minHeight: DesignTokens.controlHeight)
            .background(DesignTokens.surfacePanel)
            .overlay(alignment: .bottom) { DesignTokens.borderFaint.frame(height: 1) }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("integrations-banner")
        }
    }

    @ViewBuilder
    private func actions(_ store: IntegrationsSuggestionStore) -> some View {
        let busy = store.enabling != nil
        if store.canAct(for: context) {
            if store.message(for: context)?.ok ?? true {
                Button(busy ? "Enabling…" : "Enable") { Task { await store.enable(context: context) } }
                    .buttonStyle(.link)
                    .typeStyle(DesignTokens.Typography.caption)
                    .disabled(busy)
                    .accessibilityIdentifier("integrations-banner.enable")
            }
            Button("Review") {
                settings?.showIntegrationSettings(store.review(context: context), context: context)
                openSettings()
            }
            .buttonStyle(.link)
            .typeStyle(DesignTokens.Typography.caption)
            .disabled(busy)
            .accessibilityIdentifier("integrations-banner.review")
        }
        Button {
            store.dismiss(context: context)
        } label: {
            Image(systemName: "xmark").typeStyle(DesignTokens.Typography.micro, color: DesignTokens.textTertiary)
        }
        .buttonStyle(.borderless)
        .disabled(busy)
        .help("Hide for this cluster (Settings → Integrations brings it back)")
        .accessibilityLabel("Dismiss")
        .accessibilityIdentifier("integrations-banner.dismiss")
    }
}
