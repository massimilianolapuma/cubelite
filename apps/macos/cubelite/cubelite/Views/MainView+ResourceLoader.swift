import SwiftUI

// MARK: - MainView Resource Loaders
//
// Per-namespace resource fetch orchestration with RBAC-aware partial-success
// handling. Extracted from `MainView` with no behavior change.
//
// TODO(#104): `finishResourceLoad(...)` uses `error as! CubeliteError` after
// `error is CubeliteError` — that force cast should become a `switch` or
// `if let _ = error as? CubeliteError`. Tracked separately.
extension MainView {

    @MainActor
    func loadResources(context: String, namespace: String?) async {
        clusterState.isLoadingResources = true
        clusterState.resourceError = nil
        clusterState.forbiddenResources = []
        defer { clusterState.isLoadingResources = false }

        var forbidden: Set<String> = []
        var fatalError: (any Error)?

        // Helper: attempt a single resource fetch, returning nil on 403.
        func fetchResource<T: Sendable>(
            _ kind: String,
            _ fetch: @Sendable () async throws -> [T]
        ) async -> [T]? {
            do {
                return try await fetch()
            } catch CubeliteError.forbidden {
                forbidden.insert(kind)
                logStore.append(
                    LogEntry(
                        severity: .warning,
                        source: "KubeAPI",
                        message: "Access denied for \(kind)",
                        suggestedAction:
                            "Your RBAC role lacks permissions. Select a specific namespace in the sidebar."
                    ))
                return nil
            } catch CubeliteError.clusterUnreachable {
                fatalError = CubeliteError.clusterUnreachable
                return nil
            } catch let tlsErr as CubeliteError where {
                if case .tlsError = tlsErr { return true }; return false
            }() {
                fatalError = tlsErr
                return nil
            } catch {
                fatalError = error
                return nil
            }
        }

        // Pods
        if let pods = await fetchResource("pods", {
            try await kubeAPIService.listPods(namespace: namespace, inContext: context)
        }) {
            clusterState.pods = pods
            if namespace == nil {
                clusterState.namespacePodCounts = Dictionary(
                    grouping: pods, by: { $0.namespace }
                ).mapValues { $0.count }
            }
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        // Deployments
        if let deployments = await fetchResource("deployments", {
            try await kubeAPIService.listDeployments(namespace: namespace, inContext: context)
        }) {
            clusterState.deployments = deployments
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        // Services
        if let services = await fetchResource("services", {
            try await kubeAPIService.listServices(namespace: namespace, inContext: context)
        }) {
            clusterState.services = services
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        // Secrets
        if let secrets = await fetchResource("secrets", {
            try await kubeAPIService.listSecrets(namespace: namespace, inContext: context)
        }) {
            clusterState.secrets = secrets
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        // ConfigMaps
        if let configMaps = await fetchResource("configmaps", {
            try await kubeAPIService.listConfigMaps(namespace: namespace, inContext: context)
        }) {
            clusterState.configMaps = configMaps
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        // Ingresses
        if let ingresses = await fetchResource("ingresses", {
            try await kubeAPIService.listIngresses(namespace: namespace, inContext: context)
        }) {
            clusterState.ingresses = ingresses
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        // Helm Releases
        if let helmReleases = await fetchResource("helmreleases", {
            try await kubeAPIService.listHelmReleases(namespace: namespace, inContext: context)
        }) {
            clusterState.helmReleases = helmReleases
        } else if fatalError != nil {
            finishResourceLoad(fatalError: fatalError, forbidden: forbidden, namespace: namespace)
            return
        }

        finishResourceLoad(fatalError: nil, forbidden: forbidden, namespace: namespace)
    }

    /// Finalises resource load state after all individual fetches complete.
    @MainActor
    fileprivate func finishResourceLoad(
        fatalError: (any Error)?,
        forbidden: Set<String>,
        namespace: String?
    ) {
        clusterState.forbiddenResources = forbidden
        clusterState.selectedNamespace = namespace

        if let error = fatalError {
            if error is CubeliteError {
                let cubeliteError = error as! CubeliteError
                if case .clusterUnreachable = cubeliteError {
                    clusterState.clusterReachable = false
                    clusterState.resourceError = cubeliteError.localizedDescription
                    logStore.append(
                        LogEntry(
                            severity: .warning,
                            source: "KubeAPI",
                            message: cubeliteError.localizedDescription,
                            suggestedAction: "Check cluster connectivity and VPN/network settings."
                        ))
                } else {
                    if case .tlsError = cubeliteError { clusterState.clusterReachable = false }
                    clusterState.resourceError = cubeliteError.localizedDescription
                    logStore.append(
                        LogEntry(
                            severity: .error,
                            source: "KubeAPI",
                            message: cubeliteError.localizedDescription,
                            details: String(describing: cubeliteError)
                        ))
                }
            } else {
                clusterState.resourceError = error.localizedDescription
                logStore.append(
                    LogEntry(
                        severity: .error,
                        source: "KubeAPI",
                        message: error.localizedDescription,
                        details: String(describing: error)
                    ))
            }
        } else {
            clusterState.clusterReachable = true
            if !forbidden.isEmpty {
                clusterState.resourceError =
                    "Limited access: cannot read \(forbidden.sorted().joined(separator: ", "))"
            }
        }
    }
}
