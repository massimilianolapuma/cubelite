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

    enum CodingKeys: String, CodingKey {
        case token
        case clientCertificateData = "client-certificate-data"
        case clientKeyData = "client-key-data"
        case clientCertificate = "client-certificate"
        case clientKey = "client-key"
    }
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
}
