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
    let status: K8sPodStatus?
}

/// Pod status from the Kubernetes API.
struct K8sPodStatus: Codable, Sendable {
    let phase: String?
    let containerStatuses: [K8sContainerStatus]?
}

/// Container status within a pod.
struct K8sContainerStatus: Codable, Sendable {
    let ready: Bool?
    let restartCount: Int?
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
}

// MARK: - Mapping Extensions

extension K8sPod {
    /// Converts a raw Kubernetes pod to a ``PodInfo`` domain model.
    func toPodInfo() -> PodInfo {
        let containers = status?.containerStatuses ?? []
        let allReady = !containers.isEmpty && containers.allSatisfy { $0.ready == true }
        let totalRestarts = containers.reduce(0) { $0 + ($1.restartCount ?? 0) }
        return PodInfo(
            name: metadata?.name ?? "",
            namespace: metadata?.namespace ?? "",
            phase: status?.phase,
            ready: allReady,
            restarts: totalRestarts
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
