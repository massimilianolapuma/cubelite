import SwiftUI

/// One-line banner above the detail area offering the Elasticsearch and
/// Prometheus found when the context connected (#527): Enable · Review · ✕.
/// Enable appears only when every offered integration has a single
/// operator-managed service. Same copy as the desktop's IntegrationsBanner.
struct IntegrationsBannerView: View {
    let context: String

    @Environment(IntegrationsSuggestionStore.self) private var store: IntegrationsSuggestionStore?
    @Environment(AppSettings.self) private var settings: AppSettings?
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        if let store, let line = store.message(for: context) {
            HStack(spacing: DesignTokens.spacing2) {
                Image(systemName: Self.icon(line.tone))
                    .foregroundStyle(Self.color(line.tone, icon: true))
                    .accessibilityHidden(true)
                Text(line.text)
                    .typeStyle(DesignTokens.Typography.caption, color: Self.color(line.tone, icon: false))
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

    private static func icon(_ tone: IntegrationsSuggestionStore.Status.Tone) -> String {
        switch tone {
        case .found: "sparkles"
        case .saved: "checkmark.circle"
        case .warning: "exclamationmark.triangle"
        case .failed: "exclamationmark.circle"
        }
    }

    private static func color(_ tone: IntegrationsSuggestionStore.Status.Tone, icon: Bool) -> Color {
        switch tone {
        case .found: icon ? DesignTokens.accentDefault : DesignTokens.textSecondary
        case .saved: icon ? DesignTokens.statusOk : DesignTokens.textSecondary
        case .warning: DesignTokens.statusWarn
        case .failed: DesignTokens.statusErr
        }
    }

    @ViewBuilder
    private func actions(_ store: IntegrationsSuggestionStore) -> some View {
        let busy = store.enabling != nil
        let enable = store.canEnable(for: context)
        if store.canAct(for: context) {
            if enable {
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
            .help(enable ? "Open Settings → Integrations, pre-filled" : IntegrationsSuggestionStore.reviewFirstHelp)
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
