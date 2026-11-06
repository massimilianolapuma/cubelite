import XCTest

@testable import cubelite

// MARK: - KubeconfigFixturesTests

/// Runs every case of the shared kubeconfig corpus (`testdata/kubeconfig`,
/// #548) through the app's own code and compares the result with the case's
/// `expected.json`: `KubeconfigService.loadFromPaths`, `KubeConfig`'s
/// `cluster(forContext:)`, the Preferences redefinition scan, and for
/// credentials `KubeAPIService.connectionUser(in:context:)`,
/// `clientCertificateSource(of:)` and `kubeconfigFileURL(_:)` — the
/// selection `connection(contextName:)` and `loadClientIdentity` use.
/// `cubelite-core` runs the same cases (`tests/kubeconfig_fixtures.rs`); the
/// schema is in `testdata/kubeconfig/README.md`. A new case directory is
/// picked up without code changes.
///
/// The native app does not expose per-file context counts or shadowed names,
/// so of `sources` only the redefined cluster and user names are checked.
final class KubeconfigFixturesTests: XCTestCase {

    /// Expectations the app does not meet yet, with the exact field and the
    /// value observed today. Such a mismatch is an expected failure; any
    /// other value of the field fails, and so does a listed field that
    /// matches, so the entry is removed once fixed.
    private static let knownFailures: [KnownFailure] = [
        // The first file's `current-context: ""` wins over the next file's.
        KnownFailure("empty-current-context", "current_context", issue: 552, got: #"Optional("")"#),
        KnownFailure("kubectl-null-lists", "current_context", issue: 552, got: #"Optional("")"#),
        // Relative certificate paths are read from the working directory.
        KnownFailure(
            "client-cert-files", "contexts[lab-1].auth", issue: 553,
            got: "client-cert-file(client_certificate: $PWD/certs/client.crt,"
                + " client_key: $PWD/certs/client.key)"),
        KnownFailure(
            "client-cert-files", "contexts[lab-2].auth", issue: 553,
            got: "client-cert-file(client_certificate: $PWD/certs/client.crt,"
                + " client_key: $PWD/certs/client.key)"),
        // A context without a user, or with an undefined one, cannot connect.
        KnownFailure(
            "missing-references", "contexts[no-user].auth", issue: 561,
            got: #"error(User definition not found for context 'no-user')"#),
        KnownFailure(
            "missing-references", "contexts[unknown-user].auth", issue: 561,
            got: #"error(User definition not found for context 'unknown-user')"#),
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
            let mismatches: [Mismatch]
            do {
                mismatches = try await run(dir)
            } catch {
                mismatches = [Mismatch(field: "load", got: "error(\(error))", want: "ok")]
            }
            var matchedKnown: [KnownFailure] = []
            for mismatch in mismatches {
                let line = "\(name): \(mismatch.field): got \(mismatch.got), want \(mismatch.want)"
                if let known = Self.knownFailures.first(where: {
                    $0.case == name && $0.field == mismatch.field && $0.got == mismatch.got
                }) {
                    matchedKnown.append(known)
                    expected[known.issue, default: []].append(line)
                } else {
                    unexpected.append(line)
                }
            }
            for known in Self.knownFailures where known.case == name {
                if !matchedKnown.contains(known) {
                    unexpected.append(
                        "\(name): \(known.field): listed as known failure #\(known.issue) with"
                            + " \(known.got) but no longer shows it; update knownFailures")
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

    private struct KnownFailure: Equatable {
        let `case`: String
        let field: String
        let got: String
        let issue: Int

        init(_ name: String, _ field: String, issue: Int, got: String) {
            self.case = name
            self.field = field
            self.got = got
            self.issue = issue
        }
    }

    private struct Mismatch {
        let field: String
        let got: String
        let want: String
    }

    private func run(_ dir: URL) async throws -> [Mismatch] {
        let expectedURL = dir.appendingPathComponent("expected.json")
        guard FileManager.default.fileExists(atPath: expectedURL.path) else {
            return [Mismatch(field: "expected.json", got: "missing", want: "present")]
        }
        let expected = try JSONDecoder().decode(Expected.self, from: Data(contentsOf: expectedURL))
        var found: [Mismatch] = []
        func check<T: Equatable>(_ field: String, _ got: T, _ want: T) {
            if got != want {
                found.append(Mismatch(field: field, got: "\(got)", want: "\(want)"))
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
            check(field("auth"), auth, .ok(want.auth))
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

    /// The credential the app authenticates `context` with, chosen by the
    /// app's own code: the user `KubeAPIService.connectionUser` resolves
    /// (an error when there is none), its exec plugin, else the Keychain
    /// bearer token of the server (load moves file tokens there), else the
    /// client certificate `KubeAPIService.clientCertificateSource` picks,
    /// read from `KubeAPIService.kubeconfigFileURL`.
    private func authentication(
        of context: String, server: String?, in config: KubeConfig, dir: URL
    ) async -> ObservedAuth {
        let user: UserDetails
        do {
            user = try KubeAPIService.connectionUser(in: config, context: context).user
        } catch CubeliteError.clientError(let reason) {
            return .error(reason)
        } catch {
            return .error("\(error)")
        }
        if let exec = user.exec {
            return .ok(ExpectedAuth(kind: "exec", command: exec.command, args: exec.args ?? []))
        }
        if let server, !server.isEmpty {
            let account = server.hasSuffix("/") ? String(server.dropLast()) : server
            if let token = try? await keychain.retrieveString(tag: .bearerToken, account: account),
                !token.isEmpty
            {
                return .ok(ExpectedAuth(kind: "token", token: token))
            }
        }
        switch KubeAPIService.clientCertificateSource(of: user) {
        case .inline(let certificateData, _):
            return .ok(
                ExpectedAuth(kind: "client-cert-data", clientCertificateData: certificateData))
        case .files(let certificatePath, let keyPath):
            let opened = { (path: String) in
                Self.display(KubeAPIService.kubeconfigFileURL(path), in: dir)
            }
            return .ok(
                ExpectedAuth(
                    kind: "client-cert-file", clientCertificate: opened(certificatePath),
                    clientKey: opened(keyPath)))
        case nil:
            return .ok(ExpectedAuth(kind: "none"))
        }
    }

    /// `url` relative to `dir` when it lies inside it, else with the working
    /// directory shown as `$PWD` so the value does not depend on where the
    /// test runs.
    private static func display(_ url: URL, in dir: URL) -> String {
        let path = url.standardizedFileURL.path
        let inside = dir.standardizedFileURL.path + "/"
        if path.hasPrefix(inside) { return String(path.dropFirst(inside.count)) }
        let cwd = FileManager.default.currentDirectoryPath
        let pwd = cwd.hasSuffix("/") ? cwd : cwd + "/"
        if path.hasPrefix(pwd) { return "$PWD/" + path.dropFirst(pwd.count) }
        return path
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

    /// Every directory of the corpus; one without `expected.json` fails.
    private static func caseDirectories() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(
            at: corpus, includingPropertiesForKeys: [.isDirectoryKey]
        )
        .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
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

/// What the app authenticates a context with, or why it cannot.
private enum ObservedAuth: Equatable, CustomStringConvertible {
    case ok(ExpectedAuth)
    case error(String)

    var description: String {
        switch self {
        case .ok(let auth): return auth.description
        case .error(let reason): return "error(\(reason))"
        }
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
