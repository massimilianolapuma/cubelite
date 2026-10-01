import Foundation

/// Overview counts (parity v2 §4). Pure, so the macOS app and the desktop
/// (`apps/desktop/src/lib/overview-summary.ts`) count identically; keep the
/// two in step. Shares its test fixture with `overview-summary.test.ts`.
struct OverviewSummary: Equatable, Sendable {

    struct Pods: Equatable, Sendable { var total = 0, running = 0, pending = 0, failed = 0 }
    struct Deployments: Equatable, Sendable { var total = 0, healthy = 0, degraded = 0 }
    struct Namespaces: Equatable, Sendable { var total = 0, active = 0 }
    struct Services: Equatable, Sendable {
        var total = 0, clusterIP = 0, nodePort = 0, loadBalancer = 0
    }
    struct Secrets: Equatable, Sendable { var total = 0, opaque = 0, tls = 0, docker = 0 }
    struct Ingresses: Equatable, Sendable { var total = 0, tls = 0 }
    struct Helm: Equatable, Sendable { var total = 0, deployed = 0, failed = 0 }

    /// Node inventory count, else metrics node count, else nil (unknown).
    var nodes: Int?
    var pods = Pods()
    var deployments = Deployments()
    var namespaces = Namespaces()
    var services = Services()
    var secrets = Secrets()
    var configMaps = 0
    var ingresses = Ingresses()
    var helm = Helm()

    init(
        pods: [PodInfo],
        deployments: [DeploymentInfo],
        namespaces: [NamespaceInfo],
        services: [ServiceInfo],
        secrets: [SecretInfo],
        configMaps: [ConfigMapInfo],
        ingresses: [IngressInfo],
        helmReleases: [HelmReleaseInfo],
        nodeCount: Int?
    ) {
        nodes = nodeCount
        self.pods = Pods(
            total: pods.count,
            running: pods.filter { $0.phase == "Running" }.count,
            pending: pods.filter { $0.phase == "Pending" }.count,
            failed: pods.filter { $0.phase == "Failed" }.count)
        let healthy = deployments.filter { $0.readyReplicas == $0.replicas }.count
        self.deployments = Deployments(
            total: deployments.count, healthy: healthy, degraded: deployments.count - healthy)
        self.namespaces = Namespaces(
            total: namespaces.count, active: namespaces.filter { $0.phase == "Active" }.count)
        self.services = Services(
            total: services.count,
            clusterIP: services.filter { $0.type == "ClusterIP" }.count,
            nodePort: services.filter { $0.type == "NodePort" }.count,
            loadBalancer: services.filter { $0.type == "LoadBalancer" }.count)
        self.secrets = Secrets(
            total: secrets.count,
            opaque: secrets.filter { $0.type == "Opaque" }.count,
            tls: secrets.filter { $0.type == "kubernetes.io/tls" }.count,
            docker: secrets.filter { $0.type == "kubernetes.io/dockerconfigjson" }.count)
        self.configMaps = configMaps.count
        self.ingresses = Ingresses(total: ingresses.count, tls: ingresses.filter { $0.tlsEnabled }.count)
        self.helm = Helm(
            total: helmReleases.count,
            deployed: helmReleases.filter { $0.status == "deployed" }.count,
            failed: helmReleases.filter { $0.status == "failed" }.count)
    }

    /// Summary of what `state` currently holds.
    @MainActor
    init(state: ClusterState) {
        let nodeCount: Int? =
            if !state.nodes.isEmpty { state.nodes.count }
            else if !state.nodeMetrics.isEmpty { state.nodeMetrics.count }
            else { nil }
        self.init(
            pods: state.pods, deployments: state.deployments, namespaces: state.namespaces,
            services: state.services, secrets: state.secrets, configMaps: state.configMaps,
            ingresses: state.ingresses, helmReleases: state.helmReleases, nodeCount: nodeCount)
    }

    // MARK: - Capacity sub-labels

    /// `"1.2 / 4.0 cores"`; nil without allocatable CPU.
    static func coresDetail(_ capacity: ClusterCapacity) -> String? {
        guard capacity.cpuAllocatableCores > 0 else { return nil }
        return String(
            format: "%.1f / %.1f cores", capacity.cpuUsedCores, capacity.cpuAllocatableCores)
    }

    /// `"3.5 / 16.0 GiB"`; nil without allocatable memory.
    static func memoryDetail(_ capacity: ClusterCapacity) -> String? {
        guard capacity.memAllocatableBytes > 0 else { return nil }
        let gib = 1_073_741_824.0
        return String(
            format: "%.1f / %.1f GiB", capacity.memUsedBytes / gib,
            capacity.memAllocatableBytes / gib)
    }
}
