//! Domain types that model a Kubernetes kubeconfig file.
//!
//! These types map closely to the [kubeconfig v1 API spec] but are stripped
//! down to the fields relevant for context discovery and switching.
//!
//! [kubeconfig v1 API spec]: https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Top-level kubeconfig document
// ---------------------------------------------------------------------------

/// A fully parsed Kubernetes kubeconfig document.
///
/// This struct is the internal representation produced after loading and
/// (optionally) merging one or more kubeconfig files.  All context, cluster,
/// and user entries discovered across the input files are collected here.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KubeConfigFile {
    /// All named contexts discovered in the kubeconfig(s).
    #[serde(default)]
    pub contexts: Vec<NamedContext>,

    /// All named clusters discovered in the kubeconfig(s).
    #[serde(default)]
    pub clusters: Vec<NamedCluster>,

    /// All named users / credentials discovered in the kubeconfig(s).
    #[serde(default)]
    pub users: Vec<NamedUser>,

    /// The name of the currently active context, if any.
    #[serde(rename = "current-context", default)]
    pub current_context: Option<String>,
}

// ---------------------------------------------------------------------------
// Named entries — the standard kubeconfig "named" wrappers
// ---------------------------------------------------------------------------

/// A named context entry inside a kubeconfig file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedContext {
    /// The unique name used to reference this context (e.g. `"prod-us-east"`).
    pub name: String,

    /// The context details (cluster + user + optional namespace).
    #[serde(default)]
    pub context: Option<ContextDetails>,
}

/// A named cluster entry inside a kubeconfig file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedCluster {
    /// The unique name used to reference this cluster.
    pub name: String,

    /// The cluster connection details.
    #[serde(default)]
    pub cluster: Option<ClusterDetails>,
}

/// A named user / credentials entry inside a kubeconfig file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedUser {
    /// The unique name used to reference these credentials.
    pub name: String,

    /// The authentication details for this user.
    #[serde(default)]
    pub user: Option<UserDetails>,
}

// ---------------------------------------------------------------------------
// Inner detail structs
// ---------------------------------------------------------------------------

/// The inner details of a kubeconfig context.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContextDetails {
    /// Name of the cluster this context points to.
    #[serde(default)]
    pub cluster: String,

    /// Name of the user / credentials to authenticate as.
    #[serde(default)]
    pub user: String,

    /// Optional default namespace for this context.
    #[serde(default)]
    pub namespace: Option<String>,
}

/// The inner details of a kubeconfig cluster entry.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClusterDetails {
    /// The API server URL (e.g. `"https://192.168.1.10:6443"`).
    #[serde(rename = "server", default)]
    pub server: String,

    /// PEM-encoded CA certificate data (base64, inline).
    #[serde(rename = "certificate-authority-data", default)]
    pub certificate_authority_data: Option<String>,

    /// Path to a CA certificate file on disk.
    #[serde(rename = "certificate-authority", default)]
    pub certificate_authority: Option<String>,

    /// Whether to skip TLS verification (insecure; not recommended in production).
    #[serde(rename = "insecure-skip-tls-verify", default)]
    pub insecure_skip_tls_verify: bool,
}

/// Authentication details for a kubeconfig user entry.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UserDetails {
    /// A bearer token used to authenticate with the API server.
    #[serde(default)]
    pub token: Option<String>,

    /// PEM-encoded client certificate data (base64, inline).
    #[serde(rename = "client-certificate-data", default)]
    pub client_certificate_data: Option<String>,

    /// Path to a client certificate file on disk.
    #[serde(rename = "client-certificate", default)]
    pub client_certificate: Option<String>,

    /// PEM-encoded client private key data (base64, inline).
    #[serde(rename = "client-key-data", default)]
    pub client_key_data: Option<String>,

    /// Path to a client private key file on disk.
    #[serde(rename = "client-key", default)]
    pub client_key: Option<String>,

    /// Optional username for basic authentication.
    #[serde(default)]
    pub username: Option<String>,
}

// ---------------------------------------------------------------------------
// High-level context descriptor (returned by public APIs)
// ---------------------------------------------------------------------------

/// A resolved, self-contained description of a single Kubernetes context.
///
/// Unlike [`NamedContext`], this struct includes the cluster server URL and
/// namespace so callers can display or filter contexts without extra lookups.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextInfo {
    /// The unique name of this context.
    pub name: String,

    /// The API server URL for the cluster this context points to, if resolvable.
    pub cluster_server: Option<String>,

    /// The default namespace, falling back to `"default"` when absent.
    pub namespace: String,

    /// Whether this is the currently active context.
    pub is_active: bool,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kubeconfig_file_default_is_empty() {
        let cfg = KubeConfigFile::default();
        assert!(cfg.contexts.is_empty());
        assert!(cfg.clusters.is_empty());
        assert!(cfg.users.is_empty());
        assert!(cfg.current_context.is_none());
    }

    #[test]
    fn context_details_default_namespace_is_none() {
        let details = ContextDetails::default();
        assert!(details.namespace.is_none());
    }

    #[test]
    fn cluster_details_insecure_defaults_to_false() {
        let details = ClusterDetails::default();
        assert!(!details.insecure_skip_tls_verify);
    }
}
