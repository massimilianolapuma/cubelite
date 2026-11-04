import SwiftUI

/// Cluster CPU and memory history next to the metrics-server meters (#530),
/// only with a Prometheus endpoint. The Overview loads `model`.
struct ClusterHistoryView: View {
    @Environment(PrometheusStore.self) private var store: PrometheusStore?
    let context: String?
    @Bindable var model: OverviewPromModel
    @State private var grafanaError: String?

    var body: some View {
        if let endpoint = store?.endpoint(for: context) {
            VStack(alignment: .leading, spacing: 8) {
                Divider()
                HStack(spacing: 8) {
                    Text("HISTORY")
                        .typeStyle(
                            DesignTokens.Typography.caption.weighted(.semibold), color: DesignTokens.textTertiary)
                    if model.isLoadingUsage {
                        ProgressView().controlSize(.mini).accessibilityLabel("Loading cluster history")
                    }
                    Spacer()
                    MetricsRangePicker(label: "History range", selection: $model.range)
                }
                if let grafanaError {
                    Text("Grafana: \(grafanaError)")
                        .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.statusErr)
                }
                if let error = model.usageError {
                    Text(error)
                        .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.statusErr)
                        .textSelection(.enabled)
                } else if let usage = model.usage {
                    HostChartsView(
                        result: usage, range: model.usageRange, panels: HostPanel.cluster,
                        onGrafana: store?.canOpenGrafana(endpoint) == true
                            ? { queries in
                                GrafanaLink.open(
                                    store: store, context: context, endpoint: endpoint, queries: queries,
                                    range: model.usageRange
                                ) { grafanaError = $0 }
                            } : nil)
                } else {
                    Text("loading history…")
                        .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textDisabled)
                }
            }
            .accessibilityIdentifier("overview.cluster-history")
        }
    }
}

/// Firing alerts from Prometheus in the Overview (#530): severity, name,
/// what it is about (a link to the pod or node when it resolves), summary,
/// firing since, and Open in Grafana on the alert's expression. Without
/// Prometheus, the setup hint (#526).
struct AlertsCardView: View {
    @Environment(PrometheusStore.self) private var store: PrometheusStore?
    @Environment(AppSettings.self) private var settings: AppSettings?
    @Environment(ClusterState.self) private var clusterState
    let context: String?
    let model: OverviewPromModel
    let onOpen: (PromAlerts.Target) -> Void
    @State private var grafanaError: String?

    static let shown = 8

    var body: some View {
        if let endpoint = store?.endpoint(for: context) {
            card(endpoint)
        } else if IntegrationHints.showsSetup(
            available: context != nil && store?.querying != nil, configured: false,
            hints: settings?.integrationHints ?? false)
        {
            MetricsSetupHint(
                context: context, title: "Alerts", caption: HostPanel.clusterHint,
                identifier: "overview.prometheus-hint"
            )
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .dashboardSurface()
        }
    }

    private func card(_ endpoint: PromEndpoint) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Alerts")
                    .typeStyle(DesignTokens.Typography.colhead, color: DesignTokens.textTertiary)
                if let alerts = model.alerts {
                    Text("\(alerts.count)")
                        .typeStyle(DesignTokens.Typography.micro.monospaced, color: DesignTokens.textSecondary)
                        .padding(.horizontal, 6)
                        .overlay(Capsule().strokeBorder(DesignTokens.borderDefault, lineWidth: 1))
                        .accessibilityLabel("\(alerts.count) firing alerts")
                        .accessibilityIdentifier("overview.alerts-count")
                }
            }
            if let grafanaError {
                Text("Grafana: \(grafanaError)")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.statusErr)
            }
            if let error = model.alertsError {
                Text(error)
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.statusErr)
                    .textSelection(.enabled)
            } else if let alerts = model.alerts {
                if alerts.isEmpty {
                    Text("No firing alerts.")
                        .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textDisabled)
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(alerts.prefix(Self.shown)) { alert in
                            row(alert, endpoint: endpoint)
                        }
                        if alerts.count > Self.shown {
                            Text("and \(alerts.count - Self.shown) more")
                                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textDisabled)
                        }
                    }
                }
            } else {
                Text("loading alerts…")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textDisabled)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .dashboardSurface()
        .accessibilityIdentifier("overview.alerts")
    }

    static func color(_ tone: PromAlerts.Tone) -> Color {
        switch tone {
        case .err: DesignTokens.statusErr
        case .warn: DesignTokens.statusWarn
        case .neutral: DesignTokens.textTertiary
        }
    }

    private func row(_ alert: PromAlert, endpoint: PromEndpoint) -> some View {
        let tone = Self.color(PromAlerts.tone(alert.severity))
        let subject = PromAlerts.subject(alert)
        let target = PromAlerts.target(alert, pods: clusterState.pods)
        return VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 8) {
                Circle().fill(tone).frame(width: 6, height: 6).accessibilityHidden(true)
                Text(alert.name)
                    .typeStyle(DesignTokens.Typography.dataSm, color: DesignTokens.textDataBright)
                    .lineLimit(1)
                Text(alert.severity ?? "—").typeStyle(DesignTokens.Typography.caption, color: tone)
                if let subject, let target {
                    Button(subject) { onOpen(target) }
                        .buttonStyle(.link)
                        .typeStyle(DesignTokens.Typography.dataSm)
                        .lineLimit(1)
                        .help("Open \(subject)")
                } else if let subject {
                    Text(subject)
                        .typeStyle(DesignTokens.Typography.dataSm, color: DesignTokens.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
                Text(PromAlerts.firingSince(alert.activeAt))
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
                if store?.canOpenGrafana(endpoint) == true {
                    Button {
                        grafanaError = nil
                        GrafanaLink.open(
                            store: store, context: context, endpoint: endpoint, queries: [alert.expr], range: .hour
                        ) { grafanaError = $0 }
                    } label: {
                        Image(systemName: "arrow.up.forward.square").iconSize(DesignTokens.iconXs)
                    }
                    .buttonStyle(.borderless)
                    .help("Open in Grafana")
                    .accessibilityLabel("Open \(alert.name) in Grafana")
                }
            }
            if let summary = alert.summary {
                Text(summary)
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
                    .lineLimit(1)
                    .padding(.leading, 14)
                    .help(summary)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .accessibilityElement(children: .contain)
    }
}
