import Foundation

/// The merge of decoded kubeconfig files, in order (same rule as
/// `cubelite-core`'s `KubeConfig::load_from_paths`).
///
/// Contexts, clusters and users are merged first-wins by name and the first
/// file that sets `current-context` wins. A context resolves its cluster and
/// user against the file that defines the context first: when that file
/// defines the referenced name its entry is used, even if an earlier file
/// defines the same name (#543); otherwise the merged first-wins entry applies,
/// so kubectl-style cross-file references keep working.
struct KubeconfigMerge: Sendable {

    private(set) var contexts: [NamedContext] = []
    private(set) var clusters: [NamedCluster] = []
    private(set) var users: [NamedUser] = []
    private(set) var currentContext: String?
    /// Context name → cluster entry from the context's own file.
    private(set) var ownClusters: [String: NamedCluster] = [:]
    /// Context name → user entry from the context's own file.
    private(set) var ownUsers: [String: NamedUser] = [:]

    init(files: [(path: URL, config: RawKubeConfig)]) {
        var seenContexts: Set<String> = []
        var seenClusters: Set<String> = []
        var seenUsers: Set<String> = []

        for (_, raw) in files {
            if currentContext == nil {
                currentContext = raw.currentContext
            }
            let fileClusters = raw.clusters ?? []
            let fileUsers = raw.users ?? []
            let clusterByName = Self.firstByName(fileClusters, name: \.name)
            let userByName = Self.firstByName(fileUsers, name: \.name)

            for named in raw.contexts ?? [] {
                guard seenContexts.insert(named.name).inserted else { continue }
                contexts.append(named)
                if let name = named.context?.cluster, let own = clusterByName[name] {
                    ownClusters[named.name] = own
                }
                if let name = named.context?.user, let own = userByName[name] {
                    ownUsers[named.name] = own
                }
            }
            for named in fileClusters where seenClusters.insert(named.name).inserted {
                clusters.append(named)
            }
            for named in fileUsers where seenUsers.insert(named.name).inserted {
                users.append(named)
            }
        }
    }

    private static func firstByName<T>(_ entries: [T], name: (T) -> String) -> [String: T] {
        Dictionary(entries.map { (name($0), $0) }, uniquingKeysWith: { first, _ in first })
    }
}
