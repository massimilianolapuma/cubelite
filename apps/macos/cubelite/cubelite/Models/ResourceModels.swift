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
    /// Key-value labels attached to the object.
    let labels: [String: String]?

    init(
        name: String? = nil,
        namespace: String? = nil,
        creationTimestamp: String? = nil,
        labels: [String: String]? = nil
    ) {
        self.name = name
        self.namespace = namespace
        self.creationTimestamp = creationTimestamp
        self.labels = labels
    }
}

// MARK: - Mapping Extensions

extension K8sPod {
    /// Converts a raw Kubernetes pod to a ``PodInfo`` domain model.
    func toPodInfo() -> PodInfo {
        let containerStatuses = status?.containerStatuses ?? []
        let allReady =
            !containerStatuses.isEmpty && containerStatuses.allSatisfy { $0.ready == true }
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

// MARK: - Service API Types

/// Raw Kubernetes service as returned by the API.
struct K8sService: Codable, Sendable {
    let metadata: K8sObjectMeta?
    let spec: K8sServiceSpec?
}

/// Service spec from the Kubernetes API.
struct K8sServiceSpec: Codable, Sendable {
    let type: String?
    let clusterIP: String?
    let ports: [K8sServicePort]?
    let selector: [String: String]?
    let externalIPs: [String]?
    let loadBalancerIP: String?
}

/// A port mapping defined in a Kubernetes service.
struct K8sServicePort: Codable, Sendable {
    let name: String?
    let port: Int
    let targetPort: K8sIntOrString?
    let nodePort: Int?
    /// Uses a backtick-escaped name because `protocol` is a Swift keyword.
    let `protocol`: String?

    enum CodingKeys: String, CodingKey {
        case name, port, targetPort, nodePort
        case `protocol` = "protocol"
    }
}

/// Handles Kubernetes `targetPort`, which can be an integer or a named port string.
enum K8sIntOrString: Codable, Sendable {
    case int(Int)
    case string(String)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let intVal = try? container.decode(Int.self) {
            self = .int(intVal)
        } else if let strVal = try? container.decode(String.self) {
            self = .string(strVal)
        } else {
            throw DecodingError.typeMismatch(
                K8sIntOrString.self,
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "Expected Int or String"
                )
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .int(let v): try container.encode(v)
        case .string(let v): try container.encode(v)
        }
    }

    /// Human-readable representation used in the Ports column.
    var description: String {
        switch self {
        case .int(let v): "\(v)"
        case .string(let v): v
        }
    }
}

// MARK: - Service Domain Model

/// Information about a Kubernetes service.
struct ServiceInfo: Codable, Sendable, Identifiable {
    var id: String { "\(namespace)/\(name)" }

    let name: String
    let namespace: String
    /// Service type: ClusterIP, NodePort, LoadBalancer, or ExternalName.
    let type: String?
    let clusterIP: String?
    /// Formatted port mappings, e.g. `"80:8080/TCP, 443:8443/TCP"`.
    let ports: String?
    let externalIP: String?
    /// ISO 8601 creation timestamp used to compute service age.
    let creationTimestamp: String?
}

extension K8sService {
    /// Converts a raw Kubernetes service to a ``ServiceInfo`` domain model.
    func toServiceInfo() -> ServiceInfo {
        let portsStr = spec?.ports?.map { p in
            var s = "\(p.port)"
            if let tp = p.targetPort { s += ":\(tp.description)" }
            if let proto = p.protocol { s += "/\(proto)" }
            return s
        }.joined(separator: ", ")

        let extIP = spec?.externalIPs?.first ?? spec?.loadBalancerIP

        return ServiceInfo(
            name: metadata?.name ?? "",
            namespace: metadata?.namespace ?? "default",
            type: spec?.type,
            clusterIP: spec?.clusterIP,
            ports: portsStr,
            externalIP: extIP,
            creationTimestamp: metadata?.creationTimestamp
        )
    }
}

// MARK: - Secret API Types

/// Raw Kubernetes secret as returned by the API.
///
/// - Important: Only the key count from `data` is forwarded to the domain model.
///   Actual secret values are never stored or surfaced in the UI.
struct K8sSecret: Codable, Sendable {
    let metadata: K8sObjectMeta?
    /// Secret type, e.g. `"Opaque"`, `"kubernetes.io/tls"`.
    let type: String?
    /// Base64-encoded key-value pairs. Values are intentionally ignored — only
    /// the count is used to build ``SecretInfo``.
    let data: [String: String]?
}

// MARK: - Secret Domain Model

/// Information about a Kubernetes secret.
///
/// - Important: This model deliberately omits the actual secret values.
///   Only the number of keys (`dataCount`) is exposed to protect sensitive data.
struct SecretInfo: Codable, Sendable, Identifiable {
    var id: String { "\(namespace)/\(name)" }

