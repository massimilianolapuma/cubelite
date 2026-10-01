import SwiftUI

/// Overview for the selected cluster/namespace (parity v2 §4, mirrors the
/// desktop `OverviewView`).
///
/// Top-to-bottom: stat row (nodes / running pods / healthy deployments /
/// warnings), capacity CPU+MEM meters, recent Warning events, then the
/// per-resource summary cards. Counts come from `OverviewSummary`.
struct OverviewView: View {

    @Environment(ClusterState.self) private var clusterState

    /// Opens the Events view ("All events →").
    let onShowEvents: () -> Void

    init(onShowEvents: @escaping () -> Void) {
        self.onShowEvents = onShowEvents
    }

    // Card tints: the desktop sidebar section palette.
    private let workloads = DesignTokens.clusterBlue
    private let network = DesignTokens.clusterViolet
    private let config = DesignTokens.statusWarn
    private let namespaceTint = DesignTokens.accentAltTeal

    var body: some View {
        let summary = OverviewSummary(state: clusterState)
        ScrollView {
            VStack(spacing: 12) {
                statRow(summary)
                HStack(alignment: .top, spacing: 12) {
                    capacityCard
                    warningsCard
                }
                resourceGrid(summary)
            }
            .padding(16)
        }
        .background(DesignTokens.surfaceWindow)
    }

    // MARK: - Stat Row

