import Foundation

/// Errors originating from CubeLite operations.
enum CubeliteError: LocalizedError, Sendable {

    /// Kubeconfig file not found at the specified path.
    case fileNotFound(path: String)

    /// Failed to parse kubeconfig YAML.
    case parseError(reason: String)

    /// Named context does not exist in the kubeconfig.
    case contextNotFound(name: String)

    /// Failed to merge multiple kubeconfig files.
    case mergeError(reason: String)

    /// Kubernetes API client error.
    case clientError(reason: String)

    /// File system I/O error.
    case ioError(reason: String)

    /// Keychain operation failed.
    case keychainError(reason: String)

    /// The cluster API server could not be reached (connection refused, timeout, DNS).
    case clusterUnreachable

    /// TLS certificate validation failed (self-signed, expired, untrusted CA).
    case tlsError(reason: String)

    /// Kubernetes API returned 403 Forbidden — RBAC insufficient.
    case forbidden(resource: String, reason: String)

    var errorDescription: String? {
        switch self {
        case .fileNotFound(let path):
            "Kubeconfig file not found: \(path)"
        case .parseError(let reason):
            "Failed to parse kubeconfig: \(reason)"
        case .contextNotFound(let name):
            "Context not found: \(name)"
        case .mergeError(let reason):
            "Failed to merge kubeconfigs: \(reason)"
        case .clientError(let reason):
            "Kubernetes API error: \(reason)"
        case .ioError(let reason):
            "I/O error: \(reason)"
        case .keychainError(let reason):
            "Keychain error: \(reason)"
        case .clusterUnreachable:
            "Cluster not reachable"
        case .tlsError(let reason):
            "TLS certificate error: \(reason)"
        case .forbidden(let resource, _):
            "Access denied: insufficient permissions to list \(resource). Select a specific namespace."
        }
    }
}
