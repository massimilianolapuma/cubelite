import XCTest

@testable import cubelite

// MARK: - KubeconfigFixturesTests

/// Runs every case of the shared kubeconfig corpus (`testdata/kubeconfig`,
/// #548) through `KubeconfigService.loadFromPaths`, `KubeConfig`'s
/// `cluster(forContext:)` / `user(forContext:)` and the Preferences
/// redefinition scan, and compares the result with the case's
/// `expected.json`. `cubelite-core` runs the same cases
/// (`tests/kubeconfig_fixtures.rs`); the schema is in
/// `testdata/kubeconfig/README.md`. A new case directory is picked up without
/// code changes.
///
/// The native app does not expose per-file context counts or shadowed names,
/// so of `sources` only the redefined cluster and user names are checked.
final class KubeconfigFixturesTests: XCTestCase {

    /// Expectations the app does not meet yet: case → (field prefix, issue).
    /// Mismatches on these fields are expected failures; a listed field that
    /// matches fails the test, so the entry is removed once fixed.
    private static let knownFailures: [(case: String, field: String, issue: Int)] = [
        // The first file's `current-context: ""` wins over the next file's.
        (case: "empty-current-context", field: "current_context", issue: 552),
        (case: "kubectl-null-lists", field: "current_context", issue: 552),
        // Relative certificate paths are read from the working directory.
        (case: "client-cert-files", field: "contexts[lab-1].auth", issue: 553),
        (case: "client-cert-files", field: "contexts[lab-2].auth", issue: 553),
    ]

    private let keychain = KeychainService()
    private var servers: [String] = []

    override func tearDown() async throws {
        await forgetTokens()
    }

    func testEveryCaseMatchesItsExpectations() async throws {
        let cases = try Self.caseDirectories()
        XCTAssertGreaterThanOrEqual(cases.count, 10, "corpus not found at \(Self.corpus.path)")

        // Collected and reported once: XCTest folds similar failures recorded
        // in a loop into one entry, which would hide cases.
        var unexpected: [String] = []
        var expected: [Int: [String]] = [:]
        for dir in cases {
            let name = dir.lastPathComponent
            let mismatches = try await run(dir)
            var matchedKnown: Set<String> = []
            for mismatch in mismatches {
                let line = "\(name): \(mismatch.field): \(mismatch.message)"
                if let known = Self.knownFailures.first(where: {
                    $0.case == name && mismatch.field.hasPrefix($0.field)
                }) {
                    matchedKnown.insert(known.field)
                    expected[known.issue, default: []].append(line)
                } else {
                    unexpected.append(line)
                }
            }
            for known in Self.knownFailures where known.case == name {
                if !matchedKnown.contains(known.field) {
                    unexpected.append(
                        "\(name): \(known.field): listed as known failure #\(known.issue) but"
                            + " matches; remove it from knownFailures")
                }
            }
        }
        for (issue, lines) in expected.sorted(by: { $0.key < $1.key }) {
            XCTExpectFailure("#\(issue)") {
                XCTFail("\n" + lines.joined(separator: "\n"))
            }
        }
        if !unexpected.isEmpty {
            XCTFail("\n" + unexpected.joined(separator: "\n"))
        }
    }

    // MARK: - Case runner

    private struct Mismatch {
        let field: String
        let message: String
    }

    private func run(_ dir: URL) async throws -> [Mismatch] {
        let data = try Data(contentsOf: dir.appendingPathComponent("expected.json"))
        let expected = try JSONDecoder().decode(Expected.self, from: data)
        var found: [Mismatch] = []
        func check<T: Equatable>(_ field: String, _ got: T, _ want: T) {
            if got != want {
                found.append(Mismatch(field: field, message: "got \(got), want \(want)"))
            }
        }

        let files = try Self.kubeconfigFiles(in: dir)
        check("files", files, expected.sources.map(\.file))
        let paths = files.map { dir.appendingPathComponent($0) }

        // Tokens are migrated into the Keychain under the server URL during
        // load; start from a clean slate so an earlier copy cannot win.
        await forgetTokens()
        servers = expected.contexts.compactMap(\.server)
        await forgetTokens()
        let config = try await KubeconfigService(keychain: keychain).loadFromPaths(paths)

        check("current_context", config.currentContext, expected.currentContext)
        check("contexts", config.contexts, expected.contexts.map(\.name))
        for want in expected.contexts {
            let field = { (name: String) in "contexts[\(want.name)].\(name)" }
            let details = config.raw.contexts?.first(where: { $0.name == want.name })?.context
            check(field("cluster"), details?.cluster, want.cluster)
            check(field("user"), details?.user, want.user)
            let namespace = config.defaultNamespace(for: want.name) ?? "default"
            check(field("namespace"), namespace, want.namespace)
            let server = config.cluster(forContext: want.name)?.cluster?.server
            check(field("server"), server, want.server)
            let auth = await authentication(of: want.name, server: server, in: config, dir: dir)
            check(field("auth"), auth, want.auth)
        }

        let redefinitions = KubeconfigService.redefinitions(in: paths)
        for (path, want) in zip(paths, expected.sources) {
            let got = redefinitions.first(where: { $0.path == path.path })
            let field = { (name: String) in "sources[\(want.file)].\(name)" }
            check(field("redefined_clusters"), got?.clusters ?? [], want.redefinedClusters)
            check(field("redefined_users"), got?.users ?? [], want.redefinedUsers)
        }
        return found
    }

