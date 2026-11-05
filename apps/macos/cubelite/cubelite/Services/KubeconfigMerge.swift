import Foundation

/// Cluster and user names one kubeconfig file defines differently from an
/// earlier file of the merge (#543). Informational: the file's own contexts
/// still use the file's definitions.
struct KubeconfigRedefinition: Equatable, Sendable {
    /// File path, as `URL.path`.
    let path: String
    let clusters: [String]
    let users: [String]

    /// One line for Preferences, naming every redefined entry.
    var summary: String {
        let names = clusters.map { "cluster \($0)" } + users.map { "user \($0)" }
        return "Also defined differently in an earlier file: \(names.joined(separator: ", "))."
            + " Contexts in this file use this file's definition."
    }
}

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
    /// Files that define a cluster or user differently from an earlier file,
    /// in merge order; files without such names are left out.
    private(set) var redefinitions: [KubeconfigRedefinition] = []

    init(files: [(path: URL, config: RawKubeConfig)]) {
        var seenContexts: Set<String> = []
        var seenClusters: Set<String> = []
        var seenUsers: Set<String> = []
        var earlierClusters = EarlierEntries<ClusterDetails>()
        var earlierUsers = EarlierEntries<UserDetails>()

        for (path, raw) in files {
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

            let redefinition = KubeconfigRedefinition(
                path: path.path,
                clusters: earlierClusters.redefined(
                    fileClusters.map { ($0.name, $0.cluster) }, in: path.path),
                users: earlierUsers.redefined(fileUsers.map { ($0.name, $0.user) }, in: path.path)
            )
            if !redefinition.clusters.isEmpty || !redefinition.users.isEmpty {
                redefinitions.append(redefinition)
            }
        }
    }

    private static func firstByName<T>(_ entries: [T], name: (T) -> String) -> [String: T] {
        Dictionary(entries.map { (name($0), $0) }, uniquingKeysWith: { first, _ in first })
    }
}

/// Definitions seen so far for each name, with the file that made them.
private struct EarlierEntries<T: Equatable> {
    private var seen: [String: [(path: String, value: T?)]] = [:]

    /// Names among `entries` (from `path`) that another, earlier file defines
    /// with a different value; records `entries` as seen.
    mutating func redefined(_ entries: [(String, T?)], in path: String) -> [String] {
        var names: [String] = []
        for (name, value) in entries {
            let earlier = seen[name, default: []]
            let differs = earlier.contains { $0.path != path && $0.value != value }
            if differs && !names.contains(name) {
                names.append(name)
            }
            seen[name, default: []].append((path, value))
        }
        return names
    }
}
