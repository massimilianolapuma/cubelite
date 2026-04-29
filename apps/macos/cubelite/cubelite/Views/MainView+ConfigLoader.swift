import SwiftUI

// MARK: - MainView Config / Namespace Loaders
//
// Kubeconfig + namespace-listing data flow. Extracted from `MainView` with no
// behavior change.
//
// TODO(#106): `addManualNamespace(for:)` instantiates a throwaway `AppSettings()`
// and never persists the mutated dictionary back to UserDefaults. Tracked
// separately; do not fix here per the Bug Discovery Workflow.
// TODO(#106): `loadNamespaces(for:)` instantiates a throwaway `AppSettings()` to
// read `contextNamespaces`; this should use the injected environment instance.
extension MainView {

    @MainActor
    func loadKubeconfig() async {
        clusterState.isLoading = true
        clusterState.errorMessage = nil
        clusterState.clusterReachable = nil
        defer { clusterState.isLoading = false }
        do {
            let config = try await kubeconfigService.load()
            clusterState.noConfig = false
            clusterState.contexts = config.contexts
            clusterState.currentContext = config.currentContext
            // Auto-select the active context on first load;
            // onChange(of: selectedContext) will trigger namespace loading.
            // Guard: skip auto-selection when All Clusters view is active.
            if selectedContext == nil, !showAllClusters, let active = config.currentContext {
                selectedContext = active
            }
        } catch CubeliteError.fileNotFound {
            clusterState.noConfig = true
        } catch {
            clusterState.errorMessage = error.localizedDescription
            logStore.append(
                LogEntry(
                    severity: .error,
                    source: "Config",
                    message: error.localizedDescription,
                    details: String(describing: error),
                    suggestedAction: "Check your kubeconfig file for syntax errors."
                ))
        }
    }

    /// Looks up the default namespace for a context from the kubeconfig.
    ///
    /// Returns `nil` if the context has no namespace set, allowing cluster-scope queries.
    func resolveDefaultNamespace(for context: String) async -> String? {
        guard let config = try? await kubeconfigService.load() else { return nil }
        return config.defaultNamespace(for: context)
    }

    /// Adds a user-entered namespace to the sidebar for RBAC-restricted clusters.
    @MainActor
    func addManualNamespace(for context: String) {
        let ns = manualNamespaceInput.trimmingCharacters(in: .whitespaces)
        guard !ns.isEmpty else { return }
        // Avoid duplicates
        guard !clusterState.namespaces.contains(where: { $0.name == ns }) else {
            manualNamespaceInput = ""
            return
        }
        clusterState.namespaces.append(NamespaceInfo(name: ns, phase: nil))
        // Persist to AppSettings
        var settings = AppSettings()
        var saved = settings.contextNamespaces[context] ?? []
        if !saved.contains(ns) {
            saved.append(ns)
            settings.contextNamespaces[context] = saved
        }
        manualNamespaceInput = ""
    }

    @MainActor
    func loadNamespaces(for context: String) async {
        isLoadingNamespaces = true
        namespaceError = nil
        defer { isLoadingNamespaces = false }
        do {
            let namespaces = try await kubeAPIService.listNamespaces(inContext: context)
            clusterState.namespaces = namespaces.sorted { $0.name < $1.name }
            clusterState.clusterReachable = true
        } catch CubeliteError.clusterUnreachable {
            clusterState.clusterReachable = false
            namespaceError = CubeliteError.clusterUnreachable.localizedDescription
            logStore.append(
                LogEntry(
                    severity: .warning,
                    source: "KubeAPI",
                    message: CubeliteError.clusterUnreachable.localizedDescription,
                    suggestedAction: "Check cluster connectivity and VPN/network settings."
                ))
        } catch let cubeliteError as CubeliteError {
            if case .tlsError = cubeliteError { clusterState.clusterReachable = false }
            // When namespace listing is forbidden, build a fallback list from:
            // 1. User-configured namespaces for this context (AppSettings)
            // 2. Kubeconfig default namespace
            // 3. Empty list (user can manually enter a namespace in the sidebar)
            if case .forbidden = cubeliteError {
                clusterState.clusterReachable = true
                var fallbackNamespaces: [NamespaceInfo] = []
                let settings = AppSettings()
                if let saved = settings.contextNamespaces[context], !saved.isEmpty {
                    fallbackNamespaces = saved.map { NamespaceInfo(name: $0, phase: nil) }
                } else {
                    let defaultNS = await resolveDefaultNamespace(for: context)
                    if let ns = defaultNS {
                        fallbackNamespaces = [NamespaceInfo(name: ns, phase: nil)]
                    }
                }
                clusterState.namespaces = fallbackNamespaces
            }
            namespaceError = cubeliteError.localizedDescription
            let suggestedAction: String? = {
                if case .forbidden = cubeliteError {
                    return
                        "Your RBAC role cannot list namespaces. Set a default namespace in kubeconfig: kubectl config set-context \(context) --namespace=<name>"
                }
                return nil
            }()
            logStore.append(
                LogEntry(
                    severity: .error,
                    source: "KubeAPI",
                    message: cubeliteError.localizedDescription,
                    details: String(describing: cubeliteError),
                    suggestedAction: suggestedAction
                ))
        } catch {
            namespaceError = error.localizedDescription
            logStore.append(
                LogEntry(
                    severity: .error,
                    source: "KubeAPI",
                    message: error.localizedDescription,
                    details: String(describing: error)
                ))
        }
    }

    // MARK: - Auto-Reload Wiring

    /// Starts (or restarts) the kubeconfig file watcher. Called from a
    /// `.task(id:)` so it re-runs whenever the user-configured kubeconfig
    /// path list changes.
    ///
    /// On any debounced change event the watcher reloads the kubeconfig and
    /// records an info-severity log entry so the change surfaces in the
    /// existing logs view without introducing a new toast subsystem.
    @MainActor
    func startKubeconfigWatcher() {
        watcherBox.watcher?.stop()
        let watcher = KubeconfigWatcher { [logStore] in
            await reloadAfterFileChange(logStore: logStore)
        }
        watcherBox.watcher = watcher
        let resolved = resolvePathsToWatch()
        watcher.start(paths: resolved)
    }

    /// Resolves the set of paths to watch. Custom paths from `AppSettings`
    /// take precedence over `$KUBECONFIG` / `~/.kube/config` discovery, to
    /// stay in sync with `KubeconfigService.configure(paths:)`.
    @MainActor
    func resolvePathsToWatch() -> [URL] {
        let custom = appSettings.kubeconfigPaths
        if !custom.isEmpty {
            return custom.map { URL(fileURLWithPath: $0).standardizedFileURL }
        }
        return KubeconfigWatcher.resolveWatchedPaths()
    }

    /// Reloads the kubeconfig and the active context's resources after the
    /// watcher detects an on-disk change. Logs the event to `LogStore`.
    @MainActor
    func reloadAfterFileChange(logStore: LogStore) async {
        logStore.append(
            LogEntry(
                severity: .info,
                source: "Config",
                message: "Kubeconfig updated on disk — reloading"
            )
        )
        await loadKubeconfig()
        if let context = selectedContext {
            await loadNamespaces(for: context)
        }
        if let sel = sidebarSelection {
            await loadResources(context: sel.context, namespace: sel.namespace)
        }
    }
}