    /// The credential the app would authenticate `context` with, resolved
    /// like `KubeAPIService.connection(contextName:)`: an exec plugin, else
    /// the Keychain bearer token of the server (file tokens are moved there
    /// at load), else a client certificate — inline, or the file
    /// `KubeAPIService.loadClientIdentity` opens.
    private func authentication(
        of context: String, server: String?, in config: KubeConfig, dir: URL
    ) async -> ExpectedAuth {
        let user = config.user(forContext: context)?.user
        if let exec = user?.exec {
            return ExpectedAuth(kind: "exec", command: exec.command, args: exec.args ?? [])
        }
        if let server, !server.isEmpty {
            let account = server.hasSuffix("/") ? String(server.dropLast()) : server
            if let token = try? await keychain.retrieveString(tag: .bearerToken, account: account),
                !token.isEmpty
            {
                return ExpectedAuth(kind: "token", token: token)
            }
        }
        if let data = user?.clientCertificateData, !data.isEmpty {
            return ExpectedAuth(kind: "client-cert-data", clientCertificateData: data)
        }
        if let cert = user?.clientCertificate, !cert.isEmpty {
            return ExpectedAuth(
                kind: "client-cert-file",
                clientCertificate: Self.openedFile(cert, relativeTo: dir),
                clientKey: user?.clientKey.map { Self.openedFile($0, relativeTo: dir) })
        }
        return ExpectedAuth(kind: "none")
    }

    /// The file `KubeAPIService.loadClientIdentity` reads for a kubeconfig
    /// path, relative to `dir` when it lies inside it.
    private static func openedFile(_ path: String, relativeTo dir: URL) -> String {
        let expanded = NSString(string: path).expandingTildeInPath
        let opened = URL(fileURLWithPath: expanded).standardizedFileURL.path
        let prefix = dir.standardizedFileURL.path + "/"
        return opened.hasPrefix(prefix) ? String(opened.dropFirst(prefix.count)) : opened
    }

    private func forgetTokens() async {
        for server in servers {
            let account = server.hasSuffix("/") ? String(server.dropLast()) : server
            try? await keychain.delete(tag: .bearerToken, account: account)
        }
    }

    // MARK: - Corpus

    /// `testdata/kubeconfig` at the repository root, found from this file.
    private static let corpus = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // cubeliteTests
        .deletingLastPathComponent()  // cubelite
        .deletingLastPathComponent()  // macos
        .deletingLastPathComponent()  // apps
        .deletingLastPathComponent()  // repository root
        .appendingPathComponent("testdata/kubeconfig")

    private static func caseDirectories() throws -> [URL] {
        let fm = FileManager.default
        return try fm.contentsOfDirectory(at: corpus, includingPropertiesForKeys: nil)
            .filter { fm.fileExists(atPath: $0.appendingPathComponent("expected.json").path) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    /// Every `*.yaml` file under `dir`, relative to it, in lexical order: the
    /// merge order of the case.
    private static func kubeconfigFiles(in dir: URL) throws -> [String] {
        try FileManager.default.subpathsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".yaml") }
            .sorted()
    }
}

// MARK: - Schema (testdata/kubeconfig/README.md)

private struct Expected: Decodable {
    let currentContext: String?
    let contexts: [ExpectedContext]
    let sources: [ExpectedSource]

    enum CodingKeys: String, CodingKey {
        case currentContext = "current_context"
        case contexts
        case sources
    }
}

private struct ExpectedContext: Decodable {
    let name: String
    let cluster: String?
    let server: String?
    let user: String?
    let namespace: String
    let auth: ExpectedAuth
}

private struct ExpectedSource: Decodable {
    let file: String
    let redefinedClusters: [String]
    let redefinedUsers: [String]

    enum CodingKeys: String, CodingKey {
        case file
        case redefinedClusters = "redefined_clusters"
        case redefinedUsers = "redefined_users"
    }
}

/// The credential a context authenticates with; only the fields of `kind`
/// are set. File paths are relative to the case directory.
private struct ExpectedAuth: Decodable, Equatable, CustomStringConvertible {
    var kind: String
    var token: String?
    var command: String?
    var args: [String]?
    var clientCertificate: String?
    var clientKey: String?
    var clientCertificateData: String?

    init(
        kind: String, token: String? = nil, command: String? = nil, args: [String]? = nil,
        clientCertificate: String? = nil, clientKey: String? = nil,
        clientCertificateData: String? = nil
    ) {
        self.kind = kind
        self.token = token
        self.command = command
        self.args = args
        self.clientCertificate = clientCertificate
        self.clientKey = clientKey
        self.clientCertificateData = clientCertificateData
    }

    enum CodingKeys: String, CodingKey {
        case kind
        case token
        case command
        case args
        case clientCertificate = "client_certificate"
        case clientKey = "client_key"
        case clientCertificateData = "client_certificate_data"
    }

    var description: String {
        let fields: [(String, String?)] = [
            ("token", token), ("command", command), ("args", args.map { "\($0)" }),
            ("client_certificate", clientCertificate), ("client_key", clientKey),
            ("client_certificate_data", clientCertificateData),
        ]
        let set = fields.compactMap { name, value in value.map { "\(name): \($0)" } }
        return "\(kind)(\(set.joined(separator: ", ")))"
    }
}
