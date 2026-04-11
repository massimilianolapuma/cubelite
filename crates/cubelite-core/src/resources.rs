use serde::{Deserialize, Serialize};

/// Lightweight representation of a Kubernetes Pod for display purposes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PodInfo {
    pub name: String,
    pub namespace: String,
    pub phase: Option<String>,
    pub ready: bool,
    pub restarts: i32,
}

/// Lightweight representation of a Kubernetes Namespace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamespaceInfo {
    pub name: String,
    pub phase: Option<String>,
}

/// Lightweight representation of a Kubernetes Deployment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentInfo {
    pub name: String,
    pub namespace: String,
    pub replicas: i32,
    pub ready_replicas: i32,
}