    let name: String
    let namespace: String
    /// Secret type, e.g. `"Opaque"`, `"kubernetes.io/tls"`.
    let type: String?
    /// Number of data keys in this secret — the actual values are never stored.
    let dataCount: Int
    /// ISO 8601 creation timestamp, used to compute age.
    let creationTimestamp: String?
}

extension K8sSecret {
    /// Converts a raw Kubernetes secret to a ``SecretInfo`` domain model.
    ///
    /// - Important: Only the key count from `data` is forwarded. Values are discarded.
    func toSecretInfo() -> SecretInfo {
        SecretInfo(
            name: metadata?.name ?? "",
            namespace: metadata?.namespace ?? "default",
            type: type,
            dataCount: data?.count ?? 0,
            creationTimestamp: metadata?.creationTimestamp
        )
    }
}

// MARK: - ConfigMap API Types

/// Raw Kubernetes ConfigMap as returned by the API.
struct K8sConfigMap: Codable, Sendable {
    let metadata: K8sObjectMeta?
    /// Key-value configuration data.
    let data: [String: String]?
}

// MARK: - ConfigMap Domain Model

/// Information about a Kubernetes ConfigMap.
struct ConfigMapInfo: Codable, Sendable, Identifiable {
    var id: String { "\(namespace)/\(name)" }

    let name: String
    let namespace: String
    /// Number of data keys in this ConfigMap.
    let dataCount: Int
    /// ISO 8601 creation timestamp, used to compute age.
    let creationTimestamp: String?
}

extension K8sConfigMap {
    /// Converts a raw Kubernetes ConfigMap to a ``ConfigMapInfo`` domain model.
    func toConfigMapInfo() -> ConfigMapInfo {
        ConfigMapInfo(
            name: metadata?.name ?? "",
            namespace: metadata?.namespace ?? "default",
            dataCount: data?.count ?? 0,
            creationTimestamp: metadata?.creationTimestamp
        )
    }
}

// MARK: - Ingress API Types

/// Raw Kubernetes Ingress as returned by the API.
struct K8sIngress: Codable, Sendable {
    let metadata: K8sObjectMeta?
    let spec: K8sIngressSpec?
    let status: K8sIngressStatus?
}

/// Ingress spec from the Kubernetes API.
struct K8sIngressSpec: Codable, Sendable {
    let ingressClassName: String?
    let rules: [K8sIngressRule]?
    let tls: [K8sIngressTLS]?
}

/// A routing rule in an Ingress spec.
struct K8sIngressRule: Codable, Sendable {
    let host: String?
    let http: K8sIngressHTTP?
}

/// HTTP routing config within an Ingress rule.
struct K8sIngressHTTP: Codable, Sendable {
    let paths: [K8sIngressPath]?
}

/// A path entry within an Ingress HTTP rule.
struct K8sIngressPath: Codable, Sendable {
    let path: String?
    let pathType: String?
    let backend: K8sIngressBackend?
}

/// Backend service reference in an Ingress path.
struct K8sIngressBackend: Codable, Sendable {
    let service: K8sIngressBackendService?
}

/// Named service backend for an Ingress path.
struct K8sIngressBackendService: Codable, Sendable {
    let name: String?
    let port: K8sIngressBackendPort?
}

/// Port reference within an Ingress backend service.
struct K8sIngressBackendPort: Codable, Sendable {
    let number: Int?
    let name: String?
}

/// TLS configuration block in an Ingress spec.
struct K8sIngressTLS: Codable, Sendable {
    let hosts: [String]?
    let secretName: String?
}

/// Ingress status from the Kubernetes API.
struct K8sIngressStatus: Codable, Sendable {
    let loadBalancer: K8sLoadBalancerStatus?
}

/// Load balancer status containing assigned IPs or hostnames.
struct K8sLoadBalancerStatus: Codable, Sendable {
    let ingress: [K8sLoadBalancerIngress]?
}

/// A single load balancer entry with an IP or hostname.
struct K8sLoadBalancerIngress: Codable, Sendable {
    let ip: String?
    let hostname: String?
}

// MARK: - Ingress Domain Model

/// Information about a Kubernetes Ingress.
struct IngressInfo: Codable, Sendable, Identifiable {
    var id: String { "\(namespace)/\(name)" }

