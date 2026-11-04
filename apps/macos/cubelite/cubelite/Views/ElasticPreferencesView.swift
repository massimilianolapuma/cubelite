import SwiftUI

/// Settings → Integrations → Elasticsearch (#503, spec §5.2), for a context
/// or the default shared by every context (#528).
struct ElasticPreferencesForm: View {

    @Bindable var model: ElasticPreferencesModel
    let contexts: [String]

    var body: some View {
        Form {
            EndpointScopeSection(
                scope: model.scope, view: model.view, context: model.context, contexts: contexts,
                busy: model.busy != nil, identifier: "preferences.elastic",
                onScope: { kind in Task { await model.setScope(kind) } },
                onOverride: { Task { await model.override() } },
                onTurnOff: { Task { await model.turnOff() } },
                onUseDefault: { Task { await model.useDefault() } })
            switch model.view {
            case .inherited:
                Section("Logs") {
                    ClusterFilterRows(
                        field: $model.clusterField, value: $model.clusterValue, fieldHint: model.clusterFieldHint)
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
    }

    @ViewBuilder
    private var endpointSections: some View {
        TargetModeSection(
            target: model.target, label: "Elasticsearch:",
            footer: "Log history in the log panel and Open in Kibana. Credentials stay in the keychain.",
            identifier: "preferences.elastic",
            modes: model.view == .sharedDefault ? [.off, .external] : TargetFields.Mode.allCases)
        TargetLocationSection(
            target: model.target,
            detected: model.detected.map { es in
                es.map { found in
                    DetectedChoice(
                        id: found.id,
                        label: "Elasticsearch \(found.namespace)/\(found.name):\(found.port)",
                        pick: { model.pick(found) })
                }
                    + model.detectedKibana.map { found in
                        DetectedChoice(
                            id: found.id,
                            label: "Kibana \(found.namespace)/\(found.name):\(found.port)",
                            pick: { model.pickKibana(found) })
                    }
            },
            canDetect: model.busy == nil && model.context != nil,
            urlPrompt: "https://my-deployment.es.example:9243", identifier: "preferences.elastic",
            onDetect: { Task { await model.detect() } })
        if model.target.mode != .off {
            detailsSection
            ElasticAuthSection(model: model)
        }
        actions(inherited: false)
    }

    private func actions(inherited: Bool) -> some View {
        FormActionsSection(
            target: model.target, busy: model.busy != nil,
            canAct: model.busy == nil && !model.isIncomplete && model.context != nil,
            outcome: model.outcome, identifier: "preferences.elastic", inherited: inherited,
            onTest: { Task { await model.test() } }, onSave: { Task { await model.save() } })
    }

    private var detailsSection: some View {
        Section("Logs") {
            TextField("Index pattern:", text: $model.indexPattern)
            Picker("Fields:", selection: $model.preset) {
                Text("ECS (Elastic Agent, Filebeat)").tag(FieldPreset.ecs)
                Text("Fluent Bit").tag(FieldPreset.fluentBit)
            }
            ClusterFilterRows(
                field: $model.clusterField, value: $model.clusterValue, fieldHint: model.clusterFieldHint)
            TextField("Kibana URL:", text: $model.kibanaURL, prompt: Text("optional"))
                .accessibilityIdentifier("preferences.elastic-kibana")
            ProblemText(problem: model.kibanaProblem)
            if model.target.mode == .inCluster, let kibana = model.kibanaService {
                InClusterUIRow(
                    name: "Kibana", service: kibana, urlSet: !model.kibanaURL.trimmed.isEmpty,
                    identifier: "preferences.elastic-kibana-clear", onClear: { model.kibanaService = nil })
            }
        }
    }
}

private struct ElasticAuthSection: View {

    @Bindable var model: ElasticPreferencesModel

    var body: some View {
        Section {
            Picker("Method:", selection: $model.authMethod) {
                ForEach(model.authMethods, id: \.self) { Text($0.label).tag($0) }
            }
            .accessibilityIdentifier("preferences.elastic-auth")
            SecretFieldsView(input: model.input, kind: kind, isStored: model.storedMethod == model.authMethod)
            if model.authMethod == .eckUser {
                Button("Check ECK credentials") { Task { await model.useEck() } }
                    .disabled(model.busy != nil || model.isIncomplete || model.context == nil)
                    .accessibilityIdentifier("preferences.elastic-eck")
            }
        } header: {
            Text("Authentication")
        } footer: {
            Text(footer)
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
        }
    }

    private var kind: SecretFieldsView.Kind {
        switch model.authMethod {
        case .basic: .basic
        case .apiKey: .single("API key")
        case .bearer: .single("Token")
        case .none, .eckUser: .none
        }
    }

    private var footer: String {
        switch model.authMethod {
        case .eckUser:
            "Reads the elastic user's password from the ECK secret at each connection; nothing is stored."
        case .apiKey:
            "Base64 id:key, as Kibana shows it. Recommended for Elastic Cloud and Elastic on Azure."
        default:
            "Sent only to this endpoint, over HTTPS or the in-cluster tunnel."
        }
    }
}
