import SwiftUI

/// Settings → Integrations → Prometheus (#512, spec §5.3).
struct PrometheusPreferencesPane: View {

    @Environment(PrometheusEndpointStore.self) private var endpoints
    let backend: any PrometheusPreferencesBackend
    let context: String?

    @State private var model: PrometheusPreferencesModel?

    var body: some View {
        Group {
            if let model {
                PrometheusPreferencesForm(model: model)
            } else {
                ProgressView()
            }
        }
        .task(id: context) {
            if model == nil {
                model = PrometheusPreferencesModel(backend: backend, endpoints: endpoints)
            }
            await model?.load(context: context)
        }
    }
}

private struct PrometheusPreferencesForm: View {

    @Bindable var model: PrometheusPreferencesModel

    var body: some View {
        Form {
            TargetModeSection(
                target: model.target, label: "Prometheus:",
                footer: "Metrics history in pod and deployment details, list sparklines and Open in Grafana.",
                identifier: "preferences.prometheus")
            TargetLocationSection(
                target: model.target,
                detected: model.detected?.map { found in
                    DetectedChoice(
                        id: found.id, label: "\(found.namespace)/\(found.name):\(found.port)",
                        pick: { model.pick(found) })
                },
                canDetect: model.busy == nil && model.context != nil,
                urlPrompt: "https://<workspace>.<region>.prometheus.monitor.azure.com",
                identifier: "preferences.prometheus",
                onDetect: { Task { await model.detect() } })
            if model.target.mode != .off {
                detailsSection
                authSection
            }
            FormActionsSection(
                target: model.target, busy: model.busy != nil,
                canAct: model.busy == nil && !model.isIncomplete && model.context != nil,
                outcome: model.outcome, identifier: "preferences.prometheus",
                onTest: { Task { await model.test() } }, onSave: { Task { await model.save() } })
        }
        .formStyle(.grouped)
        .padding()
    }

    private var detailsSection: some View {
        Section("Metrics") {
            TextField("Cluster label:", text: $model.cluster, prompt: Text("optional, for shared workspaces"))
                .accessibilityIdentifier("preferences.prometheus-cluster")
            TextField("Grafana URL:", text: $model.grafanaURL, prompt: Text("optional"))
                .accessibilityIdentifier("preferences.prometheus-grafana")
            TextField("Grafana datasource:", text: $model.grafanaDatasource, prompt: Text("UID, optional"))
            ProblemText(problem: model.grafanaProblem)
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
