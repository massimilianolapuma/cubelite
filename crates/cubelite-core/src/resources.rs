use serde::{Deserialize, Serialize};

/// Lightweight representation of a Kubernetes Pod for display purposes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PodInfo {
    /// The pod's name within its namespace.
    pub name: String,
    /// The namespace the pod belongs to.
    pub namespace: String,
    /// The pod phase string (e.g. `"Running"`, `"Pending"`, `"Succeeded"`).
    pub phase: Option<String>,
    /// `true` when all containers in the pod are ready.
    pub ready: bool,
    /// Total number of container restarts across all containers in the pod.
    pub restarts: i32,
}

/// Lightweight representation of a Kubernetes Namespace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamespaceInfo {
    /// The namespace name.
    pub name: String,
    /// The namespace phase string (e.g. `"Active"`, `"Terminating"`).
    pub phase: Option<String>,
}

/// Lightweight representation of a Kubernetes Deployment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentInfo {
    /// The deployment name.
    pub name: String,
    /// The namespace the deployment belongs to.
    pub namespace: String,
    /// Desired number of pod replicas as specified in the deployment spec.
    pub replicas: i32,
    /// Number of replicas currently reporting as ready.
    pub ready_replicas: i32,
}
