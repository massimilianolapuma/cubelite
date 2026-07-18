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
    /// Cluster nodes (read-only inventory; empty when RBAC denies nodes).
    var nodes: [NodeInfo] = []
    /// Live node usage from metrics-server; empty when unavailable.
    var nodeMetrics: [NodeMetricsInfo] = []
    /// Aggregated usage vs allocatable; nil when metrics are unavailable.
    var capacity: ClusterCapacity?
    /// Recent Warning events for the browsed scope, most recent first.
    var warningEvents: [EventInfo] = []

    /// Available namespaces for the currently browsed context.
    var namespaces: [NamespaceInfo] = []

    /// Deployments in the selected namespace.
    var deployments: [DeploymentInfo] = []
    /// Batch jobs in the selected namespace.
    var jobs: [JobInfo] = []
    /// Cron jobs in the selected namespace.
    var cronJobs: [CronJobInfo] = []
    /// Persistent volume claims in the selected namespace.
    var pvcs: [PvcInfo] = []
    /// Stateful sets in the selected namespace.
    var statefulSets: [StatefulSetInfo] = []

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
    /// Stateful sets.
    case statefulSets = "StatefulSets"
    /// Batch jobs.
    case jobs = "Jobs"
    /// Cron jobs.
    case cronJobs = "CronJobs"
    /// Persistent volume claims.
    case pvcs = "PVCs"
    /// Cluster nodes (read-only).
    case nodes = "Nodes"

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
        case .statefulSets: "externaldrive.badge.timemachine"
        case .jobs: "checklist"
        case .cronJobs: "clock.arrow.circlepath"
        case .pvcs: "externaldrive"
        case .nodes: "server.rack"
        }
    }
}
