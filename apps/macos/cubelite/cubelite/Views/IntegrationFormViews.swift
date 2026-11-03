import SwiftUI

/// Settings → Integrations (#503, #512, spec §5.2–5.3): the kube context
/// (current one preselected) and the integration shown, Elasticsearch or
/// Prometheus.
struct IntegrationsPreferencesTab: View {

    typealias Shown = AppSettings.IntegrationPane

    @Environment(ClusterState.self) private var clusterState
    @Environment(AppSettings.self) private var settings
    let elastic: (any ElasticPreferencesBackend)?
    let prometheus: (any PrometheusPreferencesBackend)?

    @Environment(ElasticEndpointStore.self) private var elasticEndpoints
    @Environment(PrometheusEndpointStore.self) private var prometheusEndpoints
    @State private var context: String?
    /// Kept across pane switches so typed edits survive.
    @State private var elasticModel: ElasticPreferencesModel?
    @State private var prometheusModel: PrometheusPreferencesModel?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Context:", selection: $context) {
                    ForEach(clusterState.contexts, id: \.self) { Text($0).tag(Optional($0)) }
                }
                .accessibilityIdentifier("preferences.integration-context")
                Picker("Integration", selection: Bindable(settings).integrationPane) {
                    ForEach(Shown.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityIdentifier("preferences.integration")
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            switch settings.integrationPane {
            case .elasticsearch:
                if let elasticModel { ElasticPreferencesForm(model: elasticModel) }
            case .prometheus:
                if let prometheusModel { PrometheusPreferencesForm(model: prometheusModel) }
            }
            Divider()
            Toggle("Show integration hints in panels", isOn: Bindable(settings).integrationHints)
                .help("Offer setting up Elasticsearch and Prometheus where their data would appear")
                .accessibilityIdentifier("preferences.integration-hints")
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
        }
        .task(id: context) {
            if elasticModel == nil, let elastic {
                elasticModel = ElasticPreferencesModel(backend: elastic, endpoints: elasticEndpoints)
            }
            if prometheusModel == nil, let prometheus {
                prometheusModel = PrometheusPreferencesModel(backend: prometheus, endpoints: prometheusEndpoints)
            }
            await elasticModel?.load(context: context)
            await prometheusModel?.load(context: context)
        }
        .task(id: clusterState.contexts) {
            // Contexts may load after Settings opened.
            if context == nil || !clusterState.contexts.contains(context ?? "") {
                context = clusterState.currentContext ?? clusterState.contexts.first
            }
        }
    }
}

/// Off / In cluster / External.
struct TargetModeSection: View {
    @Bindable var target: TargetFields
    let label: String
    let footer: String
    let identifier: String

    var body: some View {
        Section {
            Picker(label, selection: $target.mode) {
                ForEach(TargetFields.Mode.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("\(identifier)-mode")
        } footer: {
            Text(footer)
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
        }
    }
}

/// A service found by Detect, as a menu entry.
struct DetectedChoice: Identifiable {
    let id: String
    let label: String
    let pick: () -> Void
}

/// Service fields (with Detect) for In cluster, or the URL for External.
struct TargetLocationSection: View {
    @Bindable var target: TargetFields
    let detected: [DetectedChoice]?
    let canDetect: Bool
    let urlPrompt: String
    let identifier: String
    let onDetect: () -> Void

    var body: some View {
        switch target.mode {
        case .off:
            EmptyView()
        case .inCluster:
            Section("Service") {
                HStack {
                    Button("Detect", action: onDetect)
                        .disabled(!canDetect)
                        .accessibilityIdentifier("\(identifier)-detect")
                    if let detected, !detected.isEmpty {
                        Menu("Use a detected service") {
                            ForEach(detected) { choice in Button(choice.label, action: choice.pick) }
                        }
                        .fixedSize()
                        .accessibilityIdentifier("\(identifier)-detected")
                    }
                }
                TextField("Namespace:", text: $target.namespace)
                TextField("Service:", text: $target.service)
                TextField("Port:", value: $target.port, format: .number.grouping(.never))
                Toggle("HTTPS", isOn: $target.https)
            }
        case .external:
            Section("Endpoint") {
                TextField("URL:", text: $target.url, prompt: Text(urlPrompt))
                    .accessibilityIdentifier("\(identifier)-url")
                ProblemText(problem: target.urlProblem)
            }
        }
    }
}

/// User and password, or one secret, with a "saved" prompt.
struct SecretFieldsView: View {
    enum Kind { case none, basic, single(String) }

    @Bindable var input: SecretInput
    let kind: Kind
    let isStored: Bool

    var body: some View {
        let prompt = Text(isStored ? "saved — leave empty to keep" : "")
        switch kind {
        case .none:
            EmptyView()
        case .basic:
            TextField("User:", text: $input.username)
            SecureField("Password:", text: $input.password, prompt: prompt)
        case .single(let label):
            SecureField("\(label):", text: $input.secret, prompt: prompt)
        }
    }
}

/// Skip-TLS opt-in, Test connection, Save and the last result.
struct FormActionsSection: View {
    @Bindable var target: TargetFields
    let busy: Bool
    let canAct: Bool
    let outcome: FormOutcome?
    let identifier: String
    let onTest: () -> Void
    let onSave: () -> Void

    var body: some View {
        Section {
            if target.mode != .off {
                Toggle("Skip TLS certificate verification", isOn: $target.skipTLSVerify)
            }
            HStack {
                if target.mode != .off {
                    Button("Test connection", action: onTest)
                        .disabled(!canAct)
                        .accessibilityIdentifier("\(identifier)-test")
                }
                Spacer()
                if busy {
                    ProgressView().controlSize(.small)
                }
                Button("Save", action: onSave)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canAct)
                    .accessibilityIdentifier("\(identifier)-save")
            }
            if let outcome {
                Text(outcome.text)
                    .typeStyle(
                        DesignTokens.Typography.caption,
                        color: outcome.ok ? DesignTokens.statusOk : DesignTokens.statusErr)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("\(identifier)-result")
            }
        }
    }
}

/// A validation message, when there is one.
struct ProblemText: View {
    let problem: String?

    var body: some View {
        if let problem {
            Text(problem).typeStyle(DesignTokens.Typography.caption, color: DesignTokens.statusErr)
        }
    }
}

/// The in-cluster web UI picked from Detect (Kibana #519, Grafana #525):
/// opened through a port-forward unless a URL is configured.
struct InClusterUIRow: View {
    /// `Kibana`, `Grafana`.
    let name: String
    let service: ServiceRef
    /// A configured URL wins over the service.
    let urlSet: Bool
    let identifier: String
    let onClear: () -> Void

    var body: some View {
        HStack {
            Text(
                "\(name) in the cluster: \(service.namespace)/\(service.service):\(service.port)"
                    + (urlSet ? " (the URL above wins)" : " — opened through a port-forward")
            )
            .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
            .help("The forward opens \(name) at its root; if \(name) is served under a sub-path, set its URL instead.")
            Spacer()
            Button("Clear", action: onClear)
                .buttonStyle(.borderless)
                .accessibilityIdentifier(identifier)
        }
    }
}
