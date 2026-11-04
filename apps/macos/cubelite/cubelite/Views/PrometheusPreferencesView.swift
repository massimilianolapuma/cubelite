import SwiftUI

/// Settings → Integrations → Prometheus (#512, spec §5.3), for a context or
/// the default shared by every context (#528).
struct PrometheusPreferencesForm: View {

    @Bindable var model: PrometheusPreferencesModel
    let contexts: [String]

    var body: some View {
        Form {
            EndpointScopeSection(
                scope: model.scope, view: model.view, context: model.context, contexts: contexts,
                busy: model.busy != nil, identifier: "preferences.prometheus",
                onScope: { kind in Task { await model.setScope(kind) } },
                onConfirm: { Task { await model.confirmScope() } },
                onCancel: { model.cancelScope() },
                onOverride: { Task { await model.override() } },
                onTurnOff: { Task { await model.turnOff() } },
                onUseDefault: { Task { await model.useDefault() } })
            switch model.view {
            case .inherited:
                Section("Metrics") {
                    ClusterLabelRows(
                        value: $model.cluster, found: model.foundClusters,
                        prompt: model.scope.store.defaultEndpoint?.cluster.map { "default: \($0)" }
                            ?? "cluster label value for this context")
                }
                actions(inherited: true)
            case .off:
                EmptyView()
            case .own, .sharedDefault:
                endpointSections
            }
        }
        .formStyle(.grouped)
        .padding()
        // Who a saved default reaches (#528).
        .task(id: contexts) { model.scope.contexts = contexts }
    }

    @ViewBuilder
    private var endpointSections: some View {
        TargetModeSection(
            target: model.target, label: "Prometheus:",
            footer: "Metrics history in pod and deployment details, list sparklines and Open in Grafana.",
            identifier: "preferences.prometheus",
            modes: model.view == .sharedDefault ? [.off, .external] : TargetFields.Mode.allCases)
        TargetLocationSection(
            target: model.target,
            detected: model.detected.map { prometheus in
                prometheus.map { found in
                    DetectedChoice(
                        id: found.id, label: "Prometheus \(found.namespace)/\(found.name):\(found.port)",
                        pick: { model.pick(found) })
                }
                    + model.detectedGrafana.map { found in
                        DetectedChoice(
                            id: found.id, label: "Grafana \(found.namespace)/\(found.name):\(found.port)",
                            pick: { model.pickGrafana(found) })
                    }
            },
            canDetect: model.busy == nil && model.context != nil,
            urlPrompt: "https://<workspace>.<region>.prometheus.monitor.azure.com",
            identifier: "preferences.prometheus",
            onDetect: { Task { await model.detect() } })
        if model.target.mode != .off {
            detailsSection
            authSection
        }
        actions(inherited: false)
    }

    private func actions(inherited: Bool) -> some View {
        FormActionsSection(
            target: model.target, busy: model.busy != nil,
            canAct: model.busy == nil && !model.isIncomplete && model.context != nil,
            outcome: model.outcome, identifier: "preferences.prometheus", inherited: inherited,
            onTest: { Task { await model.test() } }, onSave: { Task { await model.save() } })
    }

    private var detailsSection: some View {
        Section("Metrics") {
            ClusterLabelRows(
                value: $model.cluster, found: model.foundClusters,
                prompt: model.view == .sharedDefault
                    ? "fallback for contexts without their own" : "optional, for shared workspaces")
            TextField("Grafana URL:", text: $model.grafanaURL, prompt: Text("optional"))
                .accessibilityIdentifier("preferences.prometheus-grafana")
            TextField("Grafana datasource:", text: $model.grafanaDatasource, prompt: Text("UID, optional"))
            ProblemText(problem: model.grafanaProblem)
            if model.target.mode == .inCluster, let grafana = model.grafanaService {
                InClusterUIRow(
                    name: "Grafana", service: grafana, urlSet: !model.grafanaURL.trimmed.isEmpty,
                    identifier: "preferences.prometheus-grafana-clear", onClear: { model.grafanaService = nil })
            }
        }
    }

    @ViewBuilder
    private var authSection: some View {
        if model.target.mode == .inCluster {
            Section("Authentication") {
                Text("Reached through the API server with your cluster credentials.")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
            }
        } else {
            Section {
                Picker("Method:", selection: $model.authMethod) {
                    ForEach(PrometheusPreferencesModel.AuthMethod.allCases, id: \.self) {
                        Text($0.label).tag($0)
                    }
                }
                .accessibilityIdentifier("preferences.prometheus-auth")
                SecretFieldsView(
                    input: model.input, kind: kind, isStored: model.storedMethod == model.authMethod)
                ProblemText(problem: model.azureProblem)
            } header: {
                Text("Authentication")
            } footer: {
                Text(
                    model.authMethod == .azureCLI
                        ? "Uses the account `az` is logged in with; the token is kept in memory only."
                        : "Sent only to this endpoint, over HTTPS."
                )
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
            }
        }
    }

    private var kind: SecretFieldsView.Kind {
        switch model.authMethod {
        case .basic: .basic
        case .bearer: .single("Token")
        case .none, .azureCLI: .none
        }
    }
}