    private func statRow(_ summary: OverviewSummary) -> some View {
        let warnings = clusterState.warningEvents.count
        return LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4),
            spacing: 12
        ) {
            statCard(
                "Nodes", value: summary.nodes.map { "\($0)" } ?? "—", icon: "server.rack",
                tint: DesignTokens.accentAltTeal)
            statCard(
                "Pods running", value: "\(summary.pods.running)/\(summary.pods.total)",
                icon: "cube.box", tint: DesignTokens.clusterBlue)
            statCard(
                "Deploys healthy",
                value: "\(summary.deployments.healthy)/\(summary.deployments.total)",
                icon: "square.stack.3d.up", tint: DesignTokens.clusterViolet)
            statCard(
                "Warnings", value: "\(warnings)", icon: "exclamationmark.triangle",
                tint: warnings > 0 ? DesignTokens.statusWarn : DesignTokens.textTertiary,
                valueColor: warnings > 0 ? DesignTokens.statusWarn : DesignTokens.statusOk)
        }
    }

    private func statCard(
        _ title: String, value: String, icon: String, tint: Color,
        valueColor: Color = DesignTokens.textDataBright
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .iconSize(DesignTokens.iconMd, weight: .semibold)
                    .foregroundStyle(tint)
                    .accessibilityHidden(true)
                Text(title)
                    .typeStyle(DesignTokens.Typography.colhead, color: DesignTokens.textTertiary)
                    .lineLimit(1)
            }
            Text(value)
                .typeStyle(DesignTokens.Typography.stat, color: valueColor)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .dashboardSurface()
        .accessibilityElement(children: .combine)
    }

    // MARK: - Capacity

    private var capacityCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Capacity")
                .typeStyle(DesignTokens.Typography.colhead, color: DesignTokens.textTertiary)
            let capacity = clusterState.capacity
            MeterBarView(
                label: "CPU", fraction: capacity?.cpuFraction,
                detail: capacity.flatMap(OverviewSummary.coresDetail))
            MeterBarView(
                label: "MEM", fraction: capacity?.memFraction,
                detail: capacity.flatMap(OverviewSummary.memoryDetail))
            if capacity == nil {
                Text("metrics unavailable — metrics-server not detected in this cluster")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textDisabled)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .dashboardSurface()
    }

    // MARK: - Recent Warnings

    private var warningsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Recent warnings")
                    .typeStyle(DesignTokens.Typography.colhead, color: DesignTokens.textTertiary)
                Spacer()
                Button(action: onShowEvents) {
                    HStack(spacing: 4) {
                        Text("All events")
                        Image(systemName: "arrow.right")
                            .iconSize(DesignTokens.iconSm)
                            .accessibilityHidden(true)
                    }
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("overview.all-events")
            }
            if clusterState.warningEvents.isEmpty {
                Text("No warning events.")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textDisabled)
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(clusterState.warningEvents.prefix(5)) { event in
                        Button(action: onShowEvents) { warningRow(event) }
                            .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .dashboardSurface()
    }

    private func warningRow(_ event: EventInfo) -> some View {
        HStack(spacing: 8) {
            Circle().fill(DesignTokens.statusWarn).frame(width: 6, height: 6)
                .accessibilityHidden(true)
            Text(verbatim: EventRowFormat.objectLabel(event))
                .typeStyle(DesignTokens.Typography.dataSm, color: DesignTokens.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(width: 160, alignment: .leading)
            Text(event.message ?? event.reason ?? "—")
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
                .lineLimit(1)
            Spacer(minLength: 0)
            Text(event.lastTimestamp.k8sAge)
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    // MARK: - Resource Grid

    private func resourceGrid(_ summary: OverviewSummary) -> some View {
        LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
            spacing: 12
        ) {
            card("Pods", icon: "cube.box", tint: workloads, forbiddenKind: "pods") {
                metric("Total", summary.pods.total)
                metric("Running", summary.pods.running, tone: DesignTokens.statusOk)
                metric("Pending", summary.pods.pending, tone: DesignTokens.statusWarn)
                metric("Failed", summary.pods.failed, tone: DesignTokens.statusErr)
            }
            card(
                "Deployments", icon: "square.stack.3d.up", tint: workloads,
                forbiddenKind: "deployments"
            ) {
                metric("Total", summary.deployments.total)
                metric("Healthy", summary.deployments.healthy, tone: DesignTokens.statusOk)
                metric("Degraded", summary.deployments.degraded, tone: DesignTokens.statusWarn)
            }
            card("Services", icon: "network", tint: network, forbiddenKind: "services") {
                metric("Total", summary.services.total)
                metric("ClusterIP", summary.services.clusterIP)
                metric("NodePort", summary.services.nodePort, tone: DesignTokens.statusWarn)
                metric(
                    "LoadBalancer", summary.services.loadBalancer,
                    tone: DesignTokens.accentDefault)
            }
            card("Namespaces", icon: "folder", tint: namespaceTint, forbiddenKind: nil) {
                metric("Total", summary.namespaces.total)
                metric("Active", summary.namespaces.active, tone: DesignTokens.statusOk)
            }
            card("Secrets", icon: "key", tint: config, forbiddenKind: "secrets") {
                metric("Total", summary.secrets.total)
                metric("Opaque", summary.secrets.opaque)
                metric("TLS", summary.secrets.tls, tone: DesignTokens.accentDefault)
                metric("Docker", summary.secrets.docker, tone: DesignTokens.statusWarn)
            }
            card("ConfigMaps", icon: "doc.text", tint: config, forbiddenKind: "configmaps") {
                metric("Total", summary.configMaps)
            }
            card("Ingresses", icon: "globe", tint: network, forbiddenKind: "ingresses") {
                metric("Total", summary.ingresses.total)
                metric("with TLS", summary.ingresses.tls, tone: DesignTokens.accentDefault)
            }
            card(
                "Helm Releases", icon: "shippingbox", tint: workloads,
                forbiddenKind: "helmreleases"
            ) {
                metric("Total", summary.helm.total)
                metric("deployed", summary.helm.deployed, tone: DesignTokens.statusOk)
                metric("failed", summary.helm.failed, tone: DesignTokens.statusErr)
            }
        }
    }

    /// A summary card; shows the forbidden badge when RBAC denied its kind.
    private func card<Rows: View>(
        _ title: String, icon: String, tint: Color, forbiddenKind: String?,
        @ViewBuilder rows: () -> Rows
    ) -> some View {
        let metrics = rows()
        let forbidden = forbiddenKind.map { clusterState.forbiddenResources.contains($0) } ?? false
        return DashboardCard(title: title, icon: icon, color: tint) {
            if forbidden {
                forbiddenBadge
            } else {
                VStack(alignment: .leading, spacing: 4) { metrics }
            }
        }
        .accessibilityIdentifier("overview.card-\(title)")
    }

    /// Metric row; the tone colours non-zero values only ("0 failed" stays
    /// neutral), as on the desktop.
    private func metric(_ label: String, _ value: Int, tone: Color? = nil) -> DashboardMetric {
        DashboardMetric(
            label: label, value: "\(value)",
            color: value > 0 ? (tone ?? DesignTokens.textDataBright) : DesignTokens.textDataBright)
    }

    /// RBAC badge shown in place of a card's metrics.
    private var forbiddenBadge: some View {
        HStack(spacing: 6) {
            HStack(spacing: 4) {
                Image(systemName: "lock")
                    .iconSize(DesignTokens.iconSm)
                    .accessibilityHidden(true)
                Text("forbidden")
                    .typeStyle(DesignTokens.Typography.micro.monospaced)
            }
            .foregroundStyle(DesignTokens.statusWarn)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(
                DesignTokens.statusWarn.opacity(0.12),
                in: RoundedRectangle(cornerRadius: DesignTokens.radiusSm))
            Text("RBAC restricted")
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Surface

extension View {
    /// Dashboard card surface: `surface` fill, default border, xl radius
    /// (desktop `rounded-xl border border-border-default bg-surface-surface`).
    func dashboardSurface() -> some View {
        background(
            DesignTokens.surfaceSurface,
            in: RoundedRectangle(cornerRadius: DesignTokens.radiusXl)
        )
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.radiusXl)
                .strokeBorder(DesignTokens.borderDefault, lineWidth: 1)
        )
    }
}

// MARK: - Dashboard Card

/// Reusable card container for dashboard metrics.
struct DashboardCard<Content: View>: View {

    let title: String
    let icon: String
    let color: Color
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .iconSize(DesignTokens.iconLg, weight: .semibold)
                    .foregroundStyle(color)
                    .accessibilityHidden(true)
                Text(title)
                    .typeStyle(DesignTokens.Typography.subtitle, color: DesignTokens.textPrimary)
            }
            Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .dashboardSurface()
    }
}

