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
            }
            .padding(20)
        }
        .background(Color(nsColor: .controlBackgroundColor))
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
                        .fill(podPhaseColor(pod.phase))
                        .frame(width: 8, height: 8)
                    Text(pod.phase ?? "Unknown")
                }
            }
            DetailRow(label: "Ready", value: pod.ready ? "Yes" : "No")
            DetailRow(label: "Restarts", value: "\(pod.restarts)")
            DetailRow(label: "Age", value: ageString(from: pod.creationTimestamp))
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

    private func podPhaseColor(_ phase: String?) -> Color {
        switch phase {
        case "Running": return .green
        case "Pending": return .orange
        case "Succeeded": return .blue
        case "Failed": return .red
        default: return .secondary
        }
    }

    private func ageString(from isoTimestamp: String?) -> String {
        guard let iso = isoTimestamp else { return "—" }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let createdAt = date else { return "—" }
        let elapsed = Int(Date().timeIntervalSince(createdAt))
        if elapsed < 60 { return "\(elapsed)s" }
        if elapsed < 3_600 { return "\(elapsed / 60)m" }
        if elapsed < 86_400 { return "\(elapsed / 3_600)h" }
        return "\(elapsed / 86_400)d"
    }

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
    return ResourceDetailView(resource: .deployment(dep))
        .frame(width: 340, height: 300)
}
