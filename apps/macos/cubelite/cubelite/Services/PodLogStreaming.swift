import Foundation

/// Log-related subset of the Kubernetes API surface, extracted so the log
/// panel's session store can be exercised with a scripted double in tests.
protocol PodLogStreaming: Sendable {
    func streamPodLogs(
        namespace: String, pod: String, container: String?, tailLines: Int,
        sinceTime: String?, inContext contextName: String?
    ) async throws -> AsyncThrowingStream<String, Error>

    func fetchPreviousPodLogs(
        namespace: String, pod: String, container: String?, tailLines: Int,
        inContext contextName: String?
    ) async throws -> [String]

    func fetchPodContainers(
        namespace: String, pod: String, inContext contextName: String?
    ) async throws -> [ContainerInfo]
}

extension KubeAPIService: PodLogStreaming {}
