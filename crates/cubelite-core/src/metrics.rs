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

/// A parsed Kubernetes quantity: `digits * 10^exp10 * 2^exp2`.
///
/// The number's digits are kept apart from its decimal point so that
/// `1.5`, `250m` or `128974848000m` scale without a rounding error.
struct Quantity {
    digits: f64,
    exp10: i32,
    exp2: i32,
}

impl Quantity {
    /// The amount in units of `10^unit_exp10` (0 for base units, -3 for
    /// milli-units). `None` when the result is not a finite number.
    fn in_units(&self, unit_exp10: i32) -> Option<f64> {
        let exp = self.exp10 - unit_exp10;
        let scaled = if exp >= 0 {
            self.digits * 10f64.powi(exp)
        } else {
            self.digits / 10f64.powi(-exp)
        };
        let value = scaled * 2f64.powi(self.exp2);
        value.is_finite().then_some(value)
    }
}

/// Parse a Kubernetes quantity (`<number><suffix>`) as the API server
/// writes it.
///
/// Suffixes: binary `Ki` to `Ei`; decimal `n`, `u`, `m`, none, `k`, `M`,
/// `G`, `T`, `P`, `E`; or a decimal exponent (`e3`, `E-2`). A trailing `E`
/// alone is exa. A negative number is `None`: no request, limit or usage
/// this app reads can be below zero.
fn parse_quantity(quantity: &str) -> Option<Quantity> {
    let q = quantity.trim();
    let unsigned = q.strip_prefix('+').unwrap_or(q);
    if unsigned.starts_with('-') {
        return None;
    }
    let number_len = unsigned
        .find(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .unwrap_or(unsigned.len());
    let (number, suffix) = unsigned.split_at(number_len);
    let (whole, fraction) = number.split_once('.').unwrap_or((number, ""));
    if (whole.is_empty() && fraction.is_empty()) || fraction.contains('.') {
        return None;
    }
    let digits = format!("{whole}{fraction}").parse::<f64>().ok()?;
    let fraction_len = i32::try_from(fraction.len()).ok()?;
    let (exp10, exp2) = match suffix {
        "" => (0, 0),
        "n" => (-9, 0),
        "u" => (-6, 0),
        "m" => (-3, 0),
        "k" => (3, 0),
        "M" => (6, 0),
        "G" => (9, 0),
        "T" => (12, 0),
        "P" => (15, 0),
        "E" => (18, 0),
        "Ki" => (0, 10),
        "Mi" => (0, 20),
        "Gi" => (0, 30),
        "Ti" => (0, 40),
        "Pi" => (0, 50),
        "Ei" => (0, 60),
        _ => {
            let exponent = suffix
                .strip_prefix('e')
                .or_else(|| suffix.strip_prefix('E'))?;
            let digits_only = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
            if digits_only.is_empty() || !digits_only.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            (exponent.parse::<i32>().ok()?, 0)
        }
    };
    Some(Quantity {
        digits,
        exp10: exp10 - fraction_len,
        exp2,
    })
}

/// Parse a Kubernetes CPU quantity into millicores.
///
/// Accepts the full quantity grammar (see [`parse_quantity`]): `250m`,
/// `2`, `1500000n`, `0.5`, `1e3`. Negative or unreadable is `None`.
pub fn parse_cpu_millis(quantity: &str) -> Option<f64> {
    parse_quantity(quantity)?.in_units(-3)
}

/// Parse a Kubernetes memory quantity into bytes.
///
/// Accepts the full quantity grammar (see [`parse_quantity`]): binary
/// (`Ki` to `Ei`), decimal (`k` to `E`, and `m` for milli-bytes, which
/// the API server writes for some computed values), exponents (`12e6`)
/// and plain bytes. A fraction of a byte is rounded to the nearest byte.
/// Negative, unreadable or above `u64::MAX` is `None`.
pub fn parse_memory_bytes(quantity: &str) -> Option<u64> {
    let bytes = parse_quantity(quantity)?.in_units(0)?.round();
    // 2^64 is exactly representable; anything at or above it does not fit.
    (bytes < 18_446_744_073_709_551_616.0).then_some(bytes as u64)
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
    fn parse_memory_bytes_full_grammar() {
        assert_eq!(parse_memory_bytes("1Pi"), Some(1_125_899_906_842_624));
        assert_eq!(parse_memory_bytes("1Ei"), Some(1_152_921_504_606_846_976));
        assert_eq!(parse_memory_bytes("1P"), Some(1_000_000_000_000_000));
        assert_eq!(parse_memory_bytes("1E"), Some(1_000_000_000_000_000_000));
        assert_eq!(parse_memory_bytes("1e3"), Some(1_000));
        assert_eq!(parse_memory_bytes("12E6"), Some(12_000_000));
        assert_eq!(parse_memory_bytes("128974848000m"), Some(128_974_848));
        assert_eq!(parse_memory_bytes("1.5Gi"), Some(1_610_612_736));
    }

    #[test]
    fn parse_quantities_reject_what_is_not_a_quantity() {
        for bad in ["", " ", "abc", "-1Gi", "-5", "1Xi", "Gi"] {
            assert_eq!(parse_memory_bytes(bad), None, "{bad:?}");
        }
        for bad in ["", "abc", "-100m", "m"] {
            assert_eq!(parse_cpu_millis(bad), None, "{bad:?}");
        }
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