    let name: String
    let namespace: String
    /// Ingress class name, e.g. `"nginx"` or `"alb"`.
    let ingressClass: String?
    /// Comma-separated list of hostnames from the Ingress rules.
    let hosts: String?
    /// Load balancer IP or hostname assigned by the cloud provider.
    let address: String?
    /// Whether TLS is configured for this Ingress.
    let tlsEnabled: Bool
    /// ISO 8601 creation timestamp, used to compute age.
    let creationTimestamp: String?
}

extension K8sIngress {
    /// Converts a raw Kubernetes Ingress to an ``IngressInfo`` domain model.
    func toIngressInfo() -> IngressInfo {
        let hosts = spec?.rules?
            .compactMap { $0.host }
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
        let lbIngress = status?.loadBalancer?.ingress?.first
        let address = lbIngress?.ip ?? lbIngress?.hostname
        let tlsEnabled = !(spec?.tls?.isEmpty ?? true)
        return IngressInfo(
            name: metadata?.name ?? "",
            namespace: metadata?.namespace ?? "default",
            ingressClass: spec?.ingressClassName,
            hosts: hosts.flatMap { $0.isEmpty ? nil : $0 },
            address: address,
            tlsEnabled: tlsEnabled,
            creationTimestamp: metadata?.creationTimestamp
        )
    }
}

// MARK: - Helm Release Domain Model

/// Information about a Helm release, extracted from Helm-managed Kubernetes secrets.
struct HelmReleaseInfo: Codable, Sendable, Identifiable {
    var id: String { "\(namespace)/\(name)" }

    let name: String
    let namespace: String
    let chart: String?
    let appVersion: String?
    let revision: Int
    let status: String?
    /// ISO 8601 creation timestamp, used to compute release age.
    let creationTimestamp: String?
}

extension K8sSecret {
    /// Whether this secret represents a Helm release.
    var isHelmRelease: Bool {
        metadata?.labels?["owner"] == "helm"
    }

    /// Converts a Helm-managed secret to a ``HelmReleaseInfo``.
    ///
    /// Returns `nil` if this secret is not a Helm release.
    func toHelmReleaseInfo() -> HelmReleaseInfo? {
        guard isHelmRelease else { return nil }
        let labels = metadata?.labels ?? [:]
        let releaseName = labels["name"] ?? metadata?.name ?? ""
        let revision = Int(labels["version"] ?? "0") ?? 0
        let status = labels["status"]
        return HelmReleaseInfo(
            name: releaseName,
            namespace: metadata?.namespace ?? "default",
            chart: nil,
            appVersion: nil,
            revision: revision,
            status: status,
            creationTimestamp: metadata?.creationTimestamp
        )
    }
}

// MARK: - Collection Helpers

extension Array {
    /// Returns `nil` when the array is empty, otherwise returns `self`.
    fileprivate var nilIfEmpty: Self? { isEmpty ? nil : self }
}
