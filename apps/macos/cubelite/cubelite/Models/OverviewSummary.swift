import Foundation

/// Overview counts (parity v2 §4). Pure, so the macOS app and the desktop
/// (`apps/desktop/src/lib/overview-summary.ts`) count identically; keep the
/// two in step. Shares its test fixture with `overview-summary.test.ts`.
struct OverviewSummary: Equatable, Sendable {

    struct Pods: Equatable, Sendable {
        var total = 0
        var running = 0
        var pending = 0
        var failed = 0
    }

    struct Deployments: Equatable, Sendable {
        var total = 0
        var healthy = 0
        var degraded = 0
    }

    struct Namespaces: Equatable, Sendable {
        var total = 0
        var active = 0
    }

    struct Services: Equatable, Sendable {
        var total = 0
        var clusterIP = 0
        var nodePort = 0
        var loadBalancer = 0
    }

    struct Secrets: Equatable, Sendable {
        var total = 0
        var opaque = 0
        var tls = 0
        var docker = 0
    }

    struct Ingresses: Equatable, Sendable {
        var total = 0
        var tls = 0
    }

    struct Helm: Equatable, Sendable {
        var total = 0
        var deployed = 0
        var failed = 0
    }

    /// The resource lists to summarize.
    struct Input: Sendable {
        var pods: [PodInfo] = []
        var deployments: [DeploymentInfo] = []
        var namespaces: [NamespaceInfo] = []
        var services: [ServiceInfo] = []
        var secrets: [SecretInfo] = []
        var configMaps: [ConfigMapInfo] = []
        var ingresses: [IngressInfo] = []
        var helmReleases: [HelmReleaseInfo] = []
        /// Node inventory count, else metrics node count, else nil.
        var nodeCount: Int?
    }

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

    init(_ input: Input) {
        nodes = input.nodeCount
        let pods = input.pods
        self.pods = Pods(
            total: pods.count,
            running: pods.filter { $0.phase == "Running" }.count,
            pending: pods.filter { $0.phase == "Pending" }.count,
            failed: pods.filter { $0.phase == "Failed" }.count)
        let deployments = input.deployments
        let healthy = deployments.filter { $0.readyReplicas == $0.replicas }.count
        self.deployments = Deployments(
            total: deployments.count, healthy: healthy, degraded: deployments.count - healthy)
        self.namespaces = Namespaces(
            total: input.namespaces.count,
            active: input.namespaces.filter { $0.phase == "Active" }.count)
        let services = input.services
        self.services = Services(
            total: services.count,
            clusterIP: services.filter { $0.type == "ClusterIP" }.count,
            nodePort: services.filter { $0.type == "NodePort" }.count,
            loadBalancer: services.filter { $0.type == "LoadBalancer" }.count)
        let secrets = input.secrets
        self.secrets = Secrets(
            total: secrets.count,
            opaque: secrets.filter { $0.type == "Opaque" }.count,
            tls: secrets.filter { $0.type == "kubernetes.io/tls" }.count,
            docker: secrets.filter { $0.type == "kubernetes.io/dockerconfigjson" }.count)
        configMaps = input.configMaps.count
        ingresses = Ingresses(
            total: input.ingresses.count, tls: input.ingresses.filter { $0.tlsEnabled }.count)
        let helm = input.helmReleases
        self.helm = Helm(
            total: helm.count,
            deployed: helm.filter { $0.status == "deployed" }.count,
            failed: helm.filter { $0.status == "failed" }.count)
    }

    /// Summary of what `state` currently holds.
    @MainActor
    init(state: ClusterState) {
        let nodeCount: Int? =
            if !state.nodes.isEmpty { state.nodes.count }
            else if !state.nodeMetrics.isEmpty { state.nodeMetrics.count }
            else { nil }
        self.init(
            Input(
                pods: state.pods, deployments: state.deployments, namespaces: state.namespaces,
                services: state.services, secrets: state.secrets, configMaps: state.configMaps,
                ingresses: state.ingresses, helmReleases: state.helmReleases,
                nodeCount: nodeCount))
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
