import SwiftUI

// MARK: - MainView Resource Watch
//
// Real-time updates: a Kubernetes watch stream over pods for the selected
// (context, namespace). Events are debounced into a resource reload, which
// complements the interval-based auto-refresh (kept as fallback for the
// resource kinds without a watch).
extension MainView {

    /// (Re)starts the pod watch for the current sidebar selection.
    /// Cancels any previous stream; failures degrade silently to the
    /// interval refresh.
    func startResourceWatch() {
        watchTaskBox.task?.cancel()
        guard let selection = sidebarSelection else { return }

        watchTaskBox.task = Task {
            do {
                let stream = try await kubeAPIService.watchPods(
                    namespace: selection.namespace,
                    inContext: selection.context
                )
                var pending = false
                for try await _ in stream {
                    if Task.isCancelled { return }
                    // Debounce bursts: schedule one reload per quiet window.
                    if pending { continue }
                    pending = true
                    Task {
                        try? await Task.sleep(for: .milliseconds(600))
                        pending = false
                        guard !Task.isCancelled, sidebarSelection == selection else { return }
                        await loadResources(
                            context: selection.context, namespace: selection.namespace)
                    }
                }
            } catch is CancellationError {
                // Selection changed or view disappeared.
            } catch {
                // Watch unsupported/forbidden: interval refresh keeps working.
            }
        }
    }
}

/// Reference box for the watch task so `@State` keeps it stable across
/// view re-evaluations (same pattern as `WatcherBox`).
@MainActor
final class WatchTaskBox {
    var task: Task<Void, Never>?
}
