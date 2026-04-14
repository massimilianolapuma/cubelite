import Foundation

// MARK: - Domain Models

/// Information about a Kubernetes pod.
struct PodInfo: Codable, Sendable, Identifiable {
    var id: String { "\(namespace)/\(name)" }

    let name: String
    let namespace: String
    let phase: String?
    let ready: Bool
    let restarts: Int
    /// ISO 8601 creation timestamp, used to compute pod age.
    let creationTimestamp: String?
    /// Name of the node running this pod.
    var nodeName: String?
    /// Primary IP address assigned to the pod.
    var podIP: String?
    /// CPU resource request from the first container (e.g. `"100m"`).
    var cpuRequest: String?
    /// Memory resource request from the first container (e.g. `"128Mi"`).
    var memoryRequest: String?

    /// Creates a ``PodInfo`` with the given values.
    ///
    /// The `nodeName`, `podIP`, `cpuRequest`, and `memoryRequest` parameters default to `nil`
    /// so that existing call sites that predate those fields continue to compile without changes.
    init(
        name: String,
        namespace: String,
        phase: String?,
        ready: Bool,
        restarts: Int,
        creationTimestamp: String?,
        nodeName: String? = nil,
        podIP: String? = nil,
        cpuRequest: String? = nil,
        memoryRequest: String? = nil
    ) {
        self.name = name
        self.namespace = namespace
        self.phase = phase
        self.ready = ready
        self.restarts = restarts
        self.creationTimestamp = creationTimestamp
        self.nodeName = nodeName
        self.podIP = podIP
        self.cpuRequest = cpuRequest
        self.memoryRequest = memoryRequest
    }
}

/// Information about a Kubernetes namespace.
struct NamespaceInfo: Codable, Sendable, Identifiable {
    var id: String { name }

    let name: String
    let phase: String?
}

/// Information about a Kubernetes deployment.
struct DeploymentInfo: Codable, Sendable, Identifiable {
    var id: String { "\(namespace)/\(name)" }

    let name: String
    let namespace: String
    let replicas: Int
    let readyReplicas: Int
}

// MARK: - Kubernetes API Response Types

/// Generic list response from the Kubernetes API.
struct K8sListResponse<T: Codable & Sendable>: Codable, Sendable {
    let kind: String?
    let apiVersion: String?
    let items: [T]
}

/// Raw Kubernetes pod as returned by the API.
struct K8sPod: Codable, Sendable {
    let metadata: K8sObjectMeta?
    let spec: K8sPodSpec?
    let status: K8sPodStatus?

    init(
        metadata: K8sObjectMeta? = nil,
        spec: K8sPodSpec? = nil,
        status: K8sPodStatus? = nil
    ) {
        self.metadata = metadata
        self.spec = spec
        self.status = status
    }
}

/// Pod status from the Kubernetes API.
struct K8sPodStatus: Codable, Sendable {
    let phase: String?
    let podIP: String?
    let hostIP: String?
    let containerStatuses: [K8sContainerStatus]?

    init(
        phase: String? = nil,
        podIP: String? = nil,
        hostIP: String? = nil,
        containerStatuses: [K8sContainerStatus]? = nil
    ) {
        self.phase = phase
        self.podIP = podIP
        self.hostIP = hostIP
        self.containerStatuses = containerStatuses
    }
}

/// Container status within a pod.
struct K8sContainerStatus: Codable, Sendable {
    let ready: Bool?
    let restartCount: Int?
}

/// Pod spec from the Kubernetes API.
struct K8sPodSpec: Codable, Sendable {
    let nodeName: String?
    let containers: [K8sContainer]?
}

/// Container definition within a pod spec.
struct K8sContainer: Codable, Sendable {
    let resources: K8sResourceRequirements?
}

/// Resource requirements (requests and limits) for a container.
struct K8sResourceRequirements: Codable, Sendable {
    let requests: [String: String]?
}

/// Raw Kubernetes namespace as returned by the API.
struct K8sNamespace: Codable, Sendable {
    let metadata: K8sObjectMeta?
    let status: K8sNamespaceStatus?
}

/// Namespace status from the Kubernetes API.
struct K8sNamespaceStatus: Codable, Sendable {
    let phase: String?
}

/// Raw Kubernetes deployment as returned by the API.
struct K8sDeployment: Codable, Sendable {
    let metadata: K8sObjectMeta?
    let spec: K8sDeploymentSpec?
    let status: K8sDeploymentStatus?
}

/// Deployment spec from the Kubernetes API.
struct K8sDeploymentSpec: Codable, Sendable {
    let replicas: Int?
}

/// Deployment status from the Kubernetes API.
struct K8sDeploymentStatus: Codable, Sendable {
    let readyReplicas: Int?
}

/// Shared metadata for Kubernetes objects.
struct K8sObjectMeta: Codable, Sendable {
    let name: String?
    let namespace: String?
    let creationTimestamp: String?
}

// MARK: - Mapping Extensions

extension K8sPod {
    /// Converts a raw Kubernetes pod to a ``PodInfo`` domain model.
    func toPodInfo() -> PodInfo {
        let containerStatuses = status?.containerStatuses ?? []
        let allReady = !containerStatuses.isEmpty && containerStatuses.allSatisfy { $0.ready == true }
        let totalRestarts = containerStatuses.reduce(0) { $0 + ($1.restartCount ?? 0) }
        let firstContainer = spec?.containers?.first
        return PodInfo(
            name: metadata?.name ?? "",
            namespace: metadata?.namespace ?? "",
            phase: status?.phase,
            ready: allReady,
            restarts: totalRestarts,
            creationTimestamp: metadata?.creationTimestamp,
            nodeName: spec?.nodeName,
            podIP: status?.podIP,
            cpuRequest: firstContainer?.resources?.requests?["cpu"],
            memoryRequest: firstContainer?.resources?.requests?["memory"]
        )
    }
}

extension K8sNamespace {
    /// Converts a raw Kubernetes namespace to a ``NamespaceInfo`` domain model.
    func toNamespaceInfo() -> NamespaceInfo {
        NamespaceInfo(
            name: metadata?.name ?? "",
            phase: status?.phase
        )
    }
}

extension K8sDeployment {
    /// Converts a raw Kubernetes deployment to a ``DeploymentInfo`` domain model.
    func toDeploymentInfo() -> DeploymentInfo {
        DeploymentInfo(
            name: metadata?.name ?? "",
            namespace: metadata?.namespace ?? "",
            replicas: spec?.replicas ?? 0,
            readyReplicas: status?.readyReplicas ?? 0
        )
    }
}
