import SwiftUI

// MARK: - MainView Cross-Cluster Loader
//
// Aggregates per-cluster resource snapshots for the All Clusters dashboard.
// Extracted from `MainView` with no behavior change.
extension MainView {

    @MainActor
    func loadCrossClusterData() async {
        crossClusterState.isLoading = true
        defer { crossClusterState.isLoading = false }
        let contextNames = clusterState.contexts
        let apiService = kubeAPIService
        var results: [ClusterHealthSnapshot] = []
        await withTaskGroup(of: ClusterHealthSnapshot.self) { group in
            for ctx in contextNames {
                group.addTask {
                    var pods: [PodInfo] = []
                    var deployments: [DeploymentInfo] = []
                    var services: [ServiceInfo] = []
                    var namespaces: [NamespaceInfo] = []
                    var forbidden: [String] = []
                    var anySucceeded = false
                    var fatalErr: String?

                    // Pods
                    do {
                        pods = try await apiService.listPods(inContext: ctx)
                        anySucceeded = true
                    } catch CubeliteError.forbidden {
                        forbidden.append("pods")
                    } catch {
                        fatalErr = error.localizedDescription
                    }

                    // Deployments
                    if fatalErr == nil {
                        do {
                            deployments = try await apiService.listDeployments(inContext: ctx)
                            anySucceeded = true
                        } catch CubeliteError.forbidden {
                            forbidden.append("deployments")
                        } catch {
                            if fatalErr == nil { fatalErr = error.localizedDescription }
                        }
                    }

                    // Services
                    if fatalErr == nil {
                        do {
                            services = try await apiService.listServices(inContext: ctx)
                            anySucceeded = true
                        } catch CubeliteError.forbidden {
                            forbidden.append("services")
                        } catch {
                            if fatalErr == nil { fatalErr = error.localizedDescription }
                        }
                    }

                    // Namespaces
                    if fatalErr == nil {
                        do {
                            namespaces = try await apiService.listNamespaces(inContext: ctx)
                            anySucceeded = true
                        } catch CubeliteError.forbidden {
                            forbidden.append("namespaces")
                        } catch {
                            if fatalErr == nil { fatalErr = error.localizedDescription }
                        }
                    }

                    let isReachable = anySucceeded || (fatalErr == nil && !forbidden.isEmpty)
                    return ClusterHealthSnapshot(
                        contextName: ctx,
                        isReachable: isReachable,
                        error: fatalErr,
                        totalPods: pods.count,
                        runningPods: pods.filter { $0.phase == "Running" }.count,
                        failedPods: pods.filter { $0.phase == "Failed" }.count,
                        totalDeployments: deployments.count,
                        healthyDeployments: deployments.filter {
                            $0.readyReplicas == $0.replicas
                        }.count,
                        degradedDeployments: deployments.filter {
                            $0.readyReplicas != $0.replicas
                        }.count,
                        totalServices: services.count,
                        totalNamespaces: namespaces.count,
                        totalRestarts: pods.reduce(0) { $0 + $1.restarts },
                        notReadyPods: pods.filter { !$0.ready }.count,
                        forbiddenResources: forbidden
                    )
                }
            }
            for await snapshot in group {
                results.append(snapshot)
            }
        }
        crossClusterState.snapshots = results.sorted { $0.contextName < $1.contextName }
        crossClusterState.lastUpdated = Date()
    }
}
