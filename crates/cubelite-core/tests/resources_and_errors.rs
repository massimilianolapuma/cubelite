//! Integration tests for resource info types and error formatting.

use cubelite_core::error::{ContextError, KubeconfigError};
use cubelite_core::{DeploymentInfo, NamespaceInfo, PodInfo};

// ---------------------------------------------------------------------------
// PodInfo
// ---------------------------------------------------------------------------

#[test]
fn pod_info_serializes_to_json() {
    let pod = PodInfo {
        name: "nginx-abc".to_string(),
        namespace: "default".to_string(),
        phase: Some("Running".to_string()),
        ready: true,
        restarts: 0,
    };
    let json = serde_json::to_string(&pod).expect("serialize");
    assert!(json.contains("\"name\":\"nginx-abc\""));
    assert!(json.contains("\"phase\":\"Running\""));
    assert!(json.contains("\"ready\":true"));
    assert!(json.contains("\"restarts\":0"));
}

#[test]
fn pod_info_deserializes_from_json() {
    let json = r#"{"name":"redis","namespace":"cache","phase":null,"ready":false,"restarts":5}"#;
    let pod: PodInfo = serde_json::from_str(json).expect("deserialize");
    assert_eq!(pod.name, "redis");
    assert_eq!(pod.namespace, "cache");
    assert!(pod.phase.is_none());
    assert!(!pod.ready);
    assert_eq!(pod.restarts, 5);
}

#[test]
fn pod_info_roundtrip() {
    let original = PodInfo {
        name: "test-pod".to_string(),
        namespace: "kube-system".to_string(),
        phase: Some("Pending".to_string()),
        ready: false,
        restarts: 3,
    };
    let json = serde_json::to_string(&original).expect("serialize");
    let deserialized: PodInfo = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(deserialized.name, original.name);
    assert_eq!(deserialized.namespace, original.namespace);
    assert_eq!(deserialized.phase, original.phase);
    assert_eq!(deserialized.ready, original.ready);
    assert_eq!(deserialized.restarts, original.restarts);
}

// ---------------------------------------------------------------------------
// NamespaceInfo
// ---------------------------------------------------------------------------

#[test]
fn namespace_info_serializes_to_json() {
    let ns = NamespaceInfo {
        name: "default".to_string(),
        phase: Some("Active".to_string()),
    };
    let json = serde_json::to_string(&ns).expect("serialize");
    assert!(json.contains("\"name\":\"default\""));
    assert!(json.contains("\"phase\":\"Active\""));
}

#[test]
fn namespace_info_with_null_phase() {
    let ns = NamespaceInfo {
        name: "terminating-ns".to_string(),
        phase: None,
    };
    let json = serde_json::to_string(&ns).expect("serialize");
    assert!(json.contains("\"phase\":null"));
}

#[test]
fn namespace_info_roundtrip() {
    let original = NamespaceInfo {
        name: "monitoring".to_string(),
        phase: Some("Active".to_string()),
    };
    let json = serde_json::to_string(&original).expect("serialize");
    let deserialized: NamespaceInfo = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(deserialized.name, original.name);
    assert_eq!(deserialized.phase, original.phase);
}

// ---------------------------------------------------------------------------
// DeploymentInfo
// ---------------------------------------------------------------------------

#[test]
fn deployment_info_serializes_to_json() {
    let dep = DeploymentInfo {
        name: "nginx".to_string(),
        namespace: "default".to_string(),
        replicas: 3,
        ready_replicas: 3,
    };
    let json = serde_json::to_string(&dep).expect("serialize");
    assert!(json.contains("\"replicas\":3"));
    assert!(json.contains("\"ready_replicas\":3"));
}

#[test]
fn deployment_info_degraded_state() {
    let dep = DeploymentInfo {
        name: "api".to_string(),
        namespace: "production".to_string(),
        replicas: 5,
        ready_replicas: 2,
    };
    assert!(dep.ready_replicas < dep.replicas);
}

#[test]
fn deployment_info_zero_replicas() {
    let dep = DeploymentInfo {
        name: "scaled-down".to_string(),
        namespace: "staging".to_string(),
        replicas: 0,
        ready_replicas: 0,
    };
    let json = serde_json::to_string(&dep).expect("serialize");
    let deserialized: DeploymentInfo = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(deserialized.replicas, 0);
    assert_eq!(deserialized.ready_replicas, 0);
}

// ---------------------------------------------------------------------------
// Error display messages
// ---------------------------------------------------------------------------

#[test]
fn kubeconfig_error_file_not_found_display() {
    let err = KubeconfigError::FileNotFound {
        path: "/home/user/.kube/config".to_string(),
    };
    assert_eq!(
        err.to_string(),
        "kubeconfig file not found: /home/user/.kube/config"
    );
}

#[test]
fn kubeconfig_error_merge_error_display() {
    let err = KubeconfigError::MergeError {
        reason: "duplicate context names".to_string(),
    };
    assert_eq!(
        err.to_string(),
        "failed to merge kubeconfig files: duplicate context names"
    );
}

#[test]
fn kubeconfig_error_client_error_display() {
    let err = KubeconfigError::ClientError {
        reason: "TLS handshake failed".to_string(),
    };
    assert_eq!(
        err.to_string(),
        "kubernetes client error: TLS handshake failed"
    );
}

#[test]
fn kubeconfig_error_watch_error_display() {
    let err = KubeconfigError::WatchError {
        reason: "stream disconnected".to_string(),
    };
    assert_eq!(err.to_string(), "watch error: stream disconnected");
}

#[test]
fn context_error_not_found_display() {
    let err = ContextError::NotFound {
        name: "nonexistent".to_string(),
    };
    assert_eq!(
        err.to_string(),
        "context 'nonexistent' not found in kubeconfig"
    );
}

#[test]
fn context_error_from_kubeconfig_error() {
    let kube_err = KubeconfigError::FileNotFound {
        path: "/tmp/missing".to_string(),
    };
    let ctx_err: ContextError = kube_err.into();
    assert!(ctx_err.to_string().contains("kubeconfig file not found"));
}

#[test]
fn kubeconfig_error_io_from_std_io() {
    let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied");
    let kube_err: KubeconfigError = io_err.into();
    assert!(kube_err.to_string().contains("access denied"));
}