// MARK: - Dashboard Metric Row

/// A single metric label/value pair in a dashboard card.
struct DashboardMetric: View {

    let label: String
    let value: String
    var color: Color = DesignTokens.textDataBright

    var body: some View {
        HStack {
            Text(label)
                .typeStyle(DesignTokens.Typography.body, color: DesignTokens.textSecondary)
            Spacer()
            Text(value)
                .typeStyle(DesignTokens.Typography.data, color: color)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Preview

#Preview("Overview") {
    let state = ClusterState()
    state.pods = [
        PodInfo(
            name: "nginx-1", namespace: "default", phase: "Running",
            ready: true, restarts: 0, creationTimestamp: nil),
        PodInfo(
            name: "nginx-2", namespace: "default", phase: "Running",
            ready: true, restarts: 2, creationTimestamp: nil),
        PodInfo(
            name: "api-1", namespace: "dev", phase: "Pending",
            ready: false, restarts: 0, creationTimestamp: nil),
    ]
    state.deployments = [
        DeploymentInfo(name: "nginx", namespace: "default", replicas: 2, readyReplicas: 2),
        DeploymentInfo(name: "api", namespace: "dev", replicas: 3, readyReplicas: 1),
    ]
    state.namespaces = [
        NamespaceInfo(name: "default", phase: "Active"),
        NamespaceInfo(name: "dev", phase: "Active"),
        NamespaceInfo(name: "kube-system", phase: "Active"),
    ]
    state.clusterReachable = true
    return OverviewView(onShowEvents: { /* Preview: no navigation. */ })
        .environment(state)
        .frame(width: 600, height: 500)
}
