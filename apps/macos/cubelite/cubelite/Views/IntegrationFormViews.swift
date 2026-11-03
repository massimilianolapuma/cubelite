import SwiftUI

/// Settings → Integrations (#503, #512, spec §5.2–5.3): the kube context
/// (current one preselected) and the integration shown, Elasticsearch or
/// Prometheus.
struct IntegrationsPreferencesTab: View {

    enum Shown: String, CaseIterable {
        case elasticsearch = "Elasticsearch"
        case prometheus = "Prometheus"
    }

    @Environment(ClusterState.self) private var clusterState
    let elastic: (any ElasticPreferencesBackend)?
    let prometheus: (any PrometheusPreferencesBackend)?

    @State private var context: String?
    @State private var shown = Shown.elasticsearch

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Context:", selection: $context) {
                    ForEach(clusterState.contexts, id: \.self) { Text($0).tag(Optional($0)) }
                }
                .accessibilityIdentifier("preferences.integration-context")
                Picker("Integration", selection: $shown) {
                    ForEach(Shown.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityIdentifier("preferences.integration")
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            switch shown {
            case .elasticsearch:
                if let elastic { ElasticPreferencesPane(backend: elastic, context: context) }
            case .prometheus:
                if let prometheus { PrometheusPreferencesPane(backend: prometheus, context: context) }
            }
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
