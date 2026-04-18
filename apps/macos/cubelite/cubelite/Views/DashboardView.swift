import SwiftUI

/// Dashboard overview for the selected cluster/namespace.
///
/// Displays summary cards with key cluster metrics: pod counts by status,
/// deployment health, namespace overview, and resource utilization.
struct DashboardView: View {

    @Environment(ClusterState.self) private var clusterState

    var body: some View {
        ScrollView {
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
                    color: .blue
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
                                color: .green
                            )
                            DashboardMetric(
                                label: "Pending",
                                value:
                                    "\(clusterState.pods.filter { $0.phase == "Pending" }.count)",
                                color: .orange
                            )
                            DashboardMetric(
                                label: "Failed",
                                value:
                                    "\(clusterState.pods.filter { $0.phase == "Failed" }.count)",
                                color: .red
                            )
                        }
                    }
                }

                // Card 2: Deployments Overview
                DashboardCard(
                    title: "Deployments",
                    icon: "arrow.triangle.2.circlepath",
                    color: .purple
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
                                color: .green
                            )
                            DashboardMetric(
                                label: "Degraded",
                                value:
                                    "\(clusterState.deployments.filter { $0.readyReplicas != $0.replicas }.count)",
                                color: .orange
                            )
                        }
                    }
                }

                // Card 3: Services Overview
                DashboardCard(
                    title: "Services",
                    icon: "network",
                    color: .indigo
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
                                color: .orange
                            )
                            DashboardMetric(
                                label: "LoadBalancer",
                                value:
                                    "\(clusterState.services.filter { $0.type == "LoadBalancer" }.count)",
                                color: .blue
                            )
                        }
                    }
                }

                // Card 4: Namespaces
                DashboardCard(
                    title: "Namespaces",
                    icon: "folder",
                    color: .teal
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
                            color: .green
                        )
                    }
                }

                // Card 5: Secrets
                DashboardCard(
                    title: "Secrets",
                    icon: "lock.shield",
                    color: .yellow
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
                                color: .blue
                            )
                            DashboardMetric(
                                label: "Docker",
                                value:
                                    "\(clusterState.secrets.filter { $0.type == "kubernetes.io/dockerconfigjson" }.count)",
                                color: .orange
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
                                color: .green
                            )
                        }
                    }
                }

                // Card: Helm Releases
                DashboardCard(
                    title: "Helm Releases",
                    icon: "shippingbox",
                    color: .orange
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
                                color: .green
                            )
                            DashboardMetric(
                                label: "Failed",
                                value: "\(failed)",
                                color: .red
                            )
                        }
                    }
                }

                // Card 7: Cluster Health
                DashboardCard(
                    title: "Cluster",
                    icon: "server.rack",
                    color: clusterState.clusterReachable == true ? .green : .red
                ) {
                    VStack(alignment: .leading, spacing: 8) {
                        DashboardMetric(
                            label: "Status",
                            value: clusterState.clusterReachable == true
                                ? "Connected" : "Unreachable",
                            color: clusterState.clusterReachable == true ? .green : .red
                        )
                        DashboardMetric(
                            label: "Restarts",
                            value: "\(clusterState.pods.reduce(0) { $0 + $1.restarts })"
                        )
                        if clusterState.pods.contains(where: { !$0.ready }) {
                            DashboardMetric(
                                label: "Not Ready",
                                value: "\(clusterState.pods.filter { !$0.ready }.count)",
                                color: .orange
                            )
                        }
                    }
                }
            }
            .padding(20)
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    /// "No access" overlay shown when RBAC forbids a resource type.
    private var forbiddenBadge: some View {
        VStack(spacing: 6) {
            Image(systemName: "lock.slash")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("No access")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("RBAC restricted")
                .font(.caption2)
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
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(color)
                Text(title)
                    .font(.headline)
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
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.subheadline.monospacedDigit())
                .fontWeight(.medium)
                .foregroundStyle(color)
        }
    }
}

// MARK: - Preview

#Preview("Dashboard") {
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
    return DashboardView()
        .environment(state)
        .frame(width: 600, height: 500)
}
