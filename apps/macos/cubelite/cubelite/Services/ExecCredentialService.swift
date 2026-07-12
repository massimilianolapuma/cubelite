import Foundation

/// Credentials returned by an exec credential plugin
/// (`ExecCredential.status` in client.authentication.k8s.io).
struct ExecCredentialResult: Sendable {
    let token: String?
    /// PEM text, unlike the kubeconfig's base64 `client-certificate-data`.
    let clientCertificatePEM: String?
    let clientKeyPEM: String?
    let expirationTimestamp: Date?
}

/// Runs kubeconfig `exec` credential plugins (kubelogin, aws,
/// gke-gcloud-auth-plugin, …) and caches their short-lived credentials.
///
/// GUI apps launch with a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so
/// plugin binaries installed by Homebrew or cloud SDKs are resolved against
/// an augmented search path as well as any absolute path in the kubeconfig.
actor ExecCredentialService {

    /// Extra directories searched after the inherited PATH; covers Homebrew
    /// (both architectures), cloud SDK defaults, and krew.
    static let fallbackSearchPaths = [
        "/opt/homebrew/bin", "/usr/local/bin", "/opt/homebrew/sbin",
        "/usr/local/sbin", "/usr/local/opt", "/usr/bin", "/bin",
    ]

    /// Credentials without an expiration are reused for this long.
    private static let noExpiryCacheInterval: TimeInterval = 600
    /// Refresh this far ahead of the plugin-reported expiration.
    private static let expiryLeeway: TimeInterval = 60
    private static let pluginTimeout: TimeInterval = 30

    private struct CacheEntry {
        let result: ExecCredentialResult
        let refreshAfter: Date
    }

    private var cache: [String: CacheEntry] = [:]

    /// Returns plugin credentials for `exec`, reusing the cached result until
    /// shortly before its expiration. `cacheKey` is the cluster server URL.
    func credentials(for exec: ExecConfig, cacheKey: String) async throws -> ExecCredentialResult {
        if let entry = cache[cacheKey], entry.refreshAfter > Date() {
            return entry.result
        }
        let result = try await run(exec)
        let refreshAfter =
            result.expirationTimestamp.map { $0.addingTimeInterval(-Self.expiryLeeway) }
            ?? Date().addingTimeInterval(Self.noExpiryCacheInterval)
        cache[cacheKey] = CacheEntry(result: result, refreshAfter: refreshAfter)
        return result
    }

    /// Drops all cached plugin credentials (Settings "Reset stored credentials").
    func invalidateCache() {
        cache.removeAll()
    }

    // MARK: - Plugin execution

    private func run(_ exec: ExecConfig) async throws -> ExecCredentialResult {
        if exec.interactiveMode == "Always" {
            throw CubeliteError.clientError(
                reason:
                    "Credential plugin '\(exec.command)' requires an interactive terminal, which a GUI app cannot provide"
            )
        }
        guard let executable = Self.resolveExecutable(exec.command) else {
            throw CubeliteError.clientError(
                reason:
                    "Credential plugin '\(exec.command)' not found — install it or use an absolute path in the kubeconfig exec block"
            )
        }

        let process = Process()
        process.executableURL = executable
        process.arguments = exec.args ?? []
        process.environment = Self.environment(for: exec)
        process.standardInput = FileHandle.nullDevice
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        let status: Int32 = try await withCheckedThrowingContinuation { continuation in
            process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
            do {
                try process.run()
            } catch {
                process.terminationHandler = nil
                continuation.resume(
                    throwing: CubeliteError.clientError(
                        reason:
                            "Credential plugin '\(exec.command)' failed to launch: \(error.localizedDescription)"
                    ))
                return
            }
            // Watchdog: kill plugins that hang (e.g. waiting on a browser flow).
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.pluginTimeout) {
                if process.isRunning { process.terminate() }
            }
        }

        let outData = stdout.fileHandleForReading.readDataToEndOfFile()
        guard status == 0 else {
            let errData = stderr.fileHandleForReading.readDataToEndOfFile()
            let errText = String(data: errData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let detail = errText.isEmpty ? "" : ": \(errText.prefix(300))"
            throw CubeliteError.clientError(
                reason: "Credential plugin '\(exec.command)' exited with status \(status)\(detail)"
            )
        }

        return try Self.parseExecCredential(outData, command: exec.command)
    }

    /// Resolves the plugin command against PATH plus well-known install
    /// locations. Absolute/relative paths containing "/" are used as-is.
    static func resolveExecutable(_ command: String) -> URL? {
        let fm = FileManager.default
        if command.contains("/") {
            let url = URL(fileURLWithPath: (command as NSString).expandingTildeInPath)
            return fm.isExecutableFile(atPath: url.path) ? url : nil
        }
        let inheritedPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
        var directories = inheritedPath.split(separator: ":").map(String.init)
        for fallback in fallbackSearchPaths where !directories.contains(fallback) {
            directories.append(fallback)
        }
        for dir in directories {
            let candidate = (dir as NSString).appendingPathComponent(command)
            if fm.isExecutableFile(atPath: candidate) {
                return URL(fileURLWithPath: candidate)
            }
        }
        return nil
    }

    /// Child environment: inherited vars, augmented PATH, the exec block's
    /// own env entries, and KUBERNETES_EXEC_INFO per the client.authentication
    /// contract.
    private static func environment(for exec: ExecConfig) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let inherited = env["PATH"] ?? ""
        var parts = inherited.split(separator: ":").map(String.init)
        for fallback in fallbackSearchPaths where !parts.contains(fallback) {
            parts.append(fallback)
        }
        env["PATH"] = parts.joined(separator: ":")
        for pair in exec.env ?? [] {
            env[pair.name] = pair.value
        }
        let apiVersion = exec.apiVersion ?? "client.authentication.k8s.io/v1"
        env["KUBERNETES_EXEC_INFO"] =
            #"{"kind":"ExecCredential","apiVersion":"\#(apiVersion)","spec":{"interactive":false}}"#
        return env
    }

    // MARK: - Response parsing

    private struct ExecCredentialResponse: Decodable {
        struct Status: Decodable {
            let token: String?
            let clientCertificateData: String?
            let clientKeyData: String?
            let expirationTimestamp: String?
        }
        let status: Status?
    }

    static func parseExecCredential(_ data: Data, command: String) throws -> ExecCredentialResult {
        let response: ExecCredentialResponse
        do {
            response = try JSONDecoder().decode(ExecCredentialResponse.self, from: data)
        } catch {
            throw CubeliteError.clientError(
                reason: "Credential plugin '\(command)' returned invalid ExecCredential JSON"
            )
        }
        guard let status = response.status,
            status.token != nil || status.clientCertificateData != nil
        else {
            throw CubeliteError.clientError(
                reason: "Credential plugin '\(command)' returned no credentials in status"
            )
        }

        var expiry: Date?
        if let stamp = status.expirationTimestamp {
            let iso = ISO8601DateFormatter()
            expiry = iso.date(from: stamp)
            if expiry == nil {
                iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                expiry = iso.date(from: stamp)
            }
        }
        return ExecCredentialResult(
            token: status.token,
            clientCertificatePEM: status.clientCertificateData,
            clientKeyPEM: status.clientKeyData,
            expirationTimestamp: expiry
        )
    }
}
