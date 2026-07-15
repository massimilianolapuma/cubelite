import Foundation

/// UI-ready summary of one container in a pod, for the log-panel picker.
///
/// Ordering contract: app containers first (spec order), then native
/// sidecars (init containers with `restartPolicy: Always`), then plain
/// init containers.
struct ContainerInfo: Equatable, Sendable, Identifiable {
    var id: String { name }

    let name: String
    /// Plain init container (runs to completion before the pod starts).
    let isInit: Bool
    /// Native sidecar: declared under `initContainers` with `restartPolicy: Always`.
    let isSidecar: Bool
    let restarts: Int
    let ready: Bool
    let state: State
    /// Reason of the last terminated instance (e.g. `OOMKilled`), for the
    /// previous-logs affordance.
    let lastTerminatedReason: String?
    let lastTerminatedAt: String?

    enum State: Equatable, Sendable {
        case running
        case waiting(reason: String?)
        case terminated(reason: String?)
    }
}

extension K8sPod {

    /// Maps spec + status to picker-ready ``ContainerInfo`` rows.
    func toContainerInfos() -> [ContainerInfo] {
        let statuses = (status?.containerStatuses ?? []) + (status?.initContainerStatuses ?? [])
        let statusByName = Dictionary(
            statuses.compactMap { s in s.name.map { ($0, s) } },
            uniquingKeysWith: { first, _ in first })

        func info(for container: K8sContainer, isInit: Bool) -> ContainerInfo? {
            guard let name = container.name else { return nil }
            let isSidecar = isInit && container.restartPolicy == "Always"
            let status = statusByName[name]
            return ContainerInfo(
                name: name,
                isInit: isInit && !isSidecar,
                isSidecar: isSidecar,
                restarts: status?.restartCount ?? 0,
                ready: status?.ready ?? false,
                state: Self.state(from: status?.state),
                lastTerminatedReason: status?.lastState?.terminated?.reason,
                lastTerminatedAt: status?.lastState?.terminated?.finishedAt)
        }

        let app = (spec?.containers ?? []).compactMap { info(for: $0, isInit: false) }
        let fromInit = (spec?.initContainers ?? []).compactMap { info(for: $0, isInit: true) }
        let sidecars = fromInit.filter(\.isSidecar)
        let plainInit = fromInit.filter { !$0.isSidecar }
        return app + sidecars + plainInit
    }

    private static func state(from raw: K8sContainerState?) -> ContainerInfo.State {
        if raw?.running != nil { return .running }
        if let terminated = raw?.terminated { return .terminated(reason: terminated.reason) }
        return .waiting(reason: raw?.waiting?.reason)
    }
}
