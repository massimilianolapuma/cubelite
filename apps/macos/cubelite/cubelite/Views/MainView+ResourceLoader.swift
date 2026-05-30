import SwiftUI

// MARK: - MainView Resource Loaders
//
// Per-namespace resource fetch orchestration with RBAC-aware partial-success
// handling. Extracted from `MainView` with no behavior change.
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
            let mapping = MainView.mapResourceFatalError(error)
            if let reachable = mapping.clusterReachable {
                clusterState.clusterReachable = reachable
            }
            clusterState.resourceError = mapping.message
            logStore.append(
                LogEntry(
                    severity: mapping.severity,
                    source: "KubeAPI",
                    message: mapping.message,
                    details: mapping.details,
                    suggestedAction: mapping.suggestedAction
                ))
        } else {
            clusterState.clusterReachable = true
            if !forbidden.isEmpty {
                clusterState.resourceError =
                    "Limited access: cannot read \(forbidden.sorted().joined(separator: ", "))"
            }
        }
    }

    /// Outcome of mapping a resource-load fatal error into UI state and a log entry.
    /// Pure, `Sendable`, and unit-testable without a SwiftUI host.
    struct ResourceFatalErrorMapping: Sendable, Equatable {
        let message: String
        let severity: LogSeverity
        /// `nil` leaves the prior reachability flag untouched.
        let clusterReachable: Bool?
        let details: String?
        let suggestedAction: String?
    }

    /// Safely maps any error thrown during resource loading to the values
    /// ``finishResourceLoad(fatalError:forbidden:namespace:)`` needs to update
    /// `ClusterState` and append a `LogEntry`. Non-`CubeliteError` values
    /// (e.g. `URLError`, decoding errors) fall back to a generic error log
    /// instead of crashing via a force cast.
    static func mapResourceFatalError(_ error: any Error) -> ResourceFatalErrorMapping {
        guard let cubeliteError = error as? CubeliteError else {
            return ResourceFatalErrorMapping(
                message: error.localizedDescription,
                severity: .error,
                clusterReachable: nil,
                details: String(describing: error),
                suggestedAction: nil
            )
        }

        switch cubeliteError {
        case .clusterUnreachable:
            return ResourceFatalErrorMapping(
                message: cubeliteError.localizedDescription,
                severity: .warning,
                clusterReachable: false,
                details: nil,
                suggestedAction: "Check cluster connectivity and VPN/network settings."
            )
        case .tlsError:
            return ResourceFatalErrorMapping(
                message: cubeliteError.localizedDescription,
                severity: .error,
                clusterReachable: false,
                details: String(describing: cubeliteError),
                suggestedAction: nil
            )
        default:
            return ResourceFatalErrorMapping(
                message: cubeliteError.localizedDescription,
                severity: .error,
                clusterReachable: nil,
                details: String(describing: cubeliteError),
                suggestedAction: nil
            )
        }
    }
}
