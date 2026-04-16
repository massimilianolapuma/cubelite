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
}

// MARK: - Resource Type

/// Resource categories available in the browse pane.
enum ResourceType: String, CaseIterable, Identifiable {
    case pods = "Pods"
    case deployments = "Deployments"

    var id: String { rawValue }

    var systemImage: String {
        switch self {
        case .pods: "cube.box"
        case .deployments: "arrow.triangle.2.circlepath"
        }
    }
}
