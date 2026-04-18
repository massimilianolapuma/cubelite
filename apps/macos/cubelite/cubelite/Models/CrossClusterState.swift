import Foundation
import Observation

/// Per-cluster health snapshot for the cross-cluster aggregated dashboard.
struct ClusterHealthSnapshot: Sendable {
    let contextName: String
    let isReachable: Bool
    let error: String?
    let totalPods: Int
    let runningPods: Int
    let failedPods: Int
    let totalDeployments: Int
    let healthyDeployments: Int
    let degradedDeployments: Int
    let totalServices: Int
    let totalNamespaces: Int
    let totalRestarts: Int
    let notReadyPods: Int

    /// Resource types that returned HTTP 403 for this cluster.
    let forbiddenResources: [String]

    /// Whether this cluster has RBAC limitations (some resources forbidden).
    var isRBACLimited: Bool { !forbiddenResources.isEmpty }
}

/// Observable state for the cross-cluster aggregated dashboard.
@Observable
@MainActor
final class CrossClusterState {

    /// Snapshots fetched from each cluster in the last refresh.
    var snapshots: [ClusterHealthSnapshot] = []

    /// Whether a cross-cluster data fetch is in progress.
    var isLoading = false

    /// Timestamp of the last successful data refresh.
    var lastUpdated: Date?

    // MARK: - Aggregated Totals

    var totalPods: Int { snapshots.reduce(0) { $0 + $1.totalPods } }
    var runningPods: Int { snapshots.reduce(0) { $0 + $1.runningPods } }
    var failedPods: Int { snapshots.reduce(0) { $0 + $1.failedPods } }
    var totalDeployments: Int { snapshots.reduce(0) { $0 + $1.totalDeployments } }
    var healthyDeployments: Int { snapshots.reduce(0) { $0 + $1.healthyDeployments } }
    var totalServices: Int { snapshots.reduce(0) { $0 + $1.totalServices } }
    var onlineClusters: Int { snapshots.filter(\.isReachable).count }
    var offlineClusters: Int { snapshots.filter { !$0.isReachable }.count }

    /// Clusters that are reachable but have RBAC-limited access to some resources.
    var limitedClusters: Int { snapshots.filter { $0.isReachable && $0.isRBACLimited }.count }
}
