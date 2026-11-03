import SwiftUI

/// Settings → Integrations (#503, spec §5.2): the Elasticsearch endpoint of
/// a kube context (current one preselected), its credentials, Test
/// connection and Save.
struct IntegrationsPreferencesTab: View {

    @Environment(ClusterState.self) private var clusterState
    @Environment(ElasticEndpointStore.self) private var endpoints
    let backend: any ElasticPreferencesBackend

    @State private var model: ElasticPreferencesModel?
    @State private var context: String?

    var body: some View {
        Group {
            if let model {
                ElasticPreferencesForm(model: model, contexts: clusterState.contexts, context: $context)
            } else {
                ProgressView()
            }
        }
        .task {
            if model == nil {
                model = ElasticPreferencesModel(backend: backend, endpoints: endpoints)
            }
            context = context ?? clusterState.currentContext ?? clusterState.contexts.first
        }
        .task(id: context) {
            await model?.load(context: context)
        }
    }
}

private struct ElasticPreferencesForm: View {

    @Bindable var model: ElasticPreferencesModel
    let contexts: [String]
    @Binding var context: String?

    var body: some View {
        Form {
            Section {
                Picker("Context:", selection: $context) {
                    ForEach(contexts, id: \.self) { Text($0).tag(Optional($0)) }
                }
                .accessibilityIdentifier("preferences.elastic-context")
                Picker("Elasticsearch:", selection: $model.mode) {
                    ForEach(ElasticPreferencesModel.Mode.allCases, id: \.self) {
                        Text($0.label).tag($0)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("preferences.elastic-mode")
            } footer: {
                Text("Log history in the log panel and Open in Kibana. Credentials stay in the keychain.")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
            }
            switch model.mode {
            case .off: EmptyView()
            case .inCluster: inClusterSection
            case .external: externalSection
            }
            if model.mode != .off {
                detailsSection
                ElasticAuthSection(model: model)
            }
            actionsSection
        }
        .formStyle(.grouped)
        .padding()
    }

    private var inClusterSection: some View {
        Section("Service") {
            HStack {
                Button("Detect") { Task { await model.detect() } }
                    .disabled(model.busy != nil || model.context == nil)
                    .accessibilityIdentifier("preferences.elastic-detect")
                if let detected = model.detected, !detected.isEmpty {
                    Menu("Use a detected service") {
                        ForEach(detected) { found in
                            Button("\(found.namespace)/\(found.name):\(found.port)") { model.pick(found) }
                        }
                    }
                    .fixedSize()
                    .accessibilityIdentifier("preferences.elastic-detected")
                }
            }
            TextField("Namespace:", text: $model.namespace)
            TextField("Service:", text: $model.service)
            TextField("Port:", value: $model.port, format: .number.grouping(.never))
            Toggle("HTTPS", isOn: $model.https)
        }
    }

    private var externalSection: some View {
        Section("Endpoint") {
            TextField("URL:", text: $model.url, prompt: Text("https://my-deployment.es.example:9243"))
                .accessibilityIdentifier("preferences.elastic-url")
            if let problem = model.urlProblem {
                Text(problem).typeStyle(DesignTokens.Typography.caption, color: DesignTokens.statusErr)
            }
        }
    }

    private var detailsSection: some View {
        Section("Logs") {
            TextField("Index pattern:", text: $model.indexPattern)
            Picker("Fields:", selection: $model.preset) {
                Text("ECS (Elastic Agent, Filebeat)").tag(FieldPreset.ecs)
                Text("Fluent Bit").tag(FieldPreset.fluentBit)
            }
            TextField("Kibana URL:", text: $model.kibanaURL, prompt: Text("optional"))
                .accessibilityIdentifier("preferences.elastic-kibana")
            if let problem = model.kibanaProblem {
                Text(problem).typeStyle(DesignTokens.Typography.caption, color: DesignTokens.statusErr)
            }
            Toggle("Skip TLS certificate verification", isOn: $model.skipTLSVerify)
        }
    }

    private var actionsSection: some View {
        Section {
            HStack {
                if model.mode != .off {
                    Button("Test connection") { Task { await model.test() } }
                        .disabled(model.busy != nil || model.isIncomplete || model.context == nil)
                        .accessibilityIdentifier("preferences.elastic-test")
                }
                Spacer()
                if model.busy != nil {
                    ProgressView().controlSize(.small)
                }
                Button("Save") { Task { await model.save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.busy != nil || model.isIncomplete || model.context == nil)
                    .accessibilityIdentifier("preferences.elastic-save")
            }
            if let outcome = model.outcome {
                Text(outcome.text)
                    .typeStyle(
                        DesignTokens.Typography.caption,
                        color: outcome.ok ? DesignTokens.statusOk : DesignTokens.statusErr)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("preferences.elastic-result")
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
            switch model.authMethod {
            case .basic:
                TextField("User:", text: $model.username)
                SecureField("Password:", text: $model.password, prompt: Text(keepPrompt))
            case .apiKey:
                SecureField("API key:", text: $model.secret, prompt: Text(keepPrompt))
            case .bearer:
                SecureField("Token:", text: $model.secret, prompt: Text(keepPrompt))
            case .none, .eckUser:
                EmptyView()
            }
        } header: {
            Text("Authentication")
        } footer: {
            Text(footer)
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
        }
    }

    private var isStored: Bool { model.storedMethod == model.authMethod }

    private var keepPrompt: String { isStored ? "saved — leave empty to keep" : "" }

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
