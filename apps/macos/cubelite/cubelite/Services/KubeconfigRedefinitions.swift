import Foundation
import Yams

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

    // MARK: - Scan

    /// Which clusters and users count as "defined differently" by a later
    /// file. Same rule as `cubelite-core` (`kubeconfig.rs`,
    /// `CLUSTER_IDENTITY_KEYS`); keep both in sync so the desktop and native
    /// Preferences show the same note for the same files.
    ///
    /// - A cluster entry is compared on `clusterIdentityKeys` only, so
    ///   cosmetic keys such as `extensions` do not count.
    /// - A user entry is compared whole, unmodelled keys (`exec`,
    ///   `auth-provider`, …) included.
    /// - Mappings compare regardless of key order; scalars by value and type.
    /// - Relative file paths (`pathKeys`) are resolved against the directory
    ///   of the file that lists them, as kubectl does.
    /// - Identical duplicates are not reported.
    static let clusterIdentityKeys: Set<String> = [
        "server",
        "certificate-authority",
        "certificate-authority-data",
        "insecure-skip-tls-verify",
        "tls-server-name",
        "proxy-url",
    ]

    /// Cluster and user keys holding a file path, relative to the kubeconfig.
    static let pathKeys: Set<String> = ["certificate-authority", "client-certificate", "client-key"]

    /// Per file, in order: the cluster and user names it defines differently
    /// from an earlier file. Files that do not parse as YAML and files
    /// without such names are left out.
    static func scan(_ files: [(path: URL, yaml: String)]) -> [KubeconfigRedefinition] {
        var earlierClusters = EarlierEntries()
        var earlierUsers = EarlierEntries()
        var found: [KubeconfigRedefinition] = []
        for (path, yaml) in files {
            guard let node = try? Yams.compose(yaml: yaml) else { continue }
            let dir = path.deletingLastPathComponent().path
            let clusters = namedEntries(
                node, list: "clusters", body: "cluster", keep: clusterIdentityKeys, dir: dir)
            let users = namedEntries(node, list: "users", body: "user", keep: nil, dir: dir)
            let redefinition = KubeconfigRedefinition(
                path: path.path,
                clusters: earlierClusters.redefined(clusters, in: path.path),
                users: earlierUsers.redefined(users, in: path.path)
            )
            if !redefinition.clusters.isEmpty || !redefinition.users.isEmpty {
                found.append(redefinition)
            }
        }
        return found
    }

    /// `(name, body)` pairs of one named list of a kubeconfig document in
    /// `dir`, the body reduced to `keep` when given and its relative
    /// `pathKeys` resolved against `dir`.
    private static func namedEntries(
        _ document: Node, list: String, body: String, keep: Set<String>?, dir: String
    ) -> [(String, ComparableYAML?)] {
        let items: [Node] = document[list]?.sequence.map { Array($0) } ?? []
        return items.compactMap { item in
            guard let name = item["name"]?.string else { return nil }
            guard let value = item[body] else { return (name, nil) }
            guard case .mapping(var entries) = ComparableYAML(value) else {
                return (name, ComparableYAML(value))
            }
            if let keep {
                entries = entries.filter { keep.contains($0.key) }
            }
            for key in pathKeys {
                if case .scalar(let file, tag: let tag)? = entries[key], !file.hasPrefix("/") {
                    entries[key] = .scalar(dir + "/" + file, tag: tag)
                }
            }
            return (name, .mapping(entries))
        }
    }
}

/// A YAML value compared like `serde_yaml::Value` in the core: mappings
/// regardless of key order, scalars by text and resolved tag.
private indirect enum ComparableYAML: Equatable {
    case scalar(String, tag: String)
    case sequence([ComparableYAML])
    case mapping([String: ComparableYAML])

    init(_ node: Node) {
        switch node {
        case .scalar(let scalar):
            self = .scalar(scalar.string, tag: node.tag.description)
        case .sequence(let sequence):
            self = .sequence(sequence.map(ComparableYAML.init))
        case .mapping(let mapping):
            var entries: [String: ComparableYAML] = [:]
            for (key, value) in mapping {
                entries[key.string ?? "\(key)"] = ComparableYAML(value)
            }
            self = .mapping(entries)
        case .alias:
            // Kubeconfigs do not use anchors; compare an alias by its text.
            self = .scalar("\(node)", tag: node.tag.description)
        }
    }
}

/// Definitions seen so far for each name, with the file that made them.
private struct EarlierEntries {
    private var seen: [String: [(path: String, value: ComparableYAML?)]] = [:]

    /// Names among `entries` (from `path`) that another, earlier file defines
    /// with a different value; records `entries` as seen.
    mutating func redefined(_ entries: [(String, ComparableYAML?)], in path: String) -> [String] {
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
