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

    /// Creates a ``PodInfo`` with core scheduling fields.
    ///
    /// The extended fields (`nodeName`, `podIP`, `cpuRequest`, `memoryRequest`) are `var`
    /// properties and default to `nil`; callers may set them after construction when the
    /// source data is available (e.g. from ``K8sPod/toPodInfo()``).
    init(
        name: String,
        namespace: String,
        phase: String?,
        ready: Bool,
        restarts: Int,
        creationTimestamp: String?
    ) {
        self.name = name
        self.namespace = namespace
        self.phase = phase
        self.ready = ready
        self.restarts = restarts
        self.creationTimestamp = creationTimestamp
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
    /// Deployment strategy type, e.g. "RollingUpdate" or "Recreate".
    let strategy: String?
    /// Label selector used to identify pods managed by this deployment.
    let selector: [String: String]?
    /// ISO 8601 creation timestamp, used to compute deployment age.
    let creationTimestamp: String?
    /// Conditions describing the current state of the deployment.
    let conditions: [DeploymentCondition]?
    /// Number of available replicas (ready for at least minReadySeconds).
    let availableReplicas: Int?
    /// Number of unavailable replicas.
    let unavailableReplicas: Int?

    /// Creates a `DeploymentInfo`. New optional fields default to `nil` so
    /// existing call sites that only supply the core four fields still compile.
    init(
        name: String,
        namespace: String,
        replicas: Int,
        readyReplicas: Int,
        strategy: String? = nil,
        selector: [String: String]? = nil,
        creationTimestamp: String? = nil,
        conditions: [DeploymentCondition]? = nil,
        availableReplicas: Int? = nil,
        unavailableReplicas: Int? = nil
    ) {
        self.name = name
        self.namespace = namespace
        self.replicas = replicas
        self.readyReplicas = readyReplicas
        self.strategy = strategy
        self.selector = selector
        self.creationTimestamp = creationTimestamp
        self.conditions = conditions
        self.availableReplicas = availableReplicas
        self.unavailableReplicas = unavailableReplicas
    }
}

/// A condition describing the health of a Kubernetes deployment.
struct DeploymentCondition: Codable, Sendable, Identifiable {
    /// Uses `type` as the stable identity since only one condition per type exists.
    var id: String { type }

    /// Condition type: "Available", "Progressing", or "ReplicaFailure".
    let type: String
    /// Condition status: "True", "False", or "Unknown".
    let status: String
    let reason: String?
    let message: String?
    let lastTransitionTime: String?
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
    let strategy: K8sDeploymentStrategy?
    let selector: K8sLabelSelector?
}

/// Deployment rolling-update strategy from the Kubernetes API.
struct K8sDeploymentStrategy: Codable, Sendable {
    let type: String?
}

/// Label selector from the Kubernetes API.
struct K8sLabelSelector: Codable, Sendable {
    let matchLabels: [String: String]?
}

/// Deployment status from the Kubernetes API.
struct K8sDeploymentStatus: Codable, Sendable {
    let readyReplicas: Int?
    let availableReplicas: Int?
    let unavailableReplicas: Int?
    let conditions: [K8sDeploymentCondition]?
}

/// A deployment condition as returned by the Kubernetes API.
struct K8sDeploymentCondition: Codable, Sendable {
    let type: String?
    let status: String?
    let reason: String?
    let message: String?
    let lastTransitionTime: String?
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
        var info = PodInfo(
            name: metadata?.name ?? "",
            namespace: metadata?.namespace ?? "",
            phase: status?.phase,
            ready: allReady,
            restarts: totalRestarts,
            creationTimestamp: metadata?.creationTimestamp
        )
        info.nodeName = spec?.nodeName
        info.podIP = status?.podIP
        info.cpuRequest = firstContainer?.resources?.requests?["cpu"]
        info.memoryRequest = firstContainer?.resources?.requests?["memory"]
        return info
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
        let conditions: [DeploymentCondition]? = status?.conditions?
            .compactMap { c in
                guard let type = c.type, let condStatus = c.status else { return nil }
                return DeploymentCondition(
                    type: type,
                    status: condStatus,
                    reason: c.reason,
                    message: c.message,
                    lastTransitionTime: c.lastTransitionTime
                )
            }
            .nilIfEmpty
        return DeploymentInfo(
            name: metadata?.name ?? "",
            namespace: metadata?.namespace ?? "",
            replicas: spec?.replicas ?? 0,
            readyReplicas: status?.readyReplicas ?? 0,
            strategy: spec?.strategy?.type,
            selector: spec?.selector?.matchLabels,
            creationTimestamp: metadata?.creationTimestamp,
            conditions: conditions,
            availableReplicas: status?.availableReplicas,
            unavailableReplicas: status?.unavailableReplicas
        )
    }
}

// MARK: - Collection Helpers

private extension Array {
    /// Returns `nil` when the array is empty, otherwise returns `self`.
    var nilIfEmpty: Self? { isEmpty ? nil : self }
}
