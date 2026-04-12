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

    /// Lists all namespaces visible to the current context.
    func listNamespaces() async throws -> [NamespaceInfo] {
        let response: K8sListResponse<K8sNamespace> = try await fetch(path: "/api/v1/namespaces")
        return response.items.map { $0.toNamespaceInfo() }
    }

    /// Lists pods, optionally scoped to a specific namespace.
    ///
    /// - Parameter namespace: If provided, only pods in this namespace are returned.
    ///   When `nil`, pods across all namespaces are listed.
    func listPods(namespace: String? = nil) async throws -> [PodInfo] {
        let path: String
        if let ns = namespace {
            let encoded = ns.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ns
            path = "/api/v1/namespaces/\(encoded)/pods"
        } else {
            path = "/api/v1/pods"
        }
        let response: K8sListResponse<K8sPod> = try await fetch(path: path)
        return response.items.map { $0.toPodInfo() }
    }

    /// Lists deployments in a given namespace.
    ///
    /// - Parameter namespace: The namespace to query.
    func listDeployments(namespace: String) async throws -> [DeploymentInfo] {
        let encoded = namespace.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? namespace
        let path = "/apis/apps/v1/namespaces/\(encoded)/deployments"
        let response: K8sListResponse<K8sDeployment> = try await fetch(path: path)
        return response.items.map { $0.toDeploymentInfo() }
    }

    // MARK: - Internal Networking

    /// Fetches and decodes a JSON response from the Kubernetes API.
    private func fetch<T: Codable & Sendable>(path: String) async throws -> T {
        let config = try await kubeconfigService.load()
        let (cluster, user) = try resolveConnectionInfo(from: config)

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

    // MARK: - Connection Resolution

    /// Resolves the cluster and user details for the active context.
    private func resolveConnectionInfo(
        from config: KubeConfig
    ) throws -> (ClusterDetails, UserDetails) {
        guard let contextName = config.currentContext else {
            throw CubeliteError.contextNotFound(name: "<none> — no active context set")
        }

        guard let namedContext = config.raw.contexts?.first(where: { $0.name == contextName }),
              let contextDetails = namedContext.context else {
            throw CubeliteError.contextNotFound(name: contextName)
        }

        guard let clusterName = contextDetails.cluster,
              let namedCluster = config.raw.clusters?.first(where: { $0.name == clusterName }),
              let cluster = namedCluster.cluster else {
            throw CubeliteError.clientError(
                reason: "Cluster definition not found for context '\(contextName)'"
            )
        }

        guard let userName = contextDetails.user,
              let namedUser = config.raw.users?.first(where: { $0.name == userName }),
              let user = namedUser.user else {
            throw CubeliteError.clientError(
                reason: "User definition not found for context '\(contextName)'"
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

    /// Loads the CA certificate from base64-encoded DER data in the cluster config.
    private static func loadCACertificate(from cluster: ClusterDetails) throws -> SecCertificate? {
        guard let b64 = cluster.certificateAuthorityData, !b64.isEmpty else {
            return nil
        }

        guard let derData = Data(base64Encoded: b64) else {
            throw CubeliteError.clientError(reason: "Invalid base64 in certificate-authority-data")
        }

        guard let certificate = SecCertificateCreateWithData(nil, derData as CFData) else {
            throw CubeliteError.clientError(reason: "Failed to create CA certificate from DER data")
        }

        return certificate
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
                return (.performDefaultHandling, nil)
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
