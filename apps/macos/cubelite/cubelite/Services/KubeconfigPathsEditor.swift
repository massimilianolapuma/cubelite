import Foundation

/// Outcome of adding files picked in Preferences to the kubeconfig path list.
struct KubeconfigPathsAddition: Equatable, Sendable {
    /// The path list to store.
    var paths: [String]
    /// Picked files that are not kubeconfig documents, in pick order.
    var rejected: [String]
}

/// Pure list logic behind Preferences → Kubeconfig Files → Add File… (#450).
enum KubeconfigPathsEditor {

    /// Adds the picked files that are kubeconfig documents to `paths`.
    ///
    /// Files that fail `isKubeconfig` are reported in `rejected` and never
    /// touch the list. When the list is empty and at least one picked file
    /// is accepted, it is first seeded with `defaults()` so the user keeps
    /// the config they were already using. Paths already in the list are
    /// not added twice.
    static func adding(
        _ picked: [URL],
        to paths: [String],
        defaults: () -> [String] = { KubeconfigService.resolveKubeconfigPaths().map(\.path) },
        isKubeconfig: (URL) -> Bool = KubeconfigService.isKubeconfigFile(at:)
    ) -> KubeconfigPathsAddition {
        var accepted: [String] = []
        var rejected: [String] = []
        for url in picked {
            if isKubeconfig(url) {
                accepted.append(url.path)
            } else {
                rejected.append(url.path)
            }
        }
        guard !accepted.isEmpty else {
            return KubeconfigPathsAddition(paths: paths, rejected: rejected)
        }
        var result = paths.isEmpty ? defaults() : paths
        for path in accepted where !result.contains(path) {
            result.append(path)
        }
        return KubeconfigPathsAddition(paths: result, rejected: rejected)
    }

    /// Alert text naming the rejected files.
    static func rejectionMessage(for rejected: [String]) -> String {
        let names = rejected.map { "“\(URL(fileURLWithPath: $0).lastPathComponent)”" }
        let expectation = "A kubeconfig is a YAML or JSON document with `kind: Config`."
        if names.count == 1 {
            return "\(names[0]) is not a kubeconfig file and was not added. \(expectation)"
        }
        return "These files are not kubeconfig files and were not added: "
            + names.joined(separator: ", ") + ". \(expectation)"
    }
}
