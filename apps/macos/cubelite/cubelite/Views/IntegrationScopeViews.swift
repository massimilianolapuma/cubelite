import SwiftUI

/// Top of an integration's settings (#528): edit this context's endpoint or
/// the default shared by every context, and what the default means for this
/// context (used, overridden, off). Same copy as the desktop.
struct EndpointScopeSection<Endpoint: ScopedEndpoint>: View {
    let scope: EndpointScopeModel<Endpoint>
    let view: ScopeView
    let context: String?
    /// Every kube context (who uses the default).
    let contexts: [String]
    let busy: Bool
    let identifier: String
    let onScope: @Sendable (EndpointScopeKind) -> Void
    let onOverride: () -> Void
    let onTurnOff: () -> Void
    let onUseDefault: () -> Void

    var body: some View {
        Section {
            Picker("Endpoint for:", selection: Binding(get: { scope.kind }, set: onScope)) {
                ForEach(EndpointScopeKind.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("\(identifier)-scope")
            details
        }
    }

    @ViewBuilder
    private var details: some View {
        switch view {
        case .sharedDefault:
            caption(ScopeText.usedBy(scope.store.usersOfDefault(contexts)))
                .accessibilityIdentifier("\(identifier)-used-by")
            caption(ScopeText.defaultHint)
        case .inherited:
            HStack {
                Text("\(ScopeText.usingDefault) · \(scope.defaultTarget ?? "")")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityIdentifier("\(identifier)-default-in-use")
                Spacer()
                Button(ScopeText.override, action: onOverride)
                    .disabled(busy)
                    .accessibilityIdentifier("\(identifier)-override")
                Button(ScopeText.turnOff, action: onTurnOff)
                    .disabled(busy)
                    .accessibilityIdentifier("\(identifier)-turn-off")
            }
        case .off, .own:
            if scope.defaultTarget != nil, view == .off || scope.hasOwn(context) {
                HStack {
                    caption(view == .off ? ScopeText.offForContext : ScopeText.overridesDefault)
                    Spacer()
                    Button(ScopeText.useDefault, action: onUseDefault)
                        .buttonStyle(.link)
                        .disabled(busy)
                        .accessibilityIdentifier("\(identifier)-use-default")
                }
            }
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text).typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
    }
}

/// Prometheus `cluster` label (#528): typed, or picked from the values Test
/// connection found in a shared workspace.
struct ClusterLabelRows: View {
    @Binding var value: String
    let found: [String]?
    let prompt: String

    var body: some View {
        TextField("Cluster label:", text: $value, prompt: Text(prompt))
            .accessibilityIdentifier("preferences.prometheus-cluster")
        if let found, !found.isEmpty {
            Picker("Clusters found:", selection: $value) {
                Text("none (every cluster)").tag("")
                ForEach(found, id: \.self) { Text($0).tag($0) }
                // A typed value not in the list stays selectable.
                if !value.isEmpty, !found.contains(value) { Text(value).tag(value) }
            }
            .accessibilityIdentifier("preferences.prometheus-clusters-found")
        }
    }
}

/// Elasticsearch cluster filter (#528): one `field: value` term narrowing a
/// deployment shared by many clusters.
struct ClusterFilterRows: View {
    @Binding var field: String
    @Binding var value: String
    /// The field used when left blank.
    let fieldHint: String

    var body: some View {
        TextField("Cluster field:", text: $field, prompt: Text(fieldHint))
            .accessibilityIdentifier("preferences.elastic-cluster-field")
        TextField("Cluster:", text: $value, prompt: Text("cluster name (optional, shared deployments)"))
            .accessibilityIdentifier("preferences.elastic-cluster-value")
    }
}
