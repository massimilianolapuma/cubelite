import SwiftUI

// MARK: - DeploymentDetailView

/// Full detail view for a Kubernetes deployment.
///
/// Shows a header with status badge, a spec/status grid, and a conditions table.
/// Intended to replace the narrow ``ResourceDetailView`` sidebar when a deployment
/// is selected in ``DeploymentListView``.
struct DeploymentDetailView: View {

    let deployment: DeploymentInfo

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                DeploymentDetailHeader(deployment: deployment)
                Divider()
                    .padding(.vertical, 12)
                DeploymentSpecGrid(deployment: deployment)
                if let conditions = deployment.conditions, !conditions.isEmpty {
                    Divider()
                        .padding(.vertical, 12)
                    DeploymentConditionsSection(conditions: conditions)
                }
            }
            .padding(20)
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }
}

// MARK: - Header

/// Header for ``DeploymentDetailView``: icon, name, namespace and status badge.
private struct DeploymentDetailHeader: View {
    let deployment: DeploymentInfo

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 28))
                .foregroundStyle(.tint)
                .frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(deployment.name)
                    .font(.title3.bold())
                    .lineLimit(2)
                Text(deployment.namespace)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            DeploymentStatusBadge(deployment: deployment)
        }
        .padding(.bottom, 14)
    }
}

// MARK: - Status Badge

/// Coloured pill badge reflecting the overall health of a deployment.
private struct DeploymentStatusBadge: View {
    let deployment: DeploymentInfo

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
            Text(statusLabel)
                .font(.caption.bold())
                .foregroundStyle(statusColor)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(statusColor.opacity(0.12))
        .clipShape(Capsule())
    }

    private var statusColor: Color {
        if deployment.replicas == 0 { return .secondary }
        if deployment.readyReplicas == deployment.replicas { return .green }
        if deployment.readyReplicas == 0 { return .red }
        return .orange
    }

    private var statusLabel: String {
        if deployment.replicas == 0 { return "Scaled Down" }
        if deployment.readyReplicas == deployment.replicas { return "Available" }
        if deployment.readyReplicas == 0 { return "Unavailable" }
        return "Degraded"
    }
}

// MARK: - Spec Grid

/// Two-column grid of deployment specification and live-status values.
private struct DeploymentSpecGrid: View {
    let deployment: DeploymentInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHeader("Overview")
            LazyVGrid(
                columns: [GridItem(.flexible()), GridItem(.flexible())],
                alignment: .leading,
                spacing: 12
            ) {
                SpecCell(label: "Strategy", value: deployment.strategy ?? "—")
                SpecCell(label: "Desired", value: "\(deployment.replicas)")
                ReadySpecCell(ready: deployment.readyReplicas, desired: deployment.replicas)
                SpecCell(label: "Available", value: "\(deployment.availableReplicas ?? deployment.readyReplicas)")
                if let unavail = deployment.unavailableReplicas, unavail > 0 {
                    SpecCell(label: "Unavailable", value: "\(unavail)")
                }
                SpecCell(label: "Age", value: deployment.creationTimestamp.k8sAge)
            }
            if let selector = deployment.selector, !selector.isEmpty {
                DeploymentSelectorView(selector: selector)
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.subheadline.bold())
            .foregroundStyle(.secondary)
            .padding(.bottom, 10)
    }
}

/// Single label + value cell used in ``DeploymentSpecGrid``.
private struct SpecCell: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.callout.monospaced())
                .lineLimit(1)
        }
    }
}

/// Ready replicas cell with a coloured indicator dot.
private struct ReadySpecCell: View {
    let ready: Int
    let desired: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Ready")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 5) {
                Circle()
                    .fill(ready == desired && desired > 0 ? Color.green : Color.orange)
                    .frame(width: 7, height: 7)
                Text("\(ready) / \(desired)")
                    .font(.callout.monospaced())
            }
        }
    }
}

/// Displays label-selector key=value pairs as compact chips.
private struct DeploymentSelectorView: View {
    let selector: [String: String]

    private var pairs: [(key: String, value: String)] {
        selector.sorted { $0.key < $1.key }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Selector")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.top, 10)
            LazyVGrid(
                columns: [GridItem(.flexible()), GridItem(.flexible())],
                alignment: .leading,
                spacing: 6
            ) {
                ForEach(pairs, id: \.key) { pair in
                    Text("\(pair.key)=\(pair.value)")
                        .font(.caption.monospaced())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(.secondary.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                        .lineLimit(1)
                }
            }
        }
    }
}

// MARK: - Conditions Section

/// Conditions table for ``DeploymentDetailView``.
private struct DeploymentConditionsSection: View {
    let conditions: [DeploymentCondition]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Conditions")
                .font(.subheadline.bold())
                .foregroundStyle(.secondary)
            conditionsTable
        }
    }

    private var conditionsTable: some View {
        Table(conditions) {
            TableColumn("Type") { c in
                Text(c.type)
                    .font(.callout.monospaced())
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 130)

            TableColumn("Status") { c in
                HStack(spacing: 5) {
                    Circle()
                        .fill(Color.conditionStatus(c.status))
                        .frame(width: 7, height: 7)
                    Text(c.status)
                        .font(.callout)
                        .foregroundStyle(Color.conditionStatus(c.status))
                }
            }
            .width(min: 60, ideal: 80)

            TableColumn("Reason") { c in
                Text(c.reason ?? "—")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 150)

            TableColumn("Last Transition") { c in
                Text(c.lastTransitionTime.k8sAge)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 60, ideal: 90)
        }
        .frame(height: max(100, CGFloat(conditions.count) * 30 + 36))
    }
}

// MARK: - Preview

#Preview("Full details") {
    let conditions: [DeploymentCondition] = [
        DeploymentCondition(
            type: "Available",
            status: "True",
            reason: "MinimumReplicasAvailable",
            message: "Deployment has minimum availability.",
            lastTransitionTime: "2024-01-10T08:00:00Z"
        ),
        DeploymentCondition(
            type: "Progressing",
            status: "True",
            reason: "NewReplicaSetAvailable",
            message: nil,
            lastTransitionTime: "2024-01-10T08:00:00Z"
        ),
    ]
    let dep = DeploymentInfo(
        name: "api-server",
        namespace: "backend",
        replicas: 3,
        readyReplicas: 2,
        strategy: "RollingUpdate",
        selector: ["app": "api-server", "tier": "backend"],
        creationTimestamp: "2024-01-10T08:00:00Z",
        conditions: conditions,
        availableReplicas: 2,
        unavailableReplicas: 1
    )
    return DeploymentDetailView(deployment: dep)
        .frame(width: 540, height: 600)
}

#Preview("Scaled down") {
    let dep = DeploymentInfo(
        name: "worker",
        namespace: "jobs",
        replicas: 0,
        readyReplicas: 0
    )
    DeploymentDetailView(deployment: dep)
        .frame(width: 540, height: 400)
}
