import Foundation
import Security

/// Service actor for communicating with the Kubernetes API server.
///
/// Resolves the active kubeconfig context, builds authenticated requests,
/// and provides typed access to core Kubernetes resources (namespaces,
/// pods, deployments).
///
/// # Authentication
///
/// Currently supports **bearer token** authentication and custom CA trust.
/// Client certificate authentication is structurally prepared but requires
/// `KeychainService` (planned for M2) to create `SecIdentity`.
actor KubeAPIService {

    private let kubeconfigService: KubeconfigService

    /// Creates a new API service backed by the given kubeconfig service.
    ///
    /// - Parameter kubeconfigService: The service used to load kubeconfig state.
    init(kubeconfigService: KubeconfigService) {
        self.kubeconfigService = kubeconfigService
    }

    // MARK: - Public API

    /// Lists all namespaces visible to the given context (or the active context when `nil`).
    func listNamespaces(inContext contextName: String? = nil) async throws -> [NamespaceInfo] {
        let response: K8sListResponse<K8sNamespace> = try await fetch(
            path: "/api/v1/namespaces",
            contextName: contextName
        )
        return response.items.map { $0.toNamespaceInfo() }
    }

    /// Lists pods, optionally scoped to a namespace and/or context.
    ///
    /// - Parameters:
    ///   - namespace: If provided, only pods in this namespace are returned.
    ///     Passing `nil` lists pods across all namespaces.
    ///   - contextName: Kubeconfig context to use; defaults to the active context.
    func listPods(namespace: String? = nil, inContext contextName: String? = nil) async throws -> [PodInfo] {
        let path: String
        if let ns = namespace {
            let encoded = ns.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ns
            path = "/api/v1/namespaces/\(encoded)/pods"
        } else {
            path = "/api/v1/pods"
        }
        let response: K8sListResponse<K8sPod> = try await fetch(path: path, contextName: contextName)
        return response.items.map { $0.toPodInfo() }
    }

    /// Lists deployments, optionally scoped to a namespace and/or context.
    ///
    /// - Parameters:
    ///   - namespace: Namespace to query. Passing `nil` lists across all namespaces.
    ///   - contextName: Kubeconfig context to use; defaults to the active context.
    func listDeployments(namespace: String? = nil, inContext contextName: String? = nil) async throws -> [DeploymentInfo] {
        let path: String
        if let ns = namespace {
            let encoded = ns.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ns
            path = "/apis/apps/v1/namespaces/\(encoded)/deployments"
        } else {
            path = "/apis/apps/v1/deployments"
        }
        let response: K8sListResponse<K8sDeployment> = try await fetch(path: path, contextName: contextName)
        return response.items.map { $0.toDeploymentInfo() }
    }

    // MARK: - Internal Networking

    /// Fetches and decodes a JSON response from the Kubernetes API.
    ///
    /// - Parameters:
    ///   - path: API path to request.
    ///   - contextName: Override which kubeconfig context is used.
    private func fetch<T: Codable & Sendable>(path: String, contextName: String? = nil) async throws -> T {
        let config = try await kubeconfigService.load()
        let (cluster, user) = try resolveConnectionInfo(from: config, contextName: contextName)

        guard let serverString = cluster.server, !serverString.isEmpty else {
            throw CubeliteError.clientError(reason: "Cluster has no valid server URL")
        }

        let base = serverString.hasSuffix("/") ? String(serverString.dropLast()) : serverString
        guard let url = URL(string: base + path) else {
            throw CubeliteError.clientError(reason: "Invalid URL: \(base + path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        // Bearer token authentication
        if let token = user.token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let session = try makeSession(cluster: cluster, user: user)
        defer { session.finishTasksAndInvalidate() }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch let urlError as URLError where Self.isTLSError(urlError) {
            throw CubeliteError.tlsError(
                reason: "Certificate validation failed for the cluster API server"
            )
        } catch let urlError as URLError where Self.isConnectionError(urlError) {
            throw CubeliteError.clusterUnreachable
        } catch {
            throw CubeliteError.clientError(reason: "Network request failed: \(error.localizedDescription)")
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw CubeliteError.clientError(reason: "Invalid response from Kubernetes API")
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw CubeliteError.clientError(
                reason: "HTTP \(httpResponse.statusCode): \(body)"
            )
        }

        do {
            let decoder = JSONDecoder()
            return try decoder.decode(T.self, from: data)
        } catch {
            throw CubeliteError.clientError(
                reason: "Failed to decode API response: \(error.localizedDescription)"
            )
        }
    }

    /// URL error codes that indicate the cluster server is unreachable.
    static func isConnectionError(_ error: URLError) -> Bool {
        switch error.code {
        case .cannotConnectToHost,     // -1004: connection refused
             .timedOut,                // -1001: timeout
             .cannotFindHost,          // -1003: DNS failure
             .networkConnectionLost,   // -1005: connection dropped
             .notConnectedToInternet:  // -1009: no network
            return true
        default:
            return false
        }
    }

    /// URL error codes that indicate TLS certificate validation failure.
    static func isTLSError(_ error: URLError) -> Bool {
        switch error.code {
        case .serverCertificateUntrusted,
             .serverCertificateHasBadDate,
             .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid,
             .clientCertificateRejected:
            return true
        default:
            return false
        }
    }

    // MARK: - Connection Resolution

    /// Resolves the cluster and user details for the given or active context.
    ///
    /// - Parameters:
    ///   - config: Parsed kubeconfig.
    ///   - contextName: Override which context to resolve. Defaults to `config.currentContext`.
    private func resolveConnectionInfo(
        from config: KubeConfig,
        contextName: String? = nil
    ) throws -> (ClusterDetails, UserDetails) {
        let resolvedContext: String
        if let name = contextName {
            resolvedContext = name
        } else if let name = config.currentContext {
            resolvedContext = name
        } else {
            throw CubeliteError.contextNotFound(name: "<none> — no active context set")
        }

        guard let namedContext = config.raw.contexts?.first(where: { $0.name == resolvedContext }),
              let contextDetails = namedContext.context else {
            throw CubeliteError.contextNotFound(name: resolvedContext)
        }

        guard let clusterName = contextDetails.cluster,
              let namedCluster = config.raw.clusters?.first(where: { $0.name == clusterName }),
              let cluster = namedCluster.cluster else {
            throw CubeliteError.clientError(
                reason: "Cluster definition not found for context '\(resolvedContext)'"
            )
        }

        guard let userName = contextDetails.user,
              let namedUser = config.raw.users?.first(where: { $0.name == userName }),
              let user = namedUser.user else {
            throw CubeliteError.clientError(
                reason: "User definition not found for context '\(resolvedContext)'"
            )
        }

        return (cluster, user)
    }

    // MARK: - URLSession Factory

    /// Creates a configured `URLSession` with TLS and optional client certificate support.
    private func makeSession(
        cluster: ClusterDetails,
        user: UserDetails
    ) throws -> URLSession {
        let caCertificate = try Self.loadCACertificate(from: cluster)
        let clientIdentity = try Self.loadClientIdentity(from: user)
        let insecureSkip = cluster.insecureSkipTlsVerify ?? false

        let delegate = KubeURLSessionDelegate(
            trustedCertificate: caCertificate,
            clientIdentity: clientIdentity,
            insecureSkipTLS: insecureSkip
        )

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60

        return URLSession(
            configuration: configuration,
            delegate: delegate,
            delegateQueue: nil
        )
    }

    // MARK: - TLS Helpers

    /// Loads the CA certificate from the cluster config.
    ///
    /// Tries inline base64 (`certificate-authority-data`) first, then falls back
    /// to reading the PEM file at `certificate-authority`.
    static func loadCACertificate(from cluster: ClusterDetails) throws -> SecCertificate? {
        // Try inline base64 data first
        if let b64 = cluster.certificateAuthorityData, !b64.isEmpty {
            guard let derData = Data(base64Encoded: b64) else {
                throw CubeliteError.clientError(reason: "Invalid base64 in certificate-authority-data")
            }
            guard let certificate = SecCertificateCreateWithData(nil, derData as CFData) else {
                throw CubeliteError.clientError(reason: "Failed to create CA certificate from DER data")
            }
            return certificate
        }

        // Fall back to certificate-authority file path
        if let path = cluster.certificateAuthority, !path.isEmpty {
            let expandedPath = NSString(string: path).expandingTildeInPath
            let url = URL(fileURLWithPath: expandedPath)

            let pemData: Data
            do {
                pemData = try Data(contentsOf: url)
            } catch {
                throw CubeliteError.clientError(
                    reason: "Cannot read CA certificate file: \(path)"
                )
            }

            let derData = try pemToDER(pemData)
            guard let certificate = SecCertificateCreateWithData(nil, derData as CFData) else {
                throw CubeliteError.clientError(
                    reason: "Failed to create CA certificate from file: \(path)"
                )
            }
            return certificate
        }

        return nil
    }

    /// Attempts to load a client identity from base64-encoded certificate and key data.
    ///
    /// Returns `nil` when no client certificate data is configured. Full client
    /// certificate authentication requires `KeychainService` (planned for M2)
    /// to construct a `SecIdentity` from raw certificate and key material.
    private static func loadClientIdentity(from user: UserDetails) throws -> SecIdentity? {
        guard let certB64 = user.clientCertificateData, !certB64.isEmpty,
              let keyB64 = user.clientKeyData, !keyB64.isEmpty else {
            return nil
        }

        guard let certDER = Data(base64Encoded: certB64) else {
            throw CubeliteError.clientError(reason: "Invalid base64 in client-certificate-data")
        }

        guard Data(base64Encoded: keyB64) != nil else {
            throw CubeliteError.clientError(reason: "Invalid base64 in client-key-data")
        }

        // Validate the certificate is parseable
        guard SecCertificateCreateWithData(nil, certDER as CFData) != nil else {
            throw CubeliteError.clientError(reason: "Failed to parse client certificate")
        }

        // Creating a SecIdentity from raw cert + key data requires importing
        // both into the Keychain. This will be enabled in M2 via KeychainService.
        return nil
    }

    /// Converts PEM-encoded certificate data to DER format.
    ///
    /// Strips the `-----BEGIN CERTIFICATE-----` / `-----END CERTIFICATE-----`
    /// markers and decodes the base64 content.
    static func pemToDER(_ pemData: Data) throws -> Data {
        guard let pemString = String(data: pemData, encoding: .utf8) else {
            throw CubeliteError.clientError(reason: "CA certificate file is not valid UTF-8")
        }

        let base64Content = pemString
            .replacingOccurrences(of: "\r", with: "")
            .split(separator: "\n")
            .filter { !$0.hasPrefix("-----") }
            .joined()

        guard let derData = Data(base64Encoded: base64Content) else {
            throw CubeliteError.clientError(reason: "Failed to decode PEM certificate content")
        }

        return derData
    }
}

// MARK: - URLSession Delegate

/// Handles TLS server trust evaluation and optional client certificate
/// authentication for Kubernetes API connections.
///
/// All stored properties are immutable (`let`), making concurrent access safe.
/// The `@unchecked Sendable` annotation is justified because:
/// - `SecCertificate` and `SecIdentity` are immutable Core Foundation objects
/// - `Bool` is a value type
/// - No mutable state exists after initialization
private final class KubeURLSessionDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {

    let trustedCertificate: SecCertificate?
    let clientIdentity: SecIdentity?
    let insecureSkipTLS: Bool

    init(
        trustedCertificate: SecCertificate?,
        clientIdentity: SecIdentity?,
        insecureSkipTLS: Bool
    ) {
        self.trustedCertificate = trustedCertificate
        self.clientIdentity = clientIdentity
        self.insecureSkipTLS = insecureSkipTLS
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        let method = challenge.protectionSpace.authenticationMethod

        // Server trust evaluation
        if method == NSURLAuthenticationMethodServerTrust {
            guard let trust = challenge.protectionSpace.serverTrust else {
                return (.performDefaultHandling, nil)
            }

            // Skip TLS verification when configured
            if insecureSkipTLS {
                return (.useCredential, URLCredential(trust: trust))
            }

            // Use custom CA certificate as trust anchor
            if let ca = trustedCertificate {
                SecTrustSetAnchorCertificates(trust, [ca] as CFArray)
                SecTrustSetAnchorCertificatesOnly(trust, true)

                var error: CFError?
                if SecTrustEvaluateWithError(trust, &error) {
                    return (.useCredential, URLCredential(trust: trust))
                } else {
                    return (.cancelAuthenticationChallenge, nil)
                }
            }
        }

        // Client certificate authentication
        if method == NSURLAuthenticationMethodClientCertificate {
            if let identity = clientIdentity {
                let credential = URLCredential(
                    identity: identity,
                    certificates: nil,
                    persistence: .forSession
                )
                return (.useCredential, credential)
            }
        }

        return (.performDefaultHandling, nil)
    }
}
