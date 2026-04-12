import SwiftUI

/// Root window view — shows the active kubeconfig context and basic cluster info.
struct ContentView: View {

    @Environment(ClusterState.self) private var clusterState

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            statusBody
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 520, minHeight: 340)
    }

    // MARK: - Sub-views

    private var toolbar: some View {
        HStack(spacing: 8) {
            Image(systemName: "square.3.layers.3d")
                .font(.title2)
                .foregroundStyle(.tint)
            Text("CubeLite")
                .font(.title2.bold())
            Spacer()
            if clusterState.isLoading {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var statusBody: some View {
        if let errorMessage = clusterState.errorMessage {
            errorView(errorMessage)
        } else if clusterState.noConfig {
            noConfigView
        } else {
            contextInfoView
        }
    }

    private func errorView(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .foregroundStyle(.red)
            .padding()
    }

    private var noConfigView: some View {
        VStack(spacing: 12) {
            Image(systemName: "doc.badge.questionmark")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("No kubeconfig found")
                .font(.headline)
            Text("Place your config at ~/.kube/config or set the KUBECONFIG environment variable.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }

    private var contextInfoView: some View {
        Form {
            LabeledContent("Active Context", value: clusterState.currentContext ?? "None")
            LabeledContent("Available Contexts", value: "\(clusterState.contexts.count)")
        }
        .formStyle(.grouped)
        .padding()
    }
}

#Preview {
    ContentView()
        .environment(ClusterState())
}
