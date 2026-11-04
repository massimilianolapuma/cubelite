import AppKit
import SwiftUI

/// Opens a web UI link in the browser; `failure` gets the reason it could
/// not be built (forward refused, no ready pod).
@MainActor
enum WebUI {
    static func open(
        _ url: @escaping @MainActor () async throws -> URL?, failure: @escaping @MainActor (String) -> Void
    ) {
        Task { @MainActor in
            do {
                if let url = try await url() { NSWorkspace.shared.open(url) }
            } catch is CancellationError {
            } catch {
                failure(error.localizedDescription)
            }
        }
    }
}

/// Small link that opens Settings on an integration (#526).
struct IntegrationSetupButton: View {
    let title: String
    let pane: AppSettings.IntegrationPane
    /// The panel's context, which the Integrations tab then edits.
    let context: String?

    @Environment(AppSettings.self) private var settings: AppSettings?
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Button(title) {
            settings?.showIntegrationSettings(pane, context: context)
            openSettings()
        }
        .buttonStyle(.link)
        .typeStyle(DesignTokens.Typography.caption)
        .help("Open Settings → Integrations → \(pane.rawValue)")
        .accessibilityIdentifier("integration-setup-\(pane)")
    }
}

/// Stand-in for the Metrics section when the context has no Prometheus
/// (#526): what it would show, a link to set it up, and Hide. The title and
/// caption change for the Overview and node placeholders (#530).
struct MetricsSetupHint: View {
    let context: String?
    var title = "Metrics"
    var caption = IntegrationHints.metricsCaption
    var identifier = "detail.metrics-hint"

    @Environment(AppSettings.self) private var settings: AppSettings?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(title)
                    .textCase(.uppercase)
                    .typeStyle(DesignTokens.Typography.caption.weighted(.semibold), color: DesignTokens.textTertiary)
                Spacer()
                Button("Hide") { settings?.integrationHints = false }
                    .buttonStyle(.borderless)
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
                    .help("Hide integration hints (Settings → Integrations shows them again)")
                    .accessibilityIdentifier("\(identifier)-hide")
            }
            Text(caption)
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
            IntegrationSetupButton(title: "Set up Prometheus", pane: .prometheus, context: context)
        }
        .padding(.top, 16)
        .accessibilityIdentifier(identifier)
    }
}

/// "Logs in Kibana" and "Metrics in Grafana" for a pod or deployment detail
/// (#526); nothing when neither UI can be opened.
struct IntegrationLinksRow: View {
    let context: String?
    let namespace: String
    let workload: Workload

    @Environment(LogSessionStore.self) private var logs: LogSessionStore?
    @Environment(PrometheusStore.self) private var prometheus: PrometheusStore?
    @State private var error: String?

    var body: some View {
        let links = IntegrationLinks(context: context, elastic: logs?.elastic, prometheus: prometheus)
        if links.canOpenKibana || links.canOpenGrafana {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 12) {
                    if links.canOpenKibana {
                        link("Logs in Kibana", name: "Kibana", help: "Open these logs in Kibana Discover") {
                            try await links.kibanaURL(namespace: namespace, workload: workload)
                        }
                        .accessibilityIdentifier("detail.kibana")
                    }
                    if links.canOpenGrafana {
                        link("Metrics in Grafana", name: "Grafana", help: "Open the CPU in Grafana Explore") {
                            try await links.grafanaURL(namespace: namespace, workload: workload)
                        }
                        .accessibilityIdentifier("detail.grafana")
                    }
                }
                if let error {
                    Text(error)
                        .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.statusErr)
                        .textSelection(.enabled)
                }
            }
            .padding(.top, 4)
            .onChange(of: workload) { _, _ in error = nil }
        }
    }

    private func link(
        _ title: String, name: String, help: String, url: @escaping @MainActor () async throws -> URL?
    ) -> some View {
        Button {
            error = nil
            WebUI.open(url) { error = "\(name): \($0)" }
        } label: {
            Label(title, systemImage: "arrow.up.forward.square")
        }
        .buttonStyle(.borderless)
        .typeStyle(DesignTokens.Typography.caption)
        .help(help)
    }
}
