import SwiftUI
import AppKit

/// Menu bar dropdown displaying the active context and a quick-switch list.
///
/// Shown when the user clicks the CubeLite status-bar icon. Tapping a context
/// row switches the active context and persists the change to the kubeconfig file.
struct MenuBarContextView: View {

    let clusterState: ClusterState
    let kubeconfigService: KubeconfigService
    var onShowDetails: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            activeContextHeader
            if !clusterState.contexts.isEmpty {
                Divider()
                contextRows
            }
            Divider()
            if onShowDetails != nil {
                Button("Show Details…") {
                    onShowDetails?()
                }
                .keyboardShortcut("d")
                .padding(.top, 4)
                .padding(.horizontal, 4)
                Divider()
            }
            Button("Preferences…") {
                NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
                NSApplication.shared.activate()
            }
            .keyboardShortcut(",")
            .padding(.top, 4)
            .padding(.horizontal, 4)
            Button("Quit CubeLite") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
            .padding(.top, 4)
            .padding(.horizontal, 4)
        }
        .padding(8)
        .frame(minWidth: 240)
    }

    // MARK: - Sub-views

    @ViewBuilder
    private var activeContextHeader: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Active Context")
                .font(.caption)
                .foregroundStyle(.secondary)
            if clusterState.noConfig {
                Text("No kubeconfig found")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .italic()
                Text("Place config at ~/.kube/config")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            } else {
                Text(clusterState.currentContext ?? "None")
                    .font(.body.bold())
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 4)
    }

    @ViewBuilder
    private var contextRows: some View {
        let contexts = clusterState.contexts
        let current = clusterState.currentContext
        ForEach(contexts, id: \.self) { context in
            Button {
                switchContext(to: context)
            } label: {
                HStack {
                    Text(context)
                        .lineLimit(1)
                    Spacer()
                    if context == current {
                        Image(systemName: "checkmark")
                            .foregroundStyle(.tint)
                    }
                }
            }
            .buttonStyle(.plain)
            .padding(.vertical, 3)
            .padding(.horizontal, 4)
        }
    }

    // MARK: - Actions

    @MainActor
    private func switchContext(to context: String) {
        Task {
            do {
                var config = try await kubeconfigService.load()
                try await kubeconfigService.setActiveContext(context, in: &config)
                try await kubeconfigService.save(config)
                clusterState.currentContext = context
            } catch {
                clusterState.errorMessage = error.localizedDescription
            }
        }
    }
}

