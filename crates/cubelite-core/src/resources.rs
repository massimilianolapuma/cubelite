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

/// Full per-container detail for the log-panel container picker.
///
/// Ordering contract of producers: app containers first (spec order), then
/// native sidecars (init containers with `restartPolicy: Always`), then
/// plain init containers.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContainerDetail {
    /// Container name.
    pub name: String,
    /// Plain init container (runs to completion before the pod starts).
    pub init: bool,
    /// Native sidecar: `initContainers` entry with `restartPolicy: Always`.
    pub sidecar: bool,
    /// Restart count from the container status (0 when unknown).
    pub restarts: i32,
    /// `true` when the container reports ready.
    pub ready: bool,
    /// Current state bucket: `"running"`, `"waiting"` or `"terminated"`.
    pub state: String,
    /// Reason of the current state (e.g. `CrashLoopBackOff`, `Completed`).
    pub state_reason: Option<String>,
    /// Reason of the last terminated instance (e.g. `OOMKilled`), for the
    /// previous-logs affordance.
    pub last_terminated_reason: Option<String>,
    /// RFC 3339 finish time of the last terminated instance.
    pub last_terminated_at: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pod_info_accepts_v0_1_payload_without_newer_fields() {
        // Payload shape from before the drawer fields existed.
        let pod: PodInfo = serde_json::from_value(json!({
            "name": "web-1",
            "namespace": "default",
            "phase": "Running",
            "ready": true,
            "restarts": 2
        }))
        .expect("v0.1 PodInfo payload must deserialize");
        assert_eq!(pod.name, "web-1");
        assert_eq!(pod.restarts, 2);
        assert_eq!(pod.ready_containers, 0);
        assert!(pod.containers.is_empty());
        assert!(pod.labels.is_empty());
        assert!(pod.node.is_none());
        assert!(pod.creation_timestamp.is_none());
    }

    #[test]
    fn deployment_info_accepts_v0_1_payload_without_newer_fields() {
        let dep: DeploymentInfo = serde_json::from_value(json!({
            "name": "api",
            "namespace": "prod",
            "replicas": 3,
            "ready_replicas": 2
        }))
        .expect("v0.1 DeploymentInfo payload must deserialize");
        assert_eq!(dep.replicas, 3);
        assert_eq!(dep.ready_replicas, 2);
        assert!(dep.images.is_empty());
        assert!(dep.selector.is_empty());
        assert!(dep.strategy.is_none());
        assert!(dep.conditions.is_empty());
    }

    #[test]
    fn pod_info_serializes_snake_case_keys_the_frontend_reads() {
        let mut labels = BTreeMap::new();
        labels.insert("app".to_string(), "web".to_string());
        let pod = PodInfo {
            name: "web-1".into(),
            namespace: "default".into(),
            ready_containers: 1,
            total_containers: 2,
            pod_ip: Some("10.0.0.5".into()),
            qos_class: Some("Burstable".into()),
            labels,
            creation_timestamp: Some("2026-09-30T10:00:00Z".into()),
            containers: vec![ContainerInfo {
                name: "app".into(),
                image: None,
                ready: true,
            }],
            ..PodInfo::default()
        };
        let v = serde_json::to_value(&pod).expect("PodInfo must serialize");
        for key in [
            "ready_containers",
            "total_containers",
            "pod_ip",
            "qos_class",
            "labels",
            "creation_timestamp",
            "containers",
        ] {
            assert!(v.get(key).is_some(), "missing key `{key}` in {v}");
        }
        assert_eq!(v["labels"]["app"], "web");
        assert_eq!(v["containers"][0]["ready"], true);
    }

    #[test]
    fn container_detail_round_trips() {
        let detail = ContainerDetail {
            name: "istio-proxy".into(),
            sidecar: true,
            restarts: 4,
            state: "waiting".into(),
            state_reason: Some("CrashLoopBackOff".into()),
            last_terminated_reason: Some("OOMKilled".into()),
            ..ContainerDetail::default()
        };
        let json = serde_json::to_string(&detail).expect("serialize");
        let back: ContainerDetail = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.name, "istio-proxy");
        assert!(back.sidecar && !back.init);
        assert_eq!(back.restarts, 4);
        assert_eq!(back.state_reason.as_deref(), Some("CrashLoopBackOff"));
        assert_eq!(back.last_terminated_reason.as_deref(), Some("OOMKilled"));
    }

    #[test]
    fn deployment_condition_uses_condition_type_key() {
        let cond = DeploymentConditionInfo {
            condition_type: "Available".into(),
            status: "True".into(),
            reason: Some("MinimumReplicasAvailable".into()),
        };
        let v = serde_json::to_value(&cond).expect("serialize");
        assert_eq!(v["condition_type"], "Available");
        assert_eq!(v["status"], "True");
    }

    #[test]
    fn event_info_keeps_optional_fields_as_null() {
        let ev = EventInfo {
            event_type: None,
            reason: Some("BackOff".into()),
            object: "Pod/web-1".into(),
            message: None,
            namespace: "default".into(),
            count: 3,
            last_timestamp: None,
        };
        let v = serde_json::to_value(&ev).expect("serialize");
        assert!(v["event_type"].is_null());
        assert!(v["last_timestamp"].is_null());
        assert_eq!(v["count"], 3);
    }
}
