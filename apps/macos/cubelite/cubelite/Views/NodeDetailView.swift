import SwiftUI

/// Node detail (#530): the inventory facts and the node's Metrics section.
/// `node` is nil when the node is opened by name (an alert) before the
/// inventory has it.
struct NodeDetailView: View {
    let name: String
    let node: NodeInfo?
    let context: String?
    var onClose: (() -> Void)?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    Image(systemName: "server.rack")
                        .iconSize(DesignTokens.iconLg, weight: .semibold)
                        .foregroundStyle(DesignTokens.accentAltTeal)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name)
                            .typeStyle(DesignTokens.Typography.data, color: DesignTokens.textDataBright)
                            .textSelection(.enabled)
                        if let node {
                            Text(node.status)
                                .typeStyle(
                                    DesignTokens.Typography.caption,
                                    color: node.status == "Ready" ? DesignTokens.statusOk : DesignTokens.statusErr)
                        }
                    }
                    Spacer()
                    if let onClose {
                        Button(action: onClose) {
                            Image(systemName: "xmark").iconSize(DesignTokens.iconSm, weight: .semibold)
                                .foregroundStyle(DesignTokens.textTertiary)
                        }
                        .buttonStyle(.plain)
                        .help("Close details")
                        .accessibilityLabel("Close details")
                    }
                }
                Divider()
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                    fact("Roles", node.map { $0.roles.isEmpty ? "—" : $0.roles.joined(separator: ", ") } ?? "—")
                    fact("Version", node?.version ?? "—")
                    fact("Age", node?.creationTimestamp.k8sAge ?? "—")
                }
                NodeMetricsSectionView(context: context, node: name)
            }
            .padding(20)
        }
        .background(DesignTokens.surfacePanel)
        .accessibilityIdentifier("detail.node")
    }

    private func fact(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).typeStyle(DesignTokens.Typography.colhead, color: DesignTokens.textTertiary)
            Text(value)
                .typeStyle(
                    DesignTokens.Typography.dataSm,
                    color: value == "—" ? DesignTokens.textDisabled : DesignTokens.textSecondary)
        }
    }
}

/// A node's Metrics section (#530): CPU, memory, pods, network and
/// filesystem from node-exporter where it scrapes the node, else cAdvisor;
/// each chart says when no exporter has it.
struct NodeMetricsSectionView: View {
    @Environment(PrometheusStore.self) private var store: PrometheusStore?
    @Environment(AppSettings.self) private var settings: AppSettings?
    let context: String?
    let node: String

    @State private var model = NodeMetricsModel()
    @State private var grafanaError: String?

    private struct LoadKey: Hashable {
        let context: String
        let node: String
        let endpoint: PromEndpoint
        let range: MetricsRange
    }

    var body: some View {
        if let context, let store, let endpoint = store.endpoint(for: context),
            let querying = store.querying as? any PrometheusClusterQuerying
        {
            VStack(alignment: .leading, spacing: 8) {
                header(endpoint)
                if let grafanaError {
                    Text("Grafana: \(grafanaError)")
                        .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.statusErr)
                }
                content(endpoint)
            }
            .padding(.top, 16)
            .task(id: LoadKey(context: context, node: node, endpoint: endpoint, range: model.range)) {
                grafanaError = nil
                await model.load(context: context, endpoint: endpoint, node: node, querying: querying)
            }
            .accessibilityIdentifier("detail.node-metrics")
        } else if IntegrationHints.showsSetup(
            available: context != nil && store?.querying != nil,
            configured: store?.endpoint(for: context) != nil, hints: settings?.integrationHints ?? false)
        {
            MetricsSetupHint(
                context: context, caption: HostPanel.nodeHint, identifier: "detail.node-metrics-hint")
        }
    }

    private func grafana(_ endpoint: PromEndpoint) -> (([String]) -> Void)? {
        guard store?.canOpenGrafana(endpoint) == true else { return nil }
        return { queries in
            grafanaError = nil
            GrafanaLink.open(
                store: store, context: context, endpoint: endpoint, queries: queries, range: model.resultRange
            ) { grafanaError = $0 }
        }
    }

    private func header(_ endpoint: PromEndpoint) -> some View {
        HStack(spacing: 8) {
            Text("METRICS")
                .typeStyle(DesignTokens.Typography.caption.weighted(.semibold), color: DesignTokens.textTertiary)
            if model.isLoading {
                ProgressView().controlSize(.mini).accessibilityLabel("Loading metrics")
            }
            Spacer()
            MetricsRangePicker(label: "Metrics range", selection: $model.range)
            if let open = grafana(endpoint), let result = model.result {
                Button {
                    open(HostPanel.node.flatMap { $0.queries(result) })
                } label: {
                    Label("Grafana", systemImage: "arrow.up.forward.square")
                }
                .buttonStyle(.borderless)
                .help("Open these charts in Grafana Explore")
            }
        }
    }

    @ViewBuilder
    private func content(_ endpoint: PromEndpoint) -> some View {
        if let error = model.error {
            Text(error)
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.statusErr)
                .textSelection(.enabled)
        } else if let result = model.result {
            HostChartsView(
                result: result, range: model.resultRange, panels: HostPanel.node, onGrafana: grafana(endpoint))
        } else {
            Text("loading metrics…")
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textDisabled)
        }
    }
}
