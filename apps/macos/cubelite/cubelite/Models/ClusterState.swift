import Foundation
import Observation

/// Observable application state holding the current cluster context and resources.
@Observable
@MainActor
final class ClusterState {

    /// Available kubeconfig context names.
    var contexts: [String] = []

    /// Currently active context name.
    var currentContext: String?

    /// Pods in the selected namespace (or all namespaces).
    var pods: [PodInfo] = []

    /// Available namespaces for the currently browsed context.
    var namespaces: [NamespaceInfo] = []

    /// Deployments in the selected namespace.
    var deployments: [DeploymentInfo] = []

    /// Services in the selected namespace.
    var services: [ServiceInfo] = []

    /// Secrets in the selected namespace.
    var secrets: [SecretInfo] = []

    /// ConfigMaps in the selected namespace.
    var configMaps: [ConfigMapInfo] = []

    /// Ingresses in the selected namespace.
    var ingresses: [IngressInfo] = []

    /// Helm releases in the selected namespace.
    var helmReleases: [HelmReleaseInfo] = []

    /// Selected namespace filter (`nil` means all namespaces).
    var selectedNamespace: String?

    /// Whether kubeconfig is currently being loaded.
    var isLoading = false

    /// Whether K8s resources (pods/deployments) are being fetched.
    var isLoadingResources = false

    /// Whether no kubeconfig file was found at any of the searched paths.
    /// When `true`, the app is healthy but has no cluster configuration yet.
    var noConfig = false

    /// Last kubeconfig load error message, if any.
    var errorMessage: String?

    /// Last resource fetch error message, if any.
    var resourceError: String?

    /// Pod count keyed by namespace name, derived from the most recent pod fetch.
    var namespacePodCounts: [String: Int] = [:]

    /// Whether the active cluster's API server is reachable.
    /// `nil` means not yet checked, `true` = connected, `false` = unreachable.
    var clusterReachable: Bool?

    /// Resource types that returned HTTP 403 (Forbidden) during the last fetch.
    ///
    /// Populated when RBAC denies access to specific resource types while others
    /// succeed. The dashboard uses this to show "No access" instead of zero counts.
    var forbiddenResources: Set<String> = []
}

// MARK: - Resource Type

/// Resource categories available in the browse pane.
enum ResourceType: String, CaseIterable, Identifiable {
    case dashboard = "Dashboard"
    case pods = "Pods"
    case deployments = "Deployments"
    case services = "Services"
    /// Kubernetes Secrets resource type.
    case secrets = "Secrets"
    /// Kubernetes ConfigMaps resource type.
    case configMaps = "ConfigMaps"
    /// Kubernetes Ingresses resource type.
    case ingresses = "Ingresses"
    /// Helm Releases resource type.
    case helmReleases = "Helm Releases"

    var id: String { rawValue }

    var systemImage: String {
        switch self {
        case .dashboard: "square.grid.2x2"
        case .pods: "cube.box"
        case .deployments: "arrow.triangle.2.circlepath"
        case .services: "network"
        case .secrets: "lock.shield"
        case .configMaps: "doc.text"
        case .ingresses: "globe"
        case .helmReleases: "shippingbox"
        }
    }
}
