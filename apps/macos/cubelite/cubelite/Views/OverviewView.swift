import SwiftUI

/// Overview for the selected cluster/namespace (parity with desktop).
///
/// Top-to-bottom: stat row (nodes / running pods / healthy deployments /
/// warnings), capacity CPU+MEM meters, recent Warning events, then the
/// per-resource summary cards.
struct OverviewView: View {

    @Environment(ClusterState.self) private var clusterState

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                statRow
                capacityCard
                warningsCard
                resourceGrid
            }
            .padding(20)
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    // MARK: - Stat Row

    private var statRow: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 16), count: 4),
            spacing: 16
        ) {
            statCard(
                "Nodes", value: "\(clusterState.nodes.count)", icon: "server.rack",
                color: DesignTokens.clusterTeal)
            statCard(
                "Pods running",
                value:
                    "\(clusterState.pods.filter { $0.phase == "Running" }.count)/\(clusterState.pods.count)",
                icon: "cube.box", color: DesignTokens.clusterBlue)
            statCard(
                "Deploys healthy",
                value:
                    "\(clusterState.deployments.filter { $0.readyReplicas == $0.replicas }.count)/\(clusterState.deployments.count)",
                icon: "arrow.triangle.2.circlepath", color: DesignTokens.clusterViolet)
            statCard(
                "Warnings", value: "\(clusterState.warningEvents.count)",
                icon: "exclamationmark.triangle",
                color: clusterState.warningEvents.isEmpty ? Color.secondary : DesignTokens.statusWarn)
        }
    }

    private func statCard(_ title: String, value: String, icon: String, color: Color)
        -> some View
    {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .iconSize(DesignTokens.iconMd, weight: .semibold)
                    .foregroundStyle(color)
                    .accessibilityHidden(true)
                Text(title)
                    .typeStyle(DesignTokens.Typography.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(value)
                .typeStyle(DesignTokens.Typography.stat)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .windowBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.secondary.opacity(0.2), lineWidth: 1)
        )
    }

    // MARK: - Capacity

    private var capacityCard: some View {
        DashboardCard(title: "Capacity", icon: "gauge", color: DesignTokens.statusOk) {
            if let capacity = clusterState.capacity {
                VStack(alignment: .leading, spacing: 12) {
                    MeterBarView(
                        label: "CPU",
                        fraction: capacity.cpuFraction,
                        detail: coresDetail(capacity)
                    )
                    MeterBarView(
                        label: "MEM",
                        fraction: capacity.memFraction,
                        detail: memoryDetail(capacity)
                    )
                }
            } else {
                Text("Metrics unavailable — metrics-server not detected")
                    .typeStyle(DesignTokens.Typography.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
            }
        }
    }

    private func coresDetail(_ capacity: ClusterCapacity) -> String? {
        guard capacity.cpuAllocatableCores > 0 else { return nil }
        return String(
            format: "%.1f / %.1f cores", capacity.cpuUsedCores, capacity.cpuAllocatableCores)
    }

    private func memoryDetail(_ capacity: ClusterCapacity) -> String? {
        guard capacity.memAllocatableBytes > 0 else { return nil }
        let gib = 1_073_741_824.0
        return String(
            format: "%.1f / %.1f GiB", capacity.memUsedBytes / gib,
            capacity.memAllocatableBytes / gib)
    }

    // MARK: - Recent Warnings

    private var warningsCard: some View {
        DashboardCard(title: "Recent warnings", icon: "exclamationmark.triangle", color: DesignTokens.statusWarn)
        {
            if clusterState.warningEvents.isEmpty {
                Text("No recent warnings")
                    .typeStyle(DesignTokens.Typography.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(clusterState.warningEvents.prefix(5)) { event in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(event.reason ?? "Warning")
                                .scaledFont(size: 11, weight: .semibold)
                                .foregroundStyle(DesignTokens.statusWarn)
                                .frame(width: 110, alignment: .leading)
                                .lineLimit(1)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(verbatim: eventObjectLabel(event))
                                    .scaledFont(size: 11, design: .monospaced)
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text(event.message ?? "")
                                    .scaledFont(size: 11)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            Spacer(minLength: 0)
                            if let count = event.count, count > 1 {
                                Text(verbatim: "×\(count)")
                                    .scaledFont(size: 10, design: .monospaced, relativeTo: .caption)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }

    private func eventObjectLabel(_ event: EventInfo) -> String {
        guard let name = event.objectName else { return event.namespace }
        let kind = event.objectKind.map { "\($0)/" } ?? ""
        return "\(kind)\(name)"
    }

    // MARK: - Resource Grid

    private var resourceGrid: some View {
            LazyVGrid(
                columns: [
                    GridItem(.flexible(), spacing: 16),
                    GridItem(.flexible(), spacing: 16),
                ],
                spacing: 16
            ) {
                // Card 1: Pods Overview
                DashboardCard(
                    title: "Pods",
                    icon: "cube.box",
                    color: DesignTokens.clusterBlue
                ) {
                    if clusterState.forbiddenResources.contains("pods") {
                        forbiddenBadge
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            DashboardMetric(
                                label: "Total",
                                value: "\(clusterState.pods.count)"
                            )
                            DashboardMetric(
                                label: "Running",
                                value:
                                    "\(clusterState.pods.filter { $0.phase == "Running" }.count)",
                                color: DesignTokens.statusOk
                            )
                            DashboardMetric(
                                label: "Pending",
                                value:
                                    "\(clusterState.pods.filter { $0.phase == "Pending" }.count)",
                                color: DesignTokens.statusWarn
                            )
                            DashboardMetric(
                                label: "Failed",
                                value:
                                    "\(clusterState.pods.filter { $0.phase == "Failed" }.count)",
                                color: DesignTokens.statusErr
                            )
                        }
                    }
                }

                // Card 2: Deployments Overview
                DashboardCard(
                    title: "Deployments",
                    icon: "arrow.triangle.2.circlepath",
                    color: DesignTokens.clusterViolet
                ) {
                    if clusterState.forbiddenResources.contains("deployments") {
                        forbiddenBadge
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            DashboardMetric(
                                label: "Total",
                                value: "\(clusterState.deployments.count)"
                            )
                            DashboardMetric(
                                label: "Healthy",
                                value:
                                    "\(clusterState.deployments.filter { $0.readyReplicas == $0.replicas }.count)",
                                color: DesignTokens.statusOk
                            )
                            DashboardMetric(
                                label: "Degraded",
                                value:
                                    "\(clusterState.deployments.filter { $0.readyReplicas != $0.replicas }.count)",
                                color: DesignTokens.statusWarn
                            )
                        }
                    }
                }

                // Card 3: Services Overview
                DashboardCard(
                    title: "Services",
                    icon: "network",
                    color: DesignTokens.clusterPink
                ) {
                    if clusterState.forbiddenResources.contains("services") {
                        forbiddenBadge
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            DashboardMetric(
                                label: "Total",
                                value: "\(clusterState.services.count)"
                            )
                            DashboardMetric(
                                label: "ClusterIP",
                                value:
                                    "\(clusterState.services.filter { $0.type == "ClusterIP" }.count)",
                                color: .secondary
                            )
                            DashboardMetric(
                                label: "NodePort",
                                value:
                                    "\(clusterState.services.filter { $0.type == "NodePort" }.count)",
                                color: DesignTokens.clusterAmber
                            )
                            DashboardMetric(
                                label: "LoadBalancer",
                                value:
                                    "\(clusterState.services.filter { $0.type == "LoadBalancer" }.count)",
                                color: DesignTokens.clusterBlue
                            )
                        }
                    }
                }

                // Card 4: Namespaces
                DashboardCard(
                    title: "Namespaces",
                    icon: "folder",
                    color: DesignTokens.clusterTeal
                ) {
                    VStack(alignment: .leading, spacing: 8) {
                        DashboardMetric(
                            label: "Total",
                            value: "\(clusterState.namespaces.count)"
                        )
                        DashboardMetric(
                            label: "Active",
                            value:
                                "\(clusterState.namespaces.filter { $0.phase == "Active" }.count)",
                            color: DesignTokens.statusOk
                        )
                    }
                }

                // Card 5: Secrets
                DashboardCard(
                    title: "Secrets",
                    icon: "lock.shield",
                    color: DesignTokens.clusterAmber
                ) {
                    if clusterState.forbiddenResources.contains("secrets") {
                        forbiddenBadge
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            DashboardMetric(
                                label: "Total",
                                value: "\(clusterState.secrets.count)"
                            )
                            DashboardMetric(
                                label: "Opaque",
                                value:
                                    "\(clusterState.secrets.filter { $0.type == "Opaque" }.count)",
                                color: .secondary
                            )
                            DashboardMetric(
                                label: "TLS",
                                value:
                                    "\(clusterState.secrets.filter { $0.type == "kubernetes.io/tls" }.count)",
                                color: DesignTokens.clusterBlue
                            )
                            DashboardMetric(
                                label: "Docker",
                                value:
                                    "\(clusterState.secrets.filter { $0.type == "kubernetes.io/dockerconfigjson" }.count)",
                                color: DesignTokens.clusterAmber
                            )
                        }
                    }
                }

                // Card 6: ConfigMaps
                DashboardCard(
                    title: "ConfigMaps",
                    icon: "doc.text",
                    color: .mint
                ) {
                    if clusterState.forbiddenResources.contains("configmaps") {
                        forbiddenBadge
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            DashboardMetric(
                                label: "Total",
                                value: "\(clusterState.configMaps.count)"
                            )
                        }
                    }
                }

                // Card: Ingresses
                DashboardCard(
                    title: "Ingresses",
                    icon: "globe",
                    color: .cyan
                ) {
                    if clusterState.forbiddenResources.contains("ingresses") {
                        forbiddenBadge
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            DashboardMetric(
                                label: "Total",
                                value: "\(clusterState.ingresses.count)"
                            )
                            DashboardMetric(
                                label: "TLS",
                                value:
                                    "\(clusterState.ingresses.filter { $0.tlsEnabled }.count)",
                                color: DesignTokens.statusOk
                            )
                        }
                    }
                }

                // Card: Helm Releases
                DashboardCard(
                    title: "Helm Releases",
                    icon: "shippingbox",
                    color: DesignTokens.clusterAmber
                ) {
                    if clusterState.forbiddenResources.contains("helmreleases") {
                        forbiddenBadge
                    } else {
                        let deployed = clusterState.helmReleases.filter {
                            $0.status == "deployed"
                        }
                        .count
                        let failed = clusterState.helmReleases.filter { $0.status == "failed" }
                            .count
                        VStack(alignment: .leading, spacing: 8) {
                            DashboardMetric(
                                label: "Total",
                                value: "\(clusterState.helmReleases.count)"
                            )
                            DashboardMetric(
                                label: "Deployed",
                                value: "\(deployed)",
                                color: DesignTokens.statusOk
                            )
                            DashboardMetric(
                                label: "Failed",
                                value: "\(failed)",
                                color: DesignTokens.statusErr
                            )
                        }
                    }
                }

                // Card 7: Cluster Health
                DashboardCard(
                    title: "Cluster",
                    icon: "server.rack",
                    color: clusterState.clusterReachable == true ? DesignTokens.statusOk : DesignTokens.statusErr
                ) {
                    VStack(alignment: .leading, spacing: 8) {
                        DashboardMetric(
                            label: "Status",
                            value: clusterState.clusterReachable == true
                                ? "Connected" : "Unreachable",
                            color: clusterState.clusterReachable == true ? DesignTokens.statusOk : DesignTokens.statusErr
                        )
                        DashboardMetric(
                            label: "Restarts",
                            value: "\(clusterState.pods.reduce(0) { $0 + $1.restarts })"
                        )
                        if clusterState.pods.contains(where: { !$0.ready }) {
                            DashboardMetric(
                                label: "Not Ready",
                                value: "\(clusterState.pods.filter { !$0.ready }.count)",
                                color: DesignTokens.statusWarn
                            )
                        }
                    }
                }
            }
    }

    /// "No access" overlay shown when RBAC forbids a resource type.
    private var forbiddenBadge: some View {
        VStack(spacing: 6) {
            Image(systemName: "lock.slash")
                .iconSize(DesignTokens.iconLg)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text("No access")
                .typeStyle(DesignTokens.Typography.caption)
                .foregroundStyle(.secondary)
            Text("RBAC restricted")
                .typeStyle(DesignTokens.Typography.micro)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
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
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .iconSize(DesignTokens.iconLg, weight: .semibold)
                    .foregroundStyle(color)
                    .accessibilityHidden(true)
                Text(title)
                    .typeStyle(DesignTokens.Typography.subtitle)
            }
            Divider()
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .windowBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.secondary.opacity(0.2), lineWidth: 1)
        )
    }
}

// MARK: - Dashboard Metric Row

/// A single metric label/value pair in a dashboard card.
struct DashboardMetric: View {

    let label: String
    let value: String
    var color: Color = .primary

    var body: some View {
        HStack {
            Text(label)
                .typeStyle(DesignTokens.Typography.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .typeStyle(DesignTokens.Typography.dataSm.weighted(.medium))
                .foregroundStyle(color)
        }
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
    return OverviewView()
        .environment(state)
        .frame(width: 600, height: 500)
}
