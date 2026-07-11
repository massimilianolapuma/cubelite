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

/// Lightweight representation of a Kubernetes Service.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceInfo {
    /// The service name.
    pub name: String,
    /// The namespace the service belongs to.
    pub namespace: String,
    /// The service type (e.g. `"ClusterIP"`, `"NodePort"`, `"LoadBalancer"`).
    pub service_type: Option<String>,
    /// The cluster-internal IP, if assigned (`"None"` for headless services).
    pub cluster_ip: Option<String>,
    /// External IPs or load-balancer hostnames/addresses, if any.
    pub external_ips: Vec<String>,
    /// Exposed ports rendered kubectl-style (e.g. `"80/TCP"`, `"443:30443/TCP"`).
    pub ports: Vec<String>,
    /// RFC 3339 creation timestamp, when reported by the API server.
    pub creation_timestamp: Option<String>,
}

/// Lightweight representation of a Kubernetes Ingress.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngressInfo {
    /// The ingress name.
    pub name: String,
    /// The namespace the ingress belongs to.
    pub namespace: String,
    /// The ingress class name, if set.
    pub class: Option<String>,
    /// Hostnames covered by the ingress rules.
    pub hosts: Vec<String>,
    /// Load-balancer addresses (IPs or hostnames) assigned to the ingress.
    pub addresses: Vec<String>,
    /// `true` when a TLS section is present (ports 80+443 vs 80 only).
    pub tls: bool,
    /// RFC 3339 creation timestamp, when reported by the API server.
    pub creation_timestamp: Option<String>,
}

/// Lightweight representation of a Kubernetes ConfigMap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigMapInfo {
    /// The config map name.
    pub name: String,
    /// The namespace the config map belongs to.
    pub namespace: String,
    /// Number of data entries (`data` + `binaryData` keys).
    pub data_count: usize,
    /// RFC 3339 creation timestamp, when reported by the API server.
    pub creation_timestamp: Option<String>,
}

/// Lightweight representation of a Kubernetes Event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventInfo {
    /// Event type (`"Normal"` or `"Warning"`).
    pub event_type: Option<String>,
    /// Machine-readable reason (e.g. `"BackOff"`, `"Scheduled"`).
    pub reason: Option<String>,
    /// Involved object rendered kubectl-style (e.g. `"Pod/api-0"`).
    pub object: String,
    /// Human-readable message.
    pub message: Option<String>,
    /// The namespace the event belongs to.
    pub namespace: String,
    /// Number of occurrences of this event.
    pub count: i32,
    /// RFC 3339 timestamp of the most recent occurrence.
    pub last_timestamp: Option<String>,
}

/// Lightweight representation of a Kubernetes Secret.
///
/// Values are base64-decoded locally by the backend and never leave the
/// machine; binary values are replaced with a `"(binary)"` placeholder.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretInfo {
    /// The secret name.
    pub name: String,
    /// The namespace the secret belongs to.
    pub namespace: String,
    /// The secret type (e.g. `"Opaque"`, `"kubernetes.io/tls"`).
    pub secret_type: Option<String>,
    /// Decoded key/value entries, sorted by key.
    pub data: std::collections::BTreeMap<String, String>,
    /// RFC 3339 creation timestamp, when reported by the API server.
    pub creation_timestamp: Option<String>,
}
