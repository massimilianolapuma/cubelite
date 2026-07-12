import Foundation
import Yams

/// Service actor responsible for loading, parsing, and saving kubeconfig files.
///
/// Mirrors the logic of `cubelite-core`'s `kubeconfig.rs` — resolves KUBECONFIG
/// environment paths, merges multiple configs, and manages the active context.
///
/// # Credential handling
///
/// Bearer tokens found in kubeconfig files are migrated to the macOS Keychain
/// during every load (keyed by cluster server URL; an existing Keychain copy
/// always wins) and then stripped from the returned in-memory model, so no
/// token outlives the load call outside the Keychain. `save(_:)` re-reads the
/// on-disk file and only rewrites `current-context`, leaving file credentials
/// untouched.
actor KubeconfigService {

    /// Keychain used as the durable home for bearer tokens found in kubeconfig files.
    private let keychain: KeychainService

    init(keychain: KeychainService = KeychainService()) {
        self.keychain = keychain
    }

    // MARK: - Path Resolution

    /// Resolves kubeconfig file paths from the `KUBECONFIG` environment variable,
    /// falling back to `~/.kube/config` plus any additional kubeconfig files
    /// discovered in the `~/.kube/` directory.
    ///
    /// Auto-discovery scans `~/.kube/` for regular files whose first bytes
    /// contain a YAML `kind: Config` marker, which is present in all valid
    /// kubeconfig files. The default `config` file always comes first so its
    /// `current-context` takes precedence during merge.
    static func resolveKubeconfigPaths() -> [URL] {
        if let envValue = ProcessInfo.processInfo.environment["KUBECONFIG"],
            !envValue.isEmpty
        {
            return
                envValue
                .split(separator: ":")
                .map { URL(fileURLWithPath: String($0)) }
        }
        let kubeDir = realHomeDirectory().appendingPathComponent(".kube")
        let defaultConfig = kubeDir.appendingPathComponent("config")
        var paths = [defaultConfig]
        // Auto-discover additional kubeconfig files in ~/.kube/
        paths.append(contentsOf: discoverKubeconfigFiles(in: kubeDir, excluding: defaultConfig))
        return paths
    }

    /// Scans a directory for files that look like valid kubeconfig YAML.
    ///
    /// A file qualifies when it is a regular file (not a directory or symlink
    /// to a directory) and its first 512 bytes contain `kind: Config` or
    /// `kind: "Config"`. Hidden files (starting with `.`) and the `cache`
    /// directory are skipped.
    private static func discoverKubeconfigFiles(
        in directory: URL,
        excluding excluded: URL
    ) -> [URL] {
        let fm = FileManager.default
        guard
            let entries = try? fm.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey],
                options: [.skipsHiddenFiles]
            )
        else { return [] }

        return entries
            .filter { url in
                // Skip the already-included default config
                guard url.standardizedFileURL != excluded.standardizedFileURL else {
                    return false
                }
                // Skip directories (e.g. cache/, kubens/)
                let isDir =
                    (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
                guard !isDir else { return false }
                // Quick heuristic: read first 512 bytes and check for kubeconfig marker
                guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
                defer { handle.closeFile() }
                guard let header = try? handle.read(upToCount: 512) else { return false }
                guard let text = String(data: header, encoding: .utf8) else { return false }
                return text.contains("kind: Config") || text.contains("kind: \"Config\"")
            }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    /// Returns the user's real home directory, bypassing sandbox container redirection.
    ///
    /// `FileManager.default.homeDirectoryForCurrentUser` returns the sandboxed container
    /// (`~/Library/Containers/<bundle-id>/Data`) when `ENABLE_APP_SANDBOX = YES`.
    /// `getpwuid(getuid())` reads from the system user database and always returns the
    /// real home path (e.g. `/Users/alice`), unaffected by the sandbox.
    private static func realHomeDirectory() -> URL {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: dir))
        }
        // Unreachable in practice; the user always has a passwd entry.
        return FileManager.default.homeDirectoryForCurrentUser
    }

    // MARK: - Custom Paths

    /// User-specified kubeconfig paths. When non-empty, overrides `KUBECONFIG` env-var
    /// and default `~/.kube/config` resolution.
    private var customPaths: [URL] = []

    /// Updates the custom kubeconfig paths used by this service.
    ///
    /// Call this whenever `AppSettings.kubeconfigPaths` changes.
    /// Pass an empty array to revert to default path resolution.
    func configure(paths: [URL]) {
        customPaths = paths
    }

    // MARK: - Load

    /// Loads and merges kubeconfig from the resolved paths.
    ///
    /// Uses `customPaths` when non-empty; otherwise falls back to `KUBECONFIG`
    /// env-var resolution and `~/.kube/config`.
    func load() async throws -> KubeConfig {
        let paths = customPaths.isEmpty ? Self.resolveKubeconfigPaths() : customPaths
        return try await loadFromPaths(paths)
    }

    /// Loads and merges kubeconfig from the given file paths.
    ///
    /// - The first file's `current-context` wins.
    /// - Contexts are merged; duplicate names from later files are skipped.
    /// - Bearer tokens are migrated to the Keychain and stripped from the
    ///   returned model (see the type-level documentation).
    func loadFromPaths(_ paths: [URL]) async throws -> KubeConfig {
        guard !paths.isEmpty else {
            throw CubeliteError.fileNotFound(path: "No kubeconfig paths resolved")
        }

        let fileManager = FileManager.default
        let decoder = YAMLDecoder()

        var mergedContexts: [NamedContext] = []
        var seenContextNames: Set<String> = []
        var mergedClusters: [NamedCluster] = []
        var seenClusterNames: Set<String> = []
        var mergedUsers: [NamedUser] = []
        var seenUserNames: Set<String> = []
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
                guard !seenContextNames.contains(named.name) else { continue }
                seenContextNames.insert(named.name)
                mergedContexts.append(named)
            }

            // Merge clusters, skip duplicates
            for named in raw.clusters ?? [] {
                guard !seenClusterNames.contains(named.name) else { continue }
                seenClusterNames.insert(named.name)
                mergedClusters.append(named)
            }

            // Merge users, skip duplicates
            for named in raw.users ?? [] {
                guard !seenUserNames.contains(named.name) else { continue }
                seenUserNames.insert(named.name)
                mergedUsers.append(named)
            }

            if mergedRaw == nil {
                mergedRaw = raw
            }
        }

        guard var raw = mergedRaw else {
            throw CubeliteError.fileNotFound(
                path: paths.map(\.path).joined(separator: ":")
            )
        }

        await migrateTokensToKeychain(
            contexts: mergedContexts, clusters: mergedClusters, users: mergedUsers)

        // Store the fully merged collections into the raw config, with bearer
        // tokens redacted now that the Keychain holds them.
        raw.contexts = mergedContexts
        raw.clusters = mergedClusters
        raw.users = mergedUsers.map { NamedUser(name: $0.name, user: $0.user?.redactingToken()) }
        raw.currentContext = currentContext

        return KubeConfig(
            contexts: mergedContexts.map(\.name),
            currentContext: currentContext,
            raw: raw,
            paths: paths
        )
    }

    // MARK: - Credential Migration

    /// Imports every bearer token referenced by a context into the Keychain,
    /// keyed by the cluster's server URL (trailing slash dropped, matching
    /// `KubeAPIService` session accounts). An existing Keychain entry always
    /// wins over the file copy, so user edits made via "Reset stored
    /// credentials" or the Keychain itself are never clobbered.
    private func migrateTokensToKeychain(
        contexts: [NamedContext],
        clusters: [NamedCluster],
        users: [NamedUser]
    ) async {
        let serversByCluster = Dictionary(
            clusters.compactMap { named in named.cluster?.server.map { (named.name, $0) } },
            uniquingKeysWith: { first, _ in first }
        )
        let tokensByUser = Dictionary(
            users.compactMap { named in named.user?.token.map { (named.name, $0) } },
            uniquingKeysWith: { first, _ in first }
        )

        for context in contexts {
            guard
                let clusterName = context.context?.cluster,
                let userName = context.context?.user,
                let server = serversByCluster[clusterName], !server.isEmpty,
                let token = tokensByUser[userName], !token.isEmpty
            else { continue }
            let account = server.hasSuffix("/") ? String(server.dropLast()) : server

            if let existing = try? await keychain.retrieveString(
                tag: .bearerToken, account: account), !existing.isEmpty
            {
                continue
            }
            try? await keychain.storeString(token, tag: .bearerToken, account: account)
        }
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

    /// Persists the config's `current-context` to the first kubeconfig file.
    ///
    /// The on-disk file is re-read and only `current-context` is rewritten:
    /// the in-memory model has bearer tokens redacted, so encoding it directly
    /// would strip credentials from the user's kubeconfig (and merge entries
    /// from other files into it).
    func save(_ config: KubeConfig) throws {
        guard let firstPath = config.paths.first else {
            throw CubeliteError.ioError(reason: "No kubeconfig path available for saving")
        }

        var onDisk: RawKubeConfig
        do {
            let data = try Data(contentsOf: firstPath)
            onDisk = try YAMLDecoder().decode(RawKubeConfig.self, from: data)
        } catch {
            throw CubeliteError.ioError(
                reason: "Cannot re-read kubeconfig for saving: \(firstPath.path)")
        }
        onDisk.currentContext = config.currentContext

        let yamlString = try YAMLEncoder().encode(onDisk)
        guard let data = yamlString.data(using: .utf8) else {
            throw CubeliteError.ioError(reason: "Failed to encode YAML to UTF-8 data")
        }

        try data.write(to: firstPath, options: .atomic)
    }
}
