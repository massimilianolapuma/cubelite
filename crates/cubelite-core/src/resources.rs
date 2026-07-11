use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Per-container readiness and image for the pod detail drawer.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContainerInfo {
    /// Container name.
    pub name: String,
    /// Container image reference.
    pub image: Option<String>,
    /// `true` when the container reports ready.
    pub ready: bool,
}

/// Lightweight representation of a Kubernetes Pod for display purposes.
///
/// Fields added after v0.1 carry `#[serde(default)]` so older payloads
/// still deserialize.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// Number of containers reporting ready.
    #[serde(default)]
    pub ready_containers: i32,
    /// Total number of containers in the pod.
    #[serde(default)]
    pub total_containers: i32,
    /// Node the pod is scheduled on.
    #[serde(default)]
    pub node: Option<String>,
    /// Pod IP address.
    #[serde(default)]
    pub pod_ip: Option<String>,
    /// Quality of Service class (`"Guaranteed"`, `"Burstable"`, `"BestEffort"`).
    #[serde(default)]
    pub qos_class: Option<String>,
    /// Containers with per-container readiness and image.
    #[serde(default)]
    pub containers: Vec<ContainerInfo>,
    /// Pod labels (drives selector-based child-pod matching).
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    /// RFC 3339 creation timestamp, when reported by the API server.
    #[serde(default)]
    pub creation_timestamp: Option<String>,
}

/// Lightweight representation of a Kubernetes Namespace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamespaceInfo {
    /// The namespace name.
    pub name: String,
    /// The namespace phase string (e.g. `"Active"`, `"Terminating"`).
    pub phase: Option<String>,
}

/// A deployment condition for the detail drawer cards.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeploymentConditionInfo {
    /// Condition type (e.g. `"Available"`, `"Progressing"`).
    pub condition_type: String,
    /// Condition status (`"True"`, `"False"`, `"Unknown"`).
    pub status: String,
    /// Machine-readable reason, when reported.
    pub reason: Option<String>,
}

/// Lightweight representation of a Kubernetes Deployment.
///
/// Fields added after v0.1 carry `#[serde(default)]` so older payloads
/// still deserialize.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeploymentInfo {
    /// The deployment name.
    pub name: String,
    /// The namespace the deployment belongs to.
    pub namespace: String,
    /// Desired number of pod replicas as specified in the deployment spec.
    pub replicas: i32,
    /// Number of replicas currently reporting as ready.
    pub ready_replicas: i32,
    /// Container images from the pod template.
    #[serde(default)]
    pub images: Vec<String>,
    /// Label selector (`matchLabels`) used to find owned pods.
    #[serde(default)]
    pub selector: BTreeMap<String, String>,
    /// Rollout strategy type (`"RollingUpdate"`, `"Recreate"`).
    #[serde(default)]
    pub strategy: Option<String>,
    /// Deployment conditions for the drawer cards.
    #[serde(default)]
    pub conditions: Vec<DeploymentConditionInfo>,
    /// RFC 3339 creation timestamp, when reported by the API server.
    #[serde(default)]
    pub creation_timestamp: Option<String>,
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

/// Lightweight representation of a Kubernetes Job.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JobInfo {
    /// The job name.
    pub name: String,
    /// The namespace the job belongs to.
    pub namespace: String,
    /// Desired completions (spec.completions, defaults to 1).
    pub completions: i32,
    /// Pods that completed successfully.
    pub succeeded: i32,
    /// Pods currently running.
    pub active: i32,
    /// Pods that failed.
    pub failed: i32,
    /// RFC 3339 creation timestamp, when reported by the API server.
    pub creation_timestamp: Option<String>,
}

/// Lightweight representation of a Kubernetes CronJob.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CronJobInfo {
    /// The cron job name.
    pub name: String,
    /// The namespace the cron job belongs to.
    pub namespace: String,
    /// Cron schedule expression.
    pub schedule: String,
    /// `true` when the cron job is suspended.
    pub suspend: bool,
    /// Number of currently active jobs.
    pub active: i32,
    /// RFC 3339 timestamp of the last scheduled run.
    pub last_schedule: Option<String>,
    /// RFC 3339 creation timestamp, when reported by the API server.
    pub creation_timestamp: Option<String>,
}

/// Lightweight representation of a Kubernetes StatefulSet.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StatefulSetInfo {
    /// The stateful set name.
    pub name: String,
    /// The namespace the stateful set belongs to.
    pub namespace: String,
    /// Desired number of replicas.
    pub replicas: i32,
    /// Replicas currently reporting ready.
    pub ready_replicas: i32,
    /// RFC 3339 creation timestamp, when reported by the API server.
    pub creation_timestamp: Option<String>,
}

/// Lightweight representation of a Kubernetes Node (read-only inventory).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NodeInfo {
    /// The node name.
    pub name: String,
    /// `"Ready"` / `"NotReady"` from the Ready condition.
    pub status: String,
    /// Roles from `node-role.kubernetes.io/*` labels.
    pub roles: Vec<String>,
    /// Kubelet version.
    pub version: Option<String>,
    /// RFC 3339 creation timestamp, when reported by the API server.
    pub creation_timestamp: Option<String>,
}

/// Lightweight representation of a Kubernetes PersistentVolumeClaim.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PvcInfo {
    /// The claim name.
    pub name: String,
    /// The namespace the claim belongs to.
    pub namespace: String,
    /// Claim phase (`"Bound"`, `"Pending"`, `"Lost"`).
    pub status: Option<String>,
    /// Bound volume name, when bound.
    pub volume: Option<String>,
    /// Requested/actual storage capacity (e.g. `"10Gi"`).
    pub capacity: Option<String>,
    /// Access modes (e.g. `"RWO"`, `"ROX"`, `"RWX"`).
    pub access_modes: Vec<String>,
    /// Storage class name, when set.
    pub storage_class: Option<String>,
    /// RFC 3339 creation timestamp, when reported by the API server.
    pub creation_timestamp: Option<String>,
}
