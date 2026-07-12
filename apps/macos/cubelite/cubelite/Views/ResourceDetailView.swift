import SwiftUI

// MARK: - Selected Resource

/// Discriminated union holding whichever resource is currently selected.
enum SelectedResource: Sendable {
    case pod(PodInfo)
    case deployment(DeploymentInfo)
}

// MARK: - ResourceDetailView

/// Detail panel shown in the trailing column when a resource is selected.
///
/// Displays a formatted grid of key properties for the elected pod or deployment.
struct ResourceDetailView: View {

    let resource: SelectedResource
    /// Backend used by the pod actions; nil renders the detail read-only
    /// (previews, tests).
    var kubeAPIService: KubeAPIService?
    /// Context the resource belongs to (required for actions).
    var context: String?
    /// Invoked after a successful mutation so the parent can reload.
    var onPodMutated: (() -> Void)?

    @State private var showDeleteConfirm = false
    @State private var manifest: String?
    @State private var actionError: String?
    @State private var isActing = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                Divider()
                    .padding(.bottom, 12)
                switch resource {
                case .pod(let pod): podDetail(pod)
                case .deployment(let dep): deploymentDetail(dep)
                }
                if case .pod(let pod) = resource, kubeAPIService != nil {
                    podActions(pod)
                }
            }
            .padding(20)
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .alert(
            "Delete Pod", isPresented: $showDeleteConfirm, presenting: currentPod
        ) { pod in
            Button("Cancel", role: .cancel) {}
            Button("Delete Pod", role: .destructive) {
                runAction { service, ctx in
                    try await service.deletePod(
                        namespace: pod.namespace, name: pod.name, inContext: ctx)
                }
            }
        } message: { pod in
            Text("This will delete \(pod.name) in namespace \(pod.namespace). "
                + "The workload controller may recreate it.")
        }
        .sheet(item: $manifestItem) { item in
            manifestSheet(item.text)
        }
        .alert(
            "Action failed", isPresented: .constant(actionError != nil),
            actions: {
                Button("OK") { actionError = nil }
            },
            message: { Text(actionError ?? "") }
        )
    }

    private var currentPod: PodInfo? {
        if case .pod(let pod) = resource { return pod }
        return nil
    }

    // MARK: - Pod Actions

    private func podActions(_ pod: PodInfo) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider().padding(.vertical, 8)
            HStack(spacing: 8) {
                Button {
                    runAction { service, ctx in
                        let text = try await service.podManifestJSON(
                            namespace: pod.namespace, name: pod.name, inContext: ctx)
                        manifestItem = ManifestItem(text: text)
                    }
                } label: {
                    Label("Describe", systemImage: "doc.text.magnifyingglass")
                }
                Button {
                    // A pod "restart" is a delete; the controller recreates it.
                    runAction { service, ctx in
                        try await service.deletePod(
                            namespace: pod.namespace, name: pod.name, inContext: ctx)
                    }
                } label: {
                    Label("Restart", systemImage: "arrow.clockwise")
                }
                Button(role: .destructive) {
                    showDeleteConfirm = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
            .controlSize(.small)
            .disabled(isActing)
            if isActing {
                ProgressView().controlSize(.small)
            }
        }
    }

    @State private var manifestItem: ManifestItem?

    private struct ManifestItem: Identifiable {
        let id = UUID()
        let text: String
    }

    private func manifestSheet(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("\(resourceName) — manifest")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                Button("Done") { manifestItem = nil }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(12)
            Divider()
            ScrollView([.vertical, .horizontal]) {
                Text(text)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(DesignTokens.textLog)
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(DesignTokens.surfaceSunken)
        }
        .frame(minWidth: 560, minHeight: 420)
    }

    /// Runs a mutation with the shared spinner/error handling; reloads on success.
    private func runAction(
        _ operation: @escaping (KubeAPIService, String?) async throws -> Void
    ) {
        guard let service = kubeAPIService else { return }
        isActing = true
        Task {
            defer { isActing = false }
            do {
                try await operation(service, context)
                onPodMutated?()
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: headerIcon)
                .font(.system(size: 28))
                .foregroundStyle(.tint)
                .frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(resourceName)
                    .font(.title3.bold())
                    .lineLimit(2)
                Text(resourceKind)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.bottom, 14)
    }

    private var headerIcon: String {
        switch resource {
        case .pod: return "cube.box.fill"
        case .deployment: return "arrow.triangle.2.circlepath"
        }
    }

    private var resourceName: String {
        switch resource {
        case .pod(let p): return p.name
        case .deployment(let d): return d.name
        }
    }

    private var resourceKind: String {
        switch resource {
        case .pod: return "Pod"
        case .deployment: return "Deployment"
        }
    }

    // MARK: - Pod Detail

    private func podDetail(_ pod: PodInfo) -> some View {
        DetailGrid {
            DetailRow(label: "Namespace", value: pod.namespace)
            DetailRow(label: "Phase") {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color.podPhase(pod.phase))
                        .frame(width: 8, height: 8)
                    Text(pod.phase ?? "Unknown")
                }
            }
            DetailRow(label: "Ready", value: pod.ready ? "Yes" : "No")
            DetailRow(label: "Restarts", value: "\(pod.restarts)")
            DetailRow(label: "Age", value: pod.creationTimestamp.k8sAge)
            if let ts = pod.creationTimestamp {
                DetailRow(label: "Created", value: friendlyDate(ts))
            }
        }
    }

    // MARK: - Deployment Detail

    private func deploymentDetail(_ dep: DeploymentInfo) -> some View {
        DetailGrid {
            DetailRow(label: "Namespace", value: dep.namespace)
            DetailRow(label: "Replicas", value: "\(dep.replicas)")
            DetailRow(label: "Ready") {
                HStack(spacing: 6) {
                    Circle()
                        .fill(dep.readyReplicas == dep.replicas && dep.replicas > 0 ? Color.green : Color.orange)
                        .frame(width: 8, height: 8)
                    Text("\(dep.readyReplicas) / \(dep.replicas)")
                }
            }
            DetailRow(label: "Available", value: "\(dep.readyReplicas)")
        }
    }

    // MARK: - Helpers

    private func friendlyDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else {
            return iso
        }
        let display = DateFormatter()
        display.dateStyle = .medium
        display.timeStyle = .short
        return display.string(from: date)
    }
}

// MARK: - Detail Grid / Rows

/// Container that lays out ``DetailRow`` items in a two-column grid.
private struct DetailGrid<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            content
        }
    }
}

/// A label + value row used inside ``DetailGrid``.
private struct DetailRow<Value: View>: View {
    let label: String
    let value: Value

    init(label: String, @ViewBuilder value: () -> Value) {
        self.label = label
        self.value = value()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(label)
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(width: 90, alignment: .leading)
            value
                .font(.callout)
        }
    }
}

/// Convenience overload for plain string values.
private extension DetailRow where Value == Text {
    init(label: String, value: String) {
        self.init(label: label) { Text(value) }
    }
}

// MARK: - Preview

#Preview("Pod") {
    let pod = PodInfo(
        name: "nginx-abc123-xyz",
        namespace: "default",
        phase: "Running",
        ready: true,
        restarts: 3,
        creationTimestamp: "2024-01-10T08:00:00Z"
    )
    return ResourceDetailView(resource: .pod(pod))
        .frame(width: 340, height: 400)
}

#Preview("Deployment") {
    let dep = DeploymentInfo(
        name: "api-server",
        namespace: "backend",
        replicas: 3,
        readyReplicas: 2
    )
    ResourceDetailView(resource: .deployment(dep))
        .frame(width: 340, height: 300)
}
