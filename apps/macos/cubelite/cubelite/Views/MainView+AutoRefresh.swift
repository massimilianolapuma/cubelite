import SwiftUI

// MARK: - MainView Auto-Refresh Wiring
//
// Bridges `AppSettings.autoRefreshInterval` to ``AutoRefreshCoordinator`` by
// reconfiguring the periodic refresh task whenever the interval, the All
// Clusters mode flag, or the selected cluster/namespace changes.
extension MainView {

    /// Reconciles `autoRefreshCoordinator` with the current ``autoRefreshKey``.
    ///
    /// - When `autoRefreshInterval` is `0`, all auto-refresh is disabled.
    /// - When `showAllClusters` is true, periodic ticks reload the cross-cluster
    ///   dashboard data.
    /// - When a single cluster/namespace is selected, periodic ticks reload that
    ///   slice's resources.
    /// - Otherwise (no active scope), the schedule is cancelled.
    @MainActor
    func configureAutoRefresh() {
        let interval = appSettings.autoRefreshInterval

        if showAllClusters {
            autoRefreshCoordinator.schedule(intervalSeconds: interval) { @MainActor in
                await loadCrossClusterData()
            }
        } else if let selection = sidebarSelection {
            let context = selection.context
            let namespace = selection.namespace
            autoRefreshCoordinator.schedule(intervalSeconds: interval) { @MainActor in
                await loadResources(context: context, namespace: namespace)
            }
        } else {
            autoRefreshCoordinator.cancel()
        }
    }
}
