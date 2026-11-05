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
            // Compose expands aliases, so a small file can describe a huge
            // tree ("billion laughs"): a file over the budget gets no note.
            var budget = nodeBudget
            guard
                let clusters = try? namedEntries(
                    node, list: "clusters", body: "cluster", keep: clusterIdentityKeys,
                    dir: dir, budget: &budget),
                let users = try? namedEntries(
                    node, list: "users", body: "user", keep: nil, dir: dir, budget: &budget)
            else { continue }
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

    /// Most YAML nodes compared per file; real kubeconfigs use a few hundred.
    static let nodeBudget = 100_000

    /// `(name, body)` pairs of one named list of a kubeconfig document in
    /// `dir`, the body reduced to `keep` (before it is converted) when given
    /// and its relative `pathKeys` resolved against `dir`.
    ///
    /// - Throws: `ScanBudgetExceeded` once more than `budget` nodes are visited.
    private static func namedEntries(
        _ document: Node, list: String, body: String, keep: Set<String>?, dir: String,
        budget: inout Int
    ) throws -> [(String, ComparableYAML?)] {
        let items: [Node] = document[list]?.sequence.map { Array($0) } ?? []
        var entries: [(String, ComparableYAML?)] = []
        for item in items {
            try ComparableYAML.spend(&budget)
            guard let name = item["name"]?.string else { continue }
            guard let value = item[body] else {
                entries.append((name, nil))
                continue
            }
            entries.append((name, try entryBody(value, keep: keep, dir: dir, budget: &budget)))
        }
        return entries
    }

    private static func entryBody(
        _ node: Node, keep: Set<String>?, dir: String, budget: inout Int
    ) throws -> ComparableYAML {
        guard case .mapping(let mapping) = node else {
            return try ComparableYAML(node, budget: &budget)
        }
        var fields: [String: ComparableYAML] = [:]
        for (key, value) in mapping {
            let name = key.string ?? ""
            if let keep, !keep.contains(name) { continue }
            fields[name] = try ComparableYAML(value, budget: &budget)
        }
        for key in pathKeys {
            if case .scalar(let file, tag: let tag)? = fields[key], !file.hasPrefix("/") {
                fields[key] = .scalar(dir + "/" + file, tag: tag)
            }
        }
        return .mapping(fields)
    }
}

/// The redefinition scan visited more than `KubeconfigRedefinition.nodeBudget` nodes.
private struct ScanBudgetExceeded: Error {}

/// A YAML value compared like `serde_yaml::Value` in the core: mappings
/// regardless of key order, scalars by text and resolved tag.
private indirect enum ComparableYAML: Equatable {
    case scalar(String, tag: String)
    case sequence([ComparableYAML])
    case mapping([String: ComparableYAML])

    /// Converts `node`, charging one unit of `budget` per node visited.
    init(_ node: Node, budget: inout Int) throws {
        try Self.spend(&budget)
        switch node {
        case .scalar(let scalar):
            self = .scalar(scalar.string, tag: node.tag.description)
        case .sequence(let sequence):
            var items: [ComparableYAML] = []
            for child in sequence {
                items.append(try ComparableYAML(child, budget: &budget))
            }
            self = .sequence(items)
        case .mapping(let mapping):
            var fields: [String: ComparableYAML] = [:]
            for (key, value) in mapping {
                fields[key.string ?? ""] = try ComparableYAML(value, budget: &budget)
            }
            self = .mapping(fields)
        case .alias:
            // `Yams.compose` replaces aliases with their anchored node, so a
            // composed document holds none; kept for exhaustiveness.
            self = .scalar("", tag: node.tag.description)
        }
    }

    static func spend(_ budget: inout Int) throws {
        budget -= 1
        if budget < 0 { throw ScanBudgetExceeded() }
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
