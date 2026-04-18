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

    /// Cached URLSession paired with the cluster server URL it was built for.
    ///
    /// Reusing the session across sequential API calls to the same cluster avoids
    /// repeated TLS handshakes, which cause `clientCertificateRejected` failures
    /// on minikube-style clusters that use short-lived client certificates.
    private var cachedSessionEntry: (session: URLSession, clusterServer: String)?

    /// Whether to skip TLS certificate verification for all clusters.
    ///
    /// Set from `AppSettings.skipTLSVerification` via `updateSkipTLS(_:)`.
    /// Reading `UserDefaults` directly in `makeSession()` is unreliable under
    /// the sandbox (Xcode re-installs can wipe the container) and has timing
    /// issues on first launch. Keeping the flag in-memory avoids both problems.
    private var skipTLSVerification: Bool = false

    /// Creates a new API service backed by the given kubeconfig service.
    ///
    /// - Parameter kubeconfigService: The service used to load kubeconfig state.
    init(kubeconfigService: KubeconfigService) {
        self.kubeconfigService = kubeconfigService
    }

    /// Invalidates and discards the cached URLSession.
    ///
    /// Call this when the active context changes so that the next API call
    /// performs a fresh TLS handshake against the new cluster's certificates.
    func invalidateSession() {
        cachedSessionEntry?.session.invalidateAndCancel()
        cachedSessionEntry = nil
    }

    /// Updates the global TLS-skip flag and invalidates the cached session.
    ///
    /// The next API call will create a fresh `URLSession` whose delegate
    /// reflects the new setting.
    func updateSkipTLS(_ skip: Bool) {
        guard skip != skipTLSVerification else { return }
        skipTLSVerification = skip
        invalidateSession()
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
    func listPods(namespace: String? = nil, inContext contextName: String? = nil) async throws
        -> [PodInfo]
    {
        let path: String
        if let ns = namespace {
            let encoded = ns.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ns
            path = "/api/v1/namespaces/\(encoded)/pods"
        } else {
            path = "/api/v1/pods"
        }
        let response: K8sListResponse<K8sPod> = try await fetch(
            path: path, contextName: contextName)
        return response.items.map { $0.toPodInfo() }
    }

    /// Lists services, optionally scoped to a namespace and/or context.
    ///
    /// - Parameters:
    ///   - namespace: If provided, only services in this namespace are returned.
    ///     Passing `nil` lists services across all namespaces.
    ///   - contextName: Kubeconfig context to use; defaults to the active context.
    func listServices(namespace: String? = nil, inContext contextName: String? = nil) async throws
        -> [ServiceInfo]
    {
        let path: String
        if let ns = namespace {
            let encoded = ns.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ns
            path = "/api/v1/namespaces/\(encoded)/services"
        } else {
            path = "/api/v1/services"
        }
        let response: K8sListResponse<K8sService> = try await fetch(
            path: path, contextName: contextName)
        return response.items.map { $0.toServiceInfo() }
    }

    /// Lists secrets, optionally scoped to a namespace and/or context.
    ///
    /// - Parameters:
    ///   - namespace: If provided, only secrets in this namespace are returned.
    ///     Passing `nil` lists secrets across all namespaces.
    ///   - contextName: Kubeconfig context to use; defaults to the active context.
    /// - Important: The returned ``SecretInfo`` values contain only key counts — actual
    ///   secret data is never fetched, decoded, or stored.
    func listSecrets(namespace: String? = nil, inContext contextName: String? = nil) async throws
        -> [SecretInfo]
    {
        let path: String
        if let ns = namespace {
            let encoded = ns.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ns
            path = "/api/v1/namespaces/\(encoded)/secrets"
        } else {
            path = "/api/v1/secrets"
        }
        let response: K8sListResponse<K8sSecret> = try await fetch(
            path: path, contextName: contextName)
        return response.items.map { $0.toSecretInfo() }
    }

    /// Lists ConfigMaps, optionally scoped to a namespace and/or context.
    ///
    /// - Parameters:
    ///   - namespace: If provided, only ConfigMaps in this namespace are returned.
    ///     Passing `nil` lists ConfigMaps across all namespaces.
    ///   - contextName: Kubeconfig context to use; defaults to the active context.
    func listConfigMaps(namespace: String? = nil, inContext contextName: String? = nil) async throws
        -> [ConfigMapInfo]
    {
        let path: String
        if let ns = namespace {
            let encoded = ns.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ns
            path = "/api/v1/namespaces/\(encoded)/configmaps"
        } else {
            path = "/api/v1/configmaps"
        }
        let response: K8sListResponse<K8sConfigMap> = try await fetch(
            path: path, contextName: contextName)
        return response.items.map { $0.toConfigMapInfo() }
    }

    /// Lists Ingresses, optionally scoped to a namespace and/or context.
    ///
    /// Uses the `networking.k8s.io/v1` API group, not the core `/api/v1` group.
    ///
    /// - Parameters:
    ///   - namespace: If provided, only Ingresses in this namespace are returned.
    ///     Passing `nil` lists Ingresses across all namespaces.
    ///   - contextName: Kubeconfig context to use; defaults to the active context.
    func listIngresses(namespace: String? = nil, inContext contextName: String? = nil) async throws
        -> [IngressInfo]
    {
        let path: String
        if let ns = namespace {
            let encoded = ns.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ns
            path = "/apis/networking.k8s.io/v1/namespaces/\(encoded)/ingresses"
        } else {
            path = "/apis/networking.k8s.io/v1/ingresses"
        }
        let response: K8sListResponse<K8sIngress> = try await fetch(
            path: path, contextName: contextName)
        return response.items.map { $0.toIngressInfo() }
    }

    /// Lists Helm releases, optionally scoped to a namespace and/or context.
    ///
    /// Helm stores release metadata as Kubernetes Secrets labelled `owner=helm`.
    /// Multiple revisions for the same release are deduplicated — only the latest
    /// revision (highest `version` label value) is kept.
    ///
    /// - Parameters:
    ///   - namespace: If provided, only releases in this namespace are returned.
    ///     Passing `nil` lists releases across all namespaces.
    ///   - contextName: Kubeconfig context to use; defaults to the active context.
    func listHelmReleases(namespace: String? = nil, inContext contextName: String? = nil)
        async throws -> [HelmReleaseInfo]
    {
        let path: String
        if let ns = namespace {
            let encoded = ns.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ns
            path = "/api/v1/namespaces/\(encoded)/secrets?labelSelector=owner%3Dhelm"
        } else {
            path = "/api/v1/secrets?labelSelector=owner%3Dhelm"
        }
        let response: K8sListResponse<K8sSecret> = try await fetch(
            path: path, contextName: contextName)
        let releases = response.items.compactMap { $0.toHelmReleaseInfo() }
        // Deduplicate: keep only the latest revision per (namespace, name).
        var latest: [String: HelmReleaseInfo] = [:]
        for release in releases {
            let key = release.id
            if let existing = latest[key] {
                if release.revision > existing.revision {
                    latest[key] = release
                }
            } else {
                latest[key] = release
            }
        }
        return latest.values.sorted { $0.name < $1.name }
    }

    /// Lists deployments, optionally scoped to a namespace and/or context.
    ///
    /// - Parameters:
    ///   - namespace: Namespace to query. Passing `nil` lists across all namespaces.
    ///   - contextName: Kubeconfig context to use; defaults to the active context.
    func listDeployments(namespace: String? = nil, inContext contextName: String? = nil)
        async throws -> [DeploymentInfo]
    {
        let path: String
        if let ns = namespace {
            let encoded = ns.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ns
            path = "/apis/apps/v1/namespaces/\(encoded)/deployments"
        } else {
            path = "/apis/apps/v1/deployments"
        }
        let response: K8sListResponse<K8sDeployment> = try await fetch(
            path: path, contextName: contextName)
        return response.items.map { $0.toDeploymentInfo() }
    }

    // MARK: - Internal Networking

    /// Fetches and decodes a JSON response from the Kubernetes API.
    ///
    /// - Parameters:
    ///   - path: API path to request.
    ///   - contextName: Override which kubeconfig context is used.
    private func fetch<T: Codable & Sendable>(path: String, contextName: String? = nil) async throws
        -> T
    {
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

        // Reuse the cached session when the cluster server matches; build a new one
        // when the context has changed. This prevents repeated TLS handshakes that
        // cause authentication failures on client-certificate clusters (e.g. minikube).
        let session: URLSession
        if let entry = cachedSessionEntry, entry.clusterServer == base {
            session = entry.session
        } else {
            cachedSessionEntry?.session.invalidateAndCancel()
            cachedSessionEntry = nil
            let newSession = try makeSession(cluster: cluster, user: user)
            cachedSessionEntry = (session: newSession, clusterServer: base)
            session = newSession
        }

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
            throw CubeliteError.clientError(
                reason: "Network request failed: \(error.localizedDescription)")
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw CubeliteError.clientError(reason: "Invalid response from Kubernetes API")
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            if httpResponse.statusCode == 403 {
                let resource = Self.extractForbiddenResource(from: data) ?? path
                throw CubeliteError.forbidden(
                    resource: resource,
                    reason: body
                )
            }
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
        case .cannotConnectToHost,  // -1004: connection refused
            .timedOut,  // -1001: timeout
            .cannotFindHost,  // -1003: DNS failure
            .networkConnectionLost,  // -1005: connection dropped
            .notConnectedToInternet:  // -1009: no network
            return true
        default:
            return false
        }
    }

    /// Extract the resource kind from a Kubernetes 403 Status JSON body.
    static func extractForbiddenResource(from data: Data) -> String? {
        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let details = json["details"] as? [String: Any],
            let kind = details["kind"] as? String
        else { return nil }
        return kind
    }

    /// URL error codes that indicate TLS certificate validation failure.
    static func isTLSError(_ error: URLError) -> Bool {
        switch error.code {
        case .secureConnectionFailed,
            .serverCertificateUntrusted,
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
            let contextDetails = namedContext.context
        else {
            throw CubeliteError.contextNotFound(name: resolvedContext)
        }

        guard let clusterName = contextDetails.cluster,
            let namedCluster = config.raw.clusters?.first(where: { $0.name == clusterName }),
            let cluster = namedCluster.cluster
        else {
            throw CubeliteError.clientError(
                reason: "Cluster definition not found for context '\(resolvedContext)'"
            )
        }

        guard let userName = contextDetails.user,
            let namedUser = config.raw.users?.first(where: { $0.name == userName }),
            let user = namedUser.user
        else {
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
        let insecureSkip = skipTLSVerification || (cluster.insecureSkipTlsVerify ?? false)

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
            guard let decoded = Data(base64Encoded: b64) else {
                throw CubeliteError.clientError(
                    reason: "Invalid base64 in certificate-authority-data")
            }
            // Try DER directly; fall back to PEM stripping when the decoded bytes
            // are PEM-wrapped (common in k3s, dynamiclistener, and similar tools).
            if let certificate = SecCertificateCreateWithData(nil, decoded as CFData) {
                return certificate
            }
            let derData = try pemToDER(decoded)
            guard let certificate = SecCertificateCreateWithData(nil, derData as CFData) else {
                throw CubeliteError.clientError(
                    reason: "Failed to create CA certificate from certificate-authority-data")
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

    /// Loads a client `SecIdentity` from the kubeconfig user entry.
    ///
    /// Tries inline base64 (`client-certificate-data` / `client-key-data`) first, then falls
    /// back to reading PEM files at `client-certificate` / `client-key` when inline data is
    /// absent — the pattern used by minikube and many local clusters.
    ///
    /// - Returns: A `SecIdentity`, or `nil` when no client certificate is configured.
    /// - Throws: `CubeliteError.clientError` on any decode, read, or keychain failure.
    private static func loadClientIdentity(from user: UserDetails) throws -> SecIdentity? {
        // --- Path 1: inline base64 data (client-certificate-data / client-key-data) ---
        if let certB64 = user.clientCertificateData, !certB64.isEmpty,
            let keyB64 = user.clientKeyData, !keyB64.isEmpty
        {
            // Decode cert: base64 → DER (kubeconfig inline format).
            // Fall back to PEM stripping if the decoded bytes appear to be PEM-wrapped.
            guard let certDecoded = Data(base64Encoded: certB64) else {
                throw CubeliteError.clientError(reason: "Invalid base64 in client-certificate-data")
            }
            var certificate: SecCertificate? = SecCertificateCreateWithData(
                nil, certDecoded as CFData)
            if certificate == nil, let certDERFromPEM = try? pemToDER(certDecoded) {
                certificate = SecCertificateCreateWithData(nil, certDERFromPEM as CFData)
            }
            guard let certificate else {
                throw CubeliteError.clientError(
                    reason: "Failed to parse client certificate from client-certificate-data")
            }

            // Decode key: base64 → PEM text.
            guard let keyDecoded = Data(base64Encoded: keyB64) else {
                throw CubeliteError.clientError(reason: "Invalid base64 in client-key-data")
            }
            guard let keyPEMString = String(data: keyDecoded, encoding: .utf8) else {
                throw CubeliteError.clientError(
                    reason: "client-key-data is not valid UTF-8 after base64 decode")
            }

            // Detect key type from PEM headers (used when removing old keychain items).
            let isEC = keyPEMString.contains("BEGIN EC PRIVATE KEY")
            let isRSA =
                keyPEMString.contains("BEGIN RSA PRIVATE KEY")
                || keyPEMString.contains("BEGIN PRIVATE KEY")
            guard isEC || isRSA else {
                throw CubeliteError.clientError(
                    reason: "Unsupported private key type in client-key-data")
            }

            // Import the PEM key in memory using SecItemImport, which handles SEC1, PKCS#1, and PKCS#8
            // formats correctly — unlike SecKeyCreateWithData which only accepts X9.63 raw bytes.
            var importFormat = SecExternalFormat.formatOpenSSL
            var importItemType = SecExternalItemType.itemTypePrivateKey
            var importParams = SecItemImportExportKeyParameters()
            importParams.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
            var importedItems: CFArray?
            let importStatus = SecItemImport(
                keyDecoded as CFData, nil, &importFormat, &importItemType,
                SecItemImportExportFlags(), &importParams, nil, &importedItems
            )
            guard importStatus == errSecSuccess,
                let privateKey = (importedItems as? [SecKey])?.first
            else {
                throw CubeliteError.clientError(
                    reason: "Failed to import private key from PEM: OSStatus \(importStatus)"
                )
            }

            return try Self.storeAndFindIdentity(certificate: certificate, privateKey: privateKey)
        }

        // --- Path 2: file paths (client-certificate / client-key) ---
        if let certPath = user.clientCertificate, !certPath.isEmpty,
            let keyPath = user.clientKey, !keyPath.isEmpty
        {
            let expandedCertPath = NSString(string: certPath).expandingTildeInPath
            let expandedKeyPath = NSString(string: keyPath).expandingTildeInPath

            // Read the certificate PEM file.
            let certPEM: Data
            do {
                certPEM = try Data(contentsOf: URL(fileURLWithPath: expandedCertPath))
            } catch {
                throw CubeliteError.clientError(
                    reason: "Cannot read client certificate file: \(certPath)")
            }

            // Convert PEM → DER and create a SecCertificate.
            let certDER: Data
            do {
                certDER = try pemToDER(certPEM)
            } catch {
                throw CubeliteError.clientError(
                    reason: "Failed to parse PEM certificate from file: \(certPath)")
            }
            guard let certificate = SecCertificateCreateWithData(nil, certDER as CFData) else {
                throw CubeliteError.clientError(
                    reason: "Failed to create certificate from file: \(certPath)")
            }

            // Read the private key PEM file.
            let keyPEM: Data
            do {
                keyPEM = try Data(contentsOf: URL(fileURLWithPath: expandedKeyPath))
            } catch {
                throw CubeliteError.clientError(reason: "Cannot read client key file: \(keyPath)")
            }

            // Validate key type from PEM headers.
            guard let keyPEMString = String(data: keyPEM, encoding: .utf8) else {
                throw CubeliteError.clientError(
                    reason: "Client key file is not valid UTF-8: \(keyPath)")
            }
            let isEC = keyPEMString.contains("BEGIN EC PRIVATE KEY")
            let isRSA =
                keyPEMString.contains("BEGIN RSA PRIVATE KEY")
                || keyPEMString.contains("BEGIN PRIVATE KEY")
            guard isEC || isRSA else {
                throw CubeliteError.clientError(
                    reason: "Unsupported private key type in file: \(keyPath)")
            }

            // Import the PEM key using SecItemImport.
            var importFormat = SecExternalFormat.formatOpenSSL
            var importItemType = SecExternalItemType.itemTypePrivateKey
            var importParams = SecItemImportExportKeyParameters()
            importParams.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
            var importedItems: CFArray?
            let importStatus = SecItemImport(
                keyPEM as CFData, nil, &importFormat, &importItemType,
                SecItemImportExportFlags(), &importParams, nil, &importedItems
            )
            guard importStatus == errSecSuccess,
                let privateKey = (importedItems as? [SecKey])?.first
            else {
                throw CubeliteError.clientError(
                    reason:
                        "Failed to import private key from file: \(keyPath) (OSStatus \(importStatus))"
                )
            }

            return try Self.storeAndFindIdentity(certificate: certificate, privateKey: privateKey)
        }

        return nil
    }

    /// Imports a certificate and private key into the keychain and returns the resulting `SecIdentity`.
    ///
    /// The `kSecAttrApplicationLabel` from the in-memory key (SHA-1 of the public key) is
    /// explicitly propagated to the stored keychain item so the Security framework can correlate
    /// the private key with the certificate for identity matching.
    ///
    /// Uses `SecIdentityCreateWithCertificate` to locate the identity because the
    /// `SecItemCopyMatching`-based enumeration approach (`kSecClassIdentity` +
    /// `kSecMatchLimitAll`) does not reliably find freshly-imported items —
    /// particularly in sandboxed apps.
    ///
    /// - Parameters:
    ///   - certificate: The client certificate.
    ///   - privateKey:  The matching private key (created via `SecItemImport`).
    /// - Returns: The `SecIdentity` that pairs the stored certificate and key.
    /// - Throws: `CubeliteError.clientError` on any keychain failure.
    private static func storeAndFindIdentity(
        certificate: SecCertificate,
        privateKey: SecKey
    ) throws -> SecIdentity {
        let keyTag = Data("it.lapuma.cubelite.client-key".utf8)

        // Preserve the application label (SHA-1 of the public key) from the imported key so
        // that the Security framework can correlate the private key with the certificate.
        let importedKeyAttrs = SecKeyCopyAttributes(privateKey) as? [CFString: Any]
        let applicationLabel = importedKeyAttrs?[kSecAttrApplicationLabel] as? Data

        // Replace any existing key with this tag.
        let keySearchQuery: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecAttrApplicationTag: keyTag,
            kSecAttrKeyClass: kSecAttrKeyClassPrivate,
        ]
        SecItemDelete(keySearchQuery as CFDictionary)

        // Add the private key to the keychain with the correct application label.
        var addKeyQuery: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecAttrApplicationTag: keyTag,
            kSecAttrKeyClass: kSecAttrKeyClassPrivate,
            kSecValueRef: privateKey,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
        ]
        if let label = applicationLabel {
            addKeyQuery[kSecAttrApplicationLabel] = label
        }
        let keyStatus = SecItemAdd(addKeyQuery as CFDictionary, nil)
        guard keyStatus == errSecSuccess else {
            throw CubeliteError.clientError(
                reason: "Failed to add client key to keychain: OSStatus \(keyStatus)"
            )
        }

        // Add certificate; duplicates are accepted because the cert may already be present.
        let addCertQuery: [CFString: Any] = [
            kSecClass: kSecClassCertificate,
            kSecValueRef: certificate,
        ]
        let certStatus = SecItemAdd(addCertQuery as CFDictionary, nil)
        guard certStatus == errSecSuccess || certStatus == errSecDuplicateItem else {
            SecItemDelete(keySearchQuery as CFDictionary)
            throw CubeliteError.clientError(
                reason: "Failed to add client certificate to keychain: OSStatus \(certStatus)"
            )
        }

        // Find the identity using SecIdentityCreateWithCertificate which searches
        // the default keychain list for a private key matching the certificate.
        var identity: SecIdentity?
        let identityStatus = SecIdentityCreateWithCertificate(nil, certificate, &identity)
        guard identityStatus == errSecSuccess, let identity else {
            throw CubeliteError.clientError(
                reason:
                    "Client identity not found in keychain after import (OSStatus \(identityStatus))"
            )
        }
        return identity
    }

    /// Converts PEM-encoded certificate data to DER format.
    ///
    /// Strips the `-----BEGIN CERTIFICATE-----` / `-----END CERTIFICATE-----`
    /// markers and decodes the base64 content.
    static func pemToDER(_ pemData: Data) throws -> Data {
        guard let pemString = String(data: pemData, encoding: .utf8) else {
            throw CubeliteError.clientError(reason: "CA certificate file is not valid UTF-8")
        }

        let base64Content =
            pemString
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
private final class KubeURLSessionDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate,
    @unchecked Sendable
{

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

    /// Evaluates an authentication challenge and returns the disposition and credential.
    private func handleChallenge(
        _ challenge: URLAuthenticationChallenge
    ) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
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
                }

                // macOS rejects server certificates whose validity period exceeds
                // 398 days (errSecCertificateValidityPeriodTooLong, OSStatus -67901).
                // Local/dev clusters (minikube, k3s, kind) commonly generate long-lived
                // certificates signed by a private CA. Since we already pinned that CA
                // as the sole trust anchor, fall back to a basic X.509 chain-only
                // evaluation which verifies the signature chain without enforcing
                // Apple's temporal-compliance policy.
                if (error.map { ($0 as Error as NSError).code }) == -67901 {
                    let chainOnlyPolicy = SecPolicyCreateBasicX509()
                    SecTrustSetPolicies(trust, chainOnlyPolicy)
                    var chainError: CFError?
                    if SecTrustEvaluateWithError(trust, &chainError) {
                        return (.useCredential, URLCredential(trust: trust))
                    }
                }

                return (.cancelAuthenticationChallenge, nil)
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

    // MARK: - URLSessionDelegate (completion-handler)

    /// Session-level authentication challenge handler.
    ///
    /// Uses the completion-handler variant instead of the async version because
    /// `URLSession` does not reliably invoke async delegate methods on all macOS
    /// versions, causing TLS challenges to be silently ignored.
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let (disposition, credential) = handleChallenge(challenge)
        completionHandler(disposition, credential)
    }

    // MARK: - URLSessionTaskDelegate (completion-handler)

    /// Task-level authentication challenge handler.
    ///
    /// `session.data(for:)` delivers challenges through the task delegate first.
    /// Forward to the shared handler so TLS skip and CA pinning work for every
    /// data task.
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let (disposition, credential) = handleChallenge(challenge)
        completionHandler(disposition, credential)
    }
}
