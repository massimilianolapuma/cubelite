import Foundation

// MARK: - Raw Kubeconfig YAML Structure

/// Top-level kubeconfig file representation, matching the YAML schema.
struct RawKubeConfig: Codable, Sendable {
    var apiVersion: String?
    var kind: String?
    var currentContext: String?
    var contexts: [NamedContext]?
    var clusters: [NamedCluster]?
    var users: [NamedUser]?

    enum CodingKeys: String, CodingKey {
        case apiVersion
        case kind
        case currentContext = "current-context"
        case contexts
        case clusters
        case users
    }
}

/// A named context entry in the kubeconfig.
struct NamedContext: Codable, Sendable, Identifiable {
    var id: String { name }

    let name: String
    let context: ContextDetails?
}

/// Details within a kubeconfig context entry.
struct ContextDetails: Codable, Sendable {
    let cluster: String?
    let user: String?
    let namespace: String?
}

/// A named cluster entry in the kubeconfig.
struct NamedCluster: Codable, Sendable {
    let name: String
    let cluster: ClusterDetails?
}

/// Details within a kubeconfig cluster entry.
struct ClusterDetails: Codable, Sendable {
    let server: String?
    let certificateAuthorityData: String?
    let certificateAuthority: String?
    let insecureSkipTlsVerify: Bool?

    enum CodingKeys: String, CodingKey {
        case server
        case certificateAuthorityData = "certificate-authority-data"
        case certificateAuthority = "certificate-authority"
        case insecureSkipTlsVerify = "insecure-skip-tls-verify"
    }
}

/// A named user entry in the kubeconfig.
struct NamedUser: Codable, Sendable {
    let name: String
    let user: UserDetails?
}

/// Credential details within a kubeconfig user entry.
struct UserDetails: Codable, Sendable {
    let token: String?
    let clientCertificateData: String?
    let clientKeyData: String?
    let clientCertificate: String?
    let clientKey: String?
    let exec: ExecConfig?
    let authProvider: AuthProviderConfig?

    enum CodingKeys: String, CodingKey {
        case token
        case clientCertificateData = "client-certificate-data"
        case clientKeyData = "client-key-data"
        case clientCertificate = "client-certificate"
        case clientKey = "client-key"
        case exec
        case authProvider = "auth-provider"
    }

    init(
        token: String? = nil,
        clientCertificateData: String? = nil,
        clientKeyData: String? = nil,
        clientCertificate: String? = nil,
        clientKey: String? = nil,
        exec: ExecConfig? = nil,
        authProvider: AuthProviderConfig? = nil
    ) {
        self.token = token
        self.clientCertificateData = clientCertificateData
        self.clientKeyData = clientKeyData
        self.clientCertificate = clientCertificate
        self.clientKey = clientKey
        self.exec = exec
        self.authProvider = authProvider
    }

    /// A copy of these credentials with the bearer token removed.
    ///
    /// Used after the token has been migrated to the Keychain so the
    /// in-memory kubeconfig model never carries it past load time.
    func redactingToken() -> UserDetails {
        UserDetails(
            clientCertificateData: clientCertificateData,
            clientKeyData: clientKeyData,
            clientCertificate: clientCertificate,
            clientKey: clientKey,
            exec: exec,
            authProvider: authProvider
        )
    }
}

/// An `users[].user.exec` credential-plugin block
/// (client.authentication.k8s.io ExecConfig).
struct ExecConfig: Codable, Sendable {
    let apiVersion: String?
    let command: String
    let args: [String]?
    let env: [ExecEnvVar]?
    let interactiveMode: String?
    let provideClusterInfo: Bool?
}

/// A single environment variable entry inside an exec block.
struct ExecEnvVar: Codable, Sendable {
    let name: String
    let value: String
}

/// A legacy `users[].user.auth-provider` block. Parsed only so the app can
/// surface a targeted "migrate to exec" error instead of a silent auth miss.
struct AuthProviderConfig: Codable, Sendable {
    let name: String?
}

// MARK: - Processed KubeConfig

/// Merged kubeconfig state produced from one or more kubeconfig files.
struct KubeConfig: Sendable {

    /// Context names available across all merged files.
    let contexts: [String]

    /// Currently active context (from the first file that specifies one).
    var currentContext: String?

    /// The merged raw configuration.
    var raw: RawKubeConfig

    /// File paths that were merged to produce this config.
    let paths: [URL]

    /// Returns the default namespace for the given context, if set in the kubeconfig.
    func defaultNamespace(for contextName: String) -> String? {
        raw.contexts?
            .first(where: { $0.name == contextName })?
            .context?
            .namespace
    }
}
