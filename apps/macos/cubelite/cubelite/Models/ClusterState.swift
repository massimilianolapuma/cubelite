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

    /// Available namespaces.
    var namespaces: [NamespaceInfo] = []

    /// Deployments in the selected namespace.
    var deployments: [DeploymentInfo] = []

    /// Selected namespace filter (`nil` means all namespaces).
    var selectedNamespace: String?

    /// Whether data is currently being loaded.
    var isLoading = false

    /// Whether no kubeconfig file was found at any of the searched paths.
    /// When `true`, the app is healthy but has no cluster configuration yet.
    var noConfig = false

    /// Last error message, if any.
    var errorMessage: String?
}
