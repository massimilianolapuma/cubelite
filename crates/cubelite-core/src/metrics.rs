//! metrics.k8s.io integration (requires metrics-server in the cluster).
//!
//! Raw JSON requests against `/apis/metrics.k8s.io/v1beta1` — the payloads
//! are tiny and a typed client dependency is not worth it. Kubernetes
//! quantity strings are parsed with [`parse_cpu_millis`] /
//! [`parse_memory_bytes`].

use serde::{Deserialize, Serialize};

/// CPU/memory usage of one pod (summed over its containers).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PodMetricsInfo {
    /// Pod name.
    pub name: String,
    /// Pod namespace.
    pub namespace: String,
    /// CPU usage in millicores.
    pub cpu_millis: f64,
    /// Memory usage in bytes.
    pub memory_bytes: u64,
}

/// Usage and allocatable capacity of one node.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NodeCapacityInfo {
    /// Node name.
    pub name: String,
    /// CPU usage in millicores (from metrics-server).
    pub cpu_used_millis: f64,
    /// Allocatable CPU in millicores (from the node status).
    pub cpu_allocatable_millis: f64,
    /// Memory usage in bytes (from metrics-server).
    pub memory_used_bytes: u64,
    /// Allocatable memory in bytes (from the node status).
    pub memory_allocatable_bytes: u64,
}

/// Parse a Kubernetes CPU quantity into millicores.
///
/// Accepts nano (`n`), micro (`u`), milli (`m`) suffixes and plain cores.
pub fn parse_cpu_millis(quantity: &str) -> Option<f64> {
    let q = quantity.trim();
    if let Some(v) = q.strip_suffix('n') {
        return v.parse::<f64>().ok().map(|n| n / 1_000_000.0);
    }
    if let Some(v) = q.strip_suffix('u') {
        return v.parse::<f64>().ok().map(|n| n / 1_000.0);
    }
    if let Some(v) = q.strip_suffix('m') {
        return v.parse::<f64>().ok();
    }
    q.parse::<f64>().ok().map(|cores| cores * 1000.0)
}

/// Parse a Kubernetes memory quantity into bytes.
///
/// Accepts binary (`Ki`, `Mi`, `Gi`, `Ti`) and decimal (`k`, `M`, `G`, `T`)
/// suffixes and plain bytes.
pub fn parse_memory_bytes(quantity: &str) -> Option<u64> {
    let q = quantity.trim();
    let table: [(&str, f64); 8] = [
        ("Ki", 1024.0),
        ("Mi", 1024.0 * 1024.0),
        ("Gi", 1024.0 * 1024.0 * 1024.0),
        ("Ti", 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("k", 1e3),
        ("M", 1e6),
        ("G", 1e9),
        ("T", 1e12),
    ];
    for (suffix, factor) in table {
        if let Some(v) = q.strip_suffix(suffix) {
            return v.parse::<f64>().ok().map(|n| (n * factor) as u64);
        }
    }
    q.parse::<u64>().ok()
}

/// Sum the container usage entries of one PodMetrics item.
pub(crate) fn pod_metrics_from_item(item: &serde_json::Value) -> Option<PodMetricsInfo> {
    let name = item["metadata"]["name"].as_str()?.to_string();
    let namespace = item["metadata"]["namespace"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let mut cpu_millis = 0.0;
    let mut memory_bytes = 0u64;
    for c in item["containers"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        if let Some(cpu) = c["usage"]["cpu"].as_str().and_then(parse_cpu_millis) {
            cpu_millis += cpu;
        }
        if let Some(mem) = c["usage"]["memory"].as_str().and_then(parse_memory_bytes) {
            memory_bytes += mem;
        }
    }
    Some(PodMetricsInfo {
        name,
        namespace,
        cpu_millis,
        memory_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cpu_quantities() {
        assert_eq!(parse_cpu_millis("250m"), Some(250.0));
        assert_eq!(parse_cpu_millis("2"), Some(2000.0));
        assert_eq!(parse_cpu_millis("1500000n"), Some(1.5));
        assert_eq!(parse_cpu_millis("2500u"), Some(2.5));
        assert_eq!(parse_cpu_millis("garbage"), None);
    }

    #[test]
    fn parses_memory_quantities() {
        assert_eq!(parse_memory_bytes("128Ki"), Some(131072));
        assert_eq!(parse_memory_bytes("1Mi"), Some(1048576));
        assert_eq!(parse_memory_bytes("2Gi"), Some(2147483648));
        assert_eq!(parse_memory_bytes("5M"), Some(5000000));
        assert_eq!(parse_memory_bytes("1024"), Some(1024));
        assert_eq!(parse_memory_bytes("x"), None);
    }

    #[test]
    fn sums_container_usage() {
        let item = serde_json::json!({
            "metadata": { "name": "api-0", "namespace": "default" },
            "containers": [
                { "usage": { "cpu": "100m", "memory": "64Mi" } },
                { "usage": { "cpu": "50m", "memory": "32Mi" } }
            ]
        });
        let m = pod_metrics_from_item(&item).expect("parse");
        assert_eq!(m.cpu_millis, 150.0);
        assert_eq!(m.memory_bytes, 96 * 1024 * 1024);
    }
}
