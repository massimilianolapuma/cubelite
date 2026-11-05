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
    /// Auto-discovery scans `~/.kube/` for files that pass
    /// `isKubeconfigFile(at:)`. The default `config` file always comes first
    /// so its `current-context` takes precedence during merge.
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

    /// Scans a directory for kubeconfig files, sorted by name.
    ///
    /// A file qualifies when it passes `isKubeconfigFile(at:)`: the whole file
    /// is parsed, because kubectl writes keys alphabetically and puts `kind`
    /// after the inline certificates (a header check missed those, #473).
    /// Hidden files, directories such as `cache/`, and `excluded` are skipped.
    static func discoverKubeconfigFiles(
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
                url.standardizedFileURL != excluded.standardizedFileURL
                    && isKubeconfigFile(at: url)
            }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    /// Largest file `isKubeconfigFile(at:)` will read. Real kubeconfigs are a
    /// few tens of KB even with inline certificates; the cap keeps a large
    /// file picked by mistake from stalling the UI while it is parsed.
    static let maxKubeconfigFileSize = 16 * 1024 * 1024

    /// Returns `true` when `url` is a kubeconfig document: a regular file (a
    /// symlink is followed) that parses as a kubeconfig (YAML or JSON) and
    /// either declares `kind: Config` or — `kind` absent, as kubectl
    /// tolerates (#481) — has at least one cluster, context or user.
    ///
    /// Every kubeconfig field is optional, so a bare parse accepts any YAML or
    /// JSON mapping as an empty config; the `kind` / entries check is what
    /// tells a kubeconfig apart from an unrelated file. The whole file is parsed
    /// because `kubectl` writes keys in alphabetical order, which puts `kind`
    /// after the inline certificates. Same rule as the desktop app (#448);
    /// used to validate files added from Preferences (#450).
    static func isKubeconfigFile(at url: URL) -> Bool {
        // Resource values describe a symlink itself, not its target.
        let target = url.resolvingSymlinksInPath()
        guard
            let values = try? target.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
            values.isRegularFile == true,
            (values.fileSize ?? 0) <= maxKubeconfigFileSize,
            let data = try? Data(contentsOf: target),
            let raw = try? YAMLDecoder().decode(RawKubeConfig.self, from: data)
        else { return false }
        guard let kind = raw.kind else {
            return !(raw.clusters ?? []).isEmpty || !(raw.contexts ?? []).isEmpty
                || !(raw.users ?? []).isEmpty
        }
        return kind == "Config"
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
    /// - A context uses the cluster and user its own file defines under the
    ///   referenced names, falling back to the first file that defines them
    ///   (see `KubeconfigMerge`, #543).
    /// - Bearer tokens are migrated to the Keychain and stripped from the
    ///   returned model (see the type-level documentation).
    func loadFromPaths(_ paths: [URL]) async throws -> KubeConfig {
        guard !paths.isEmpty else {
            throw CubeliteError.fileNotFound(path: "No kubeconfig paths resolved")
        }

        let decoder = YAMLDecoder()
        var files: [(path: URL, config: RawKubeConfig)] = []
        for path in paths where FileManager.default.fileExists(atPath: path.path) {
            let data = try Data(contentsOf: path)
            files.append((path, try decoder.decode(RawKubeConfig.self, from: data)))
        }

        guard var raw = files.first?.config else {
            throw CubeliteError.fileNotFound(
                path: paths.map(\.path).joined(separator: ":")
            )
        }

        let merge = KubeconfigMerge(files: files)
        raw.contexts = merge.contexts
        raw.clusters = merge.clusters
        raw.users = merge.users
        raw.currentContext = merge.currentContext
        var config = KubeConfig(
            contexts: merge.contexts.map(\.name),
            currentContext: merge.currentContext,
            raw: raw,
            paths: paths,
            ownClusters: merge.ownClusters,
            ownUsers: merge.ownUsers
        )

        await migrateTokensToKeychain(config)

        // Bearer tokens are redacted now that the Keychain holds them.
        config.raw.users = merge.users.map(Self.redactingToken)
        config.ownUsers = merge.ownUsers.mapValues(Self.redactingToken)
        return config
    }

    private static func redactingToken(_ named: NamedUser) -> NamedUser {
        NamedUser(name: named.name, user: named.user?.redactingToken())
    }

    /// Per file of `paths`, in order: the cluster and user names it defines
    /// differently from an earlier file (Preferences, #543). Missing and
    /// unreadable files are skipped; files without such names are left out.
    static func redefinitions(in paths: [URL]) -> [KubeconfigRedefinition] {
        let files = paths.compactMap { path -> (path: URL, yaml: String)? in
            guard let data = try? Data(contentsOf: path) else { return nil }
            return (path, String(decoding: data, as: UTF8.self))
        }
        return KubeconfigRedefinition.scan(files)
    }

    // MARK: - Credential Migration

    /// Imports every bearer token referenced by a context into the Keychain,
    /// keyed by the server URL of the cluster that context connects to
    /// (trailing slash dropped, matching `KubeAPIService` session accounts).
    /// An existing Keychain entry wins over the file copy, so user edits made
    /// via "Reset stored credentials" or the Keychain itself are never
    /// clobbered — except a stale import: when the context's own file defines
    /// its user differently from an earlier file and the Keychain holds that
    /// earlier (first-wins) file token, builds before #543 imported the wrong
    /// token, so it is replaced with the context file's token.
    private func migrateTokensToKeychain(_ config: KubeConfig) async {
        for context in config.contexts {
            guard
                let server = config.cluster(forContext: context)?.cluster?.server,
                !server.isEmpty,
                let token = config.user(forContext: context)?.user?.token, !token.isEmpty
            else { continue }
            let account = server.hasSuffix("/") ? String(server.dropLast()) : server

            if let existing = try? await keychain.retrieveString(
                tag: .bearerToken, account: account), !existing.isEmpty,
                existing == token || existing != Self.staleFileToken(for: context, in: config)
            {
                continue
            }
            try? await keychain.storeString(token, tag: .bearerToken, account: account)
        }
    }

    /// The first-wins file token of the user `context` references, when the
    /// context's own file defines that user differently; `nil` otherwise.
    private static func staleFileToken(for context: String, in config: KubeConfig) -> String? {
        guard
            let own = config.ownUsers[context],
            let merged = config.raw.users?.first(where: { $0.name == own.name }),
            merged.user != own.user,
            let stale = merged.user?.token, !stale.isEmpty
        else { return nil }
        return stale
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
