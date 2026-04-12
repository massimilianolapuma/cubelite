import Foundation
import Yams

/// Service actor responsible for loading, parsing, and saving kubeconfig files.
///
/// Mirrors the logic of `cubelite-core`'s `kubeconfig.rs` — resolves KUBECONFIG
/// environment paths, merges multiple configs, and manages the active context.
actor KubeconfigService {

    // MARK: - Path Resolution

    /// Resolves kubeconfig file paths from the `KUBECONFIG` environment variable,
    /// falling back to `~/.kube/config`.
    static func resolveKubeconfigPaths() -> [URL] {
        if let envValue = ProcessInfo.processInfo.environment["KUBECONFIG"],
           !envValue.isEmpty {
            return envValue
                .split(separator: ":")
                .map { URL(fileURLWithPath: String($0)) }
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        return [home.appendingPathComponent(".kube/config")]
    }

    // MARK: - Load

    /// Loads and merges kubeconfig from the resolved paths.
    func load() throws -> KubeConfig {
        let paths = Self.resolveKubeconfigPaths()
        return try loadFromPaths(paths)
    }

    /// Loads and merges kubeconfig from the given file paths.
    ///
    /// - The first file's `current-context` wins.
    /// - Contexts are merged; duplicate names from later files are skipped.
    func loadFromPaths(_ paths: [URL]) throws -> KubeConfig {
        guard !paths.isEmpty else {
            throw CubeliteError.fileNotFound(path: "No kubeconfig paths resolved")
        }

        let fileManager = FileManager.default
        let decoder = YAMLDecoder()

        var mergedContextNames: [String] = []
        var seenNames: Set<String> = []
        var currentContext: String?
        var mergedRaw: RawKubeConfig?

        for path in paths {
            guard fileManager.fileExists(atPath: path.path) else {
                continue
            }

            let data = try Data(contentsOf: path)
            let raw = try decoder.decode(RawKubeConfig.self, from: data)

            // First file's current-context wins
            if currentContext == nil {
                currentContext = raw.currentContext
            }

            // Merge contexts, skip duplicates
            for named in raw.contexts ?? [] {
                guard !seenNames.contains(named.name) else { continue }
                seenNames.insert(named.name)
                mergedContextNames.append(named.name)
            }

            if mergedRaw == nil {
                mergedRaw = raw
            }
        }

        guard let raw = mergedRaw else {
            throw CubeliteError.fileNotFound(
                path: paths.map(\.path).joined(separator: ":")
            )
        }

        return KubeConfig(
            contexts: mergedContextNames,
            currentContext: currentContext,
            raw: raw,
            paths: paths
        )
    }

    // MARK: - Context Management

    /// Sets the active context by name.
    ///
    /// - Throws: ``CubeliteError/contextNotFound(name:)`` if the name is not
    ///   in the config's context list.
    func setActiveContext(_ name: String, in config: inout KubeConfig) throws {
        guard config.contexts.contains(name) else {
            throw CubeliteError.contextNotFound(name: name)
        }
        config.currentContext = name
        config.raw.currentContext = name
    }

    // MARK: - Save

    /// Saves the config back to YAML, writing to the first path.
    func save(_ config: KubeConfig) throws {
        guard let firstPath = config.paths.first else {
            throw CubeliteError.ioError(reason: "No kubeconfig path available for saving")
        }

        let encoder = YAMLEncoder()
        let yamlString = try encoder.encode(config.raw)

        guard let data = yamlString.data(using: .utf8) else {
            throw CubeliteError.ioError(reason: "Failed to encode YAML to UTF-8 data")
        }

        try data.write(to: firstPath, options: .atomic)
    }
}
