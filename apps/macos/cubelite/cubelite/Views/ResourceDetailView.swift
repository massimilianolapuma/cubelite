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
    /// Port-forward manager; nil hides the port-forward section.
    var portForwardService: PortForwardService?
    /// Context the resource belongs to (required for actions).
    var context: String?
    /// Invoked after a successful mutation so the parent can reload.
    var onPodMutated: (() -> Void)?
    /// Invoked when the user dismisses the panel with the close button.
    var onClose: (() -> Void)?

    @Environment(LogSessionStore.self) private var logSessionStore

    @State private var showDeleteConfirm = false
    @State private var showShell = false
    @State private var containers: [ContainerInfo] = []
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
                if case .pod(let pod) = resource, portForwardService != nil {
                    portForwardSection(pod)
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
            ManifestSheetView(
                title: "\(resourceName) — manifest",
                text: item.text,
                onClose: { manifestItem = nil },
                onApply: { json in
                    guard let service = kubeAPIService, let pod = currentPod else { return }
                    try await service.applyManifestJSON(
                        apiPath: "/api/v1/namespaces/\(pod.namespace)/pods/\(pod.name)",
                        json: json,
                        inContext: context)
                    onPodMutated?()
                }
            )
        }
        .sheet(isPresented: $showShell) {
            if let service = kubeAPIService, let pod = currentPod {
                PodExecView(
                    pod: pod,
                    kubeAPIService: service,
                    context: context,
                    onClose: { showShell = false }
                )
            }
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
                    logSessionStore.open(pod: pod, context: context)
                } label: {
                    Label("Logs", systemImage: "doc.plaintext")
                }
                Button {
                    showShell = true
                } label: {
                    Label("Shell", systemImage: "terminal")
                }
                Button {
                    runAction(notifyMutation: false) { service, ctx in
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
    @State private var forwardLocalPort: String = ""
    @State private var forwardRemotePort: String = "80"

    // MARK: - Port Forward

    @ViewBuilder
    private func portForwardSection(_ pod: PodInfo) -> some View {
        if let service = portForwardService, let context {
            VStack(alignment: .leading, spacing: 8) {
                Divider().padding(.vertical, 8)
                Text("PORT FORWARD")
                    .font(.system(size: 9.5, weight: .semibold))
                    .kerning(0.7)
                    .foregroundStyle(DesignTokens.textTertiary)
                let remotePort = PortForwardInput.parsePort(forwardRemotePort)
                let localPort = remotePort.flatMap {
                    PortForwardInput.resolveLocalPort(forwardLocalPort, remotePort: $0)
                }
                HStack(spacing: 6) {
                    TextField("remote", text: $forwardRemotePort)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 60)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 9))
                        .foregroundStyle(DesignTokens.textTertiary)
                    TextField("local", text: $forwardLocalPort)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 60)
                    Button("Forward") {
                        guard let remote = remotePort, let local = localPort else { return }
                        do {
                            try service.start(
                                context: context, namespace: pod.namespace, pod: pod.name,
                                localPort: local, remotePort: remote)
                        } catch {
                            actionError = error.localizedDescription
                        }
                    }
                    .controlSize(.small)
                    .disabled(remotePort == nil || localPort == nil)
                }
                if remotePort == nil || localPort == nil {
                    Text("Ports must be numbers between 1 and 65535")
                        .font(.system(size: 10))
                        .foregroundStyle(DesignTokens.statusErr)
                }
                ForEach(service.sessions(namespace: pod.namespace, pod: pod.name)) { session in
                    HStack(spacing: 6) {
                        Circle()
                            .fill(sessionColor(session.state))
                            .frame(width: 6, height: 6)
                        Text(verbatim: "localhost:\(session.localPort) → \(session.remotePort)")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(DesignTokens.textSecondary)
                        if case .failed(let reason) = session.state {
                            Text(reason)
                                .font(.system(size: 10))
                                .foregroundStyle(DesignTokens.statusErr)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        Button("Stop") { service.stop(session) }
                            .controlSize(.mini)
                    }
                }
            }
        }
    }

    private func sessionColor(_ state: PortForwardSession.State) -> Color {
        switch state {
        case .active: DesignTokens.statusOk
        case .starting: DesignTokens.statusWarn
        case .failed: DesignTokens.statusErr
        }
    }

    private struct ManifestItem: Identifiable {
        let id = UUID()
        let text: String
    }


    /// Runs an operation with the shared spinner/error handling.
    /// `notifyMutation` reloads the parent on success — read-only actions
    /// (Describe) must pass `false` or the reload deselects the pod and
    /// tears down this panel before its sheet can present.
    private func runAction(
        notifyMutation: Bool = true,
        _ operation: @escaping (KubeAPIService, String?) async throws -> Void
    ) {
        guard let service = kubeAPIService else { return }
        isActing = true
        Task {
            defer { isActing = false }
            do {
                try await operation(service, context)
                if notifyMutation { onPodMutated?() }
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
            if let onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(DesignTokens.textTertiary)
                }
                .buttonStyle(.plain)
                .help("Close details")
                .accessibilityLabel("Close details")
            }
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
        VStack(alignment: .leading, spacing: 0) {
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
            if !containers.isEmpty {
                containersSection
            }
        }
        .task(id: pod.id) {
            containers = (try? await kubeAPIService?.fetchPodContainers(
                namespace: pod.namespace, pod: pod.name, inContext: context)) ?? []
        }
    }

    /// Containers of the selected pod (app, sidecar, init) with live state.
    private var containersSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider().padding(.vertical, 8)
            Text("CONTAINERS")
                .font(.system(size: 9.5, weight: .semibold))
                .kerning(0.7)
                .foregroundStyle(DesignTokens.textTertiary)
            ForEach(containers) { container in
                HStack(spacing: 7) {
                    Circle()
                        .fill(containerStateColor(container))
                        .frame(width: 6, height: 6)
                    Text(container.name)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(DesignTokens.textSecondary)
                        .lineLimit(1)
                    if container.isSidecar {
                        Text("sidecar")
                            .font(.system(size: 10))
                            .foregroundStyle(DesignTokens.textTertiary)
                    } else if container.isInit {
                        Text("init")
                            .font(.system(size: 10))
                            .foregroundStyle(DesignTokens.textTertiary)
                    }
                    Spacer()
                    Text(containerStateLabel(container))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(containerStateColor(container))
                }
            }
        }
    }

    private func containerStateLabel(_ container: ContainerInfo) -> String {
        switch container.state {
        case .running: "Running"
        case .waiting(let reason): reason ?? "Waiting"
        case .terminated(let reason): reason ?? "Terminated"
        }
    }

    private func containerStateColor(_ container: ContainerInfo) -> Color {
        switch container.state {
        case .running: DesignTokens.statusOk
        case .terminated: DesignTokens.textTertiary
        case .waiting: DesignTokens.statusErr
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
