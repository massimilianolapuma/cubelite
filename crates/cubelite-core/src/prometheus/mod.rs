//! Prometheus history for pods and deployments, and Grafana deep links (#484, #509).
//!
//! Spec: `docs/superpowers/specs/2026-11-03-prometheus-grafana-design.md`.
//! This module holds the pure parts — endpoint model, PromQL builder,
//! step/window maths, response parsing, Grafana Explore URL — while
//! [`transport`] reaches Prometheus and [`azure`] gets Azure Monitor tokens.

pub mod azure;
pub mod transport;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Where the Prometheus HTTP API lives (shared with the other integrations).
pub use crate::integration::Target as PromTarget;

/// A context's Prometheus endpoint (no secrets: those live in the OS keychain).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromEndpoint {
    /// Where the API lives.
    pub target: PromTarget,
    /// Value of the `cluster` label added to every query (a shared
    /// Azure Monitor workspace or Thanos holds many clusters).
    #[serde(default)]
    pub cluster: Option<String>,
    /// Grafana base URL, when known.
    #[serde(default)]
    pub grafana_url: Option<String>,
    /// Grafana datasource UID or name; empty uses Grafana's default.
    #[serde(default)]
    pub grafana_datasource: Option<String>,
    /// Accept any certificate (opt-in, for self-signed endpoints without a CA).
    #[serde(default)]
    pub skip_tls_verify: bool,
}

/// Credentials for an endpoint.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "method", rename_all = "kebab-case")]
pub enum PromAuth {
    /// No authentication.
    #[default]
    None,
    /// Basic auth (Grafana Cloud: instance id + token).
    Basic {
        /// User name.
        username: String,
        /// Password.
        password: String,
    },
    /// Bearer token.
    Bearer {
        /// Token.
        token: String,
    },
    /// Azure Monitor managed Prometheus: an Entra ID token from the Azure
    /// CLI, fetched at connect time and never stored.
    AzureCli,
}

impl std::fmt::Debug for PromAuth {
    // Never print secrets.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PromAuth({})", self.method())
    }
}

impl PromAuth {
    /// The tag (`none`, `basic`, `bearer`, `azure-cli`).
    pub fn method(&self) -> &'static str {
        match self {
            PromAuth::None => "none",
            PromAuth::Basic { .. } => "basic",
            PromAuth::Bearer { .. } => "bearer",
            PromAuth::AzureCli => "azure-cli",
        }
    }

    /// `Authorization` header value for the stored methods (`AzureCli` is
    /// resolved to a bearer token when connecting).
    pub fn header(&self) -> Option<String> {
        use base64::Engine;
        match self {
            PromAuth::None | PromAuth::AzureCli => None,
            PromAuth::Basic { username, password } => Some(format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
            )),
            PromAuth::Bearer { token } => Some(format!("Bearer {}", token.trim())),
        }
    }
}

/// Errors of the Prometheus integration, with user-facing text.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PromError {
    /// The endpoint configuration is unusable.
    #[error("{0}")]
    Config(String),
    /// Could not reach the endpoint (proxy, port-forward, DNS, TLS, timeout).
    #[error("Cannot reach Prometheus: {0}")]
    Connect(String),
    /// Prometheus answered with an error.
    #[error("Prometheus returned {status}: {reason}")]
    Http {
        /// HTTP status.
        status: u16,
        /// Server reason (`error`) or a status explanation.
        reason: String,
    },
    /// The response was not what the API returns.
    #[error("Unexpected Prometheus response: {0}")]
    Response(String),
}

/// What the charts are about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Workload {
    /// One pod.
    Pod {
        /// Pod name.
        name: String,
    },
    /// A deployment's pods (`name-<replicaset hash>-<suffix>`).
    Deployment {
        /// Deployment name.
        name: String,
    },
    /// A StatefulSet's pods (`name-<ordinal>`).
    StatefulSet {
        /// StatefulSet name.
        name: String,
    },
}

/// Chart ranges (spec §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MetricsRange {
    /// Last hour.
    #[serde(rename = "1h")]
    Hour,
    /// Last 6 hours.
    #[serde(rename = "6h")]
    SixHours,
    /// Last day.
    #[serde(rename = "24h")]
    Day,
    /// Last week.
    #[serde(rename = "7d")]
    Week,
}

impl MetricsRange {
    /// Range length in seconds.
    pub fn seconds(self) -> u64 {
        match self {
            MetricsRange::Hour => 3_600,
            MetricsRange::SixHours => 6 * 3_600,
            MetricsRange::Day => 24 * 3_600,
            MetricsRange::Week => 7 * 24 * 3_600,
        }
    }

    /// Step: about 240 points per chart, never under 15 s.
    pub fn step(self) -> u64 {
        (self.seconds() / 240).max(15)
    }

    /// Rate window: four steps (a missed scrape leaves no gap), at least 1 m.
    pub fn window(self) -> u64 {
        (4 * self.step()).max(60)
    }

    /// Grafana / Prometheus relative start (`now-1h`).
    pub fn grafana_from(self) -> &'static str {
        match self {
            MetricsRange::Hour => "now-1h",
            MetricsRange::SixHours => "now-6h",
            MetricsRange::Day => "now-24h",
            MetricsRange::Week => "now-7d",
        }
    }
}

/// One chart of the Metrics section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Chart {
    /// CPU usage (cores).
    Cpu,
    /// CPU requests (cores).
    CpuRequest,
    /// CPU limits (cores).
    CpuLimit,
    /// Memory working set (bytes).
    Memory,
    /// Memory requests (bytes).
    MemoryRequest,
    /// Memory limits (bytes).
    MemoryLimit,
    /// Cumulative restart counter; the range total is the sum of its
    /// increases (a new pod starts again from 0).
    Restarts,
    /// Received bytes per second (pod level).
    NetworkRx,
    /// Transmitted bytes per second (pod level).
    NetworkTx,
}

impl Chart {
    /// Every chart, in display order.
    pub const ALL: [Chart; 9] = [
        Chart::Cpu,
        Chart::CpuRequest,
        Chart::CpuLimit,
        Chart::Memory,
        Chart::MemoryRequest,
        Chart::MemoryLimit,
        Chart::Restarts,
        Chart::NetworkRx,
        Chart::NetworkTx,
    ];
}

/// PromQL string literal: `"…"` with `\`, `"` and newlines escaped.
pub fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Escapes regex metacharacters (RE2) so a name matches literally.
fn regex_literal(name: &str) -> String {
    name.chars()
        .flat_map(|c| {
            let meta = "\\.+*?()|[]{}^$".contains(c);
            meta.then_some('\\').into_iter().chain(std::iter::once(c))
        })
        .collect()
}

/// Alphabet of ReplicaSet hashes and generated name suffixes (Kubernetes'
/// `rand.SafeEncodeString`: no vowels, no 0/1/3), which also keeps CronJob
/// pods (`name-<minutes>-xxxxx`) out of a deployment's match.
const SAFE: &str = "[bcdfghjklmnpqrstvwxz2456789]";

/// Generated names are cut to 58 characters before the 5-character suffix.
const GENERATED_PREFIX_MAX: usize = 58;

/// Regex for a deployment's pods: `name-<hash>-<suffix>`, or for long names
/// the truncated `generateName` prefix followed by the suffix.
fn deployment_pods(name: &str) -> String {
    if name.len() + "-".len() + 10 + "-".len() <= GENERATED_PREFIX_MAX {
        return format!("{}-{SAFE}{{6,10}}-{SAFE}{{5}}", regex_literal(name));
    }
    let kept: String = name.chars().take(GENERATED_PREFIX_MAX).collect();
    format!("{}(-{SAFE}{{0,10}}-?)?{SAFE}{{5}}", regex_literal(&kept))
}

/// Label matchers for a workload: namespace, pod (exact or regex) and the
/// optional `cluster` label.
pub fn selector(namespace: &str, workload: &Workload, cluster: Option<&str>) -> String {
    let pod = match workload {
        Workload::Pod { name } => format!("pod={}", escape(name)),
        Workload::Deployment { name } => format!("pod=~{}", escape(&deployment_pods(name))),
        Workload::StatefulSet { name } => {
            format!(
                "pod=~{}",
                escape(&format!("{}-[0-9]+", regex_literal(name)))
            )
        }
    };
    let mut out = format!("namespace={}, {pod}", escape(namespace));
    if let Some(c) = cluster.map(str::trim).filter(|c| !c.is_empty()) {
        out.push_str(&format!(", cluster={}", escape(c)));
    }
    out
}

/// The PromQL of one chart. Per container charts group `by (container)`;
/// network is pod level and always summed.
pub fn chart_query(chart: Chart, sel: &str, per_container: bool, window: u64) -> String {
    let containers = r#"container!="", container!="POD""#;
    let inner = match chart {
        Chart::Cpu => {
            format!("rate(container_cpu_usage_seconds_total{{{sel}, {containers}}}[{window}s])")
        }
        Chart::CpuRequest | Chart::CpuLimit | Chart::MemoryRequest | Chart::MemoryLimit => {
            let (metric, resource) = match chart {
                Chart::CpuRequest => ("requests", "cpu"),
                Chart::CpuLimit => ("limits", "cpu"),
                Chart::MemoryRequest => ("requests", "memory"),
                _ => ("limits", "memory"),
            };
            format!(r#"kube_pod_container_resource_{metric}{{{sel}, resource="{resource}"}}"#)
        }
        Chart::Memory => format!("container_memory_working_set_bytes{{{sel}, {containers}}}"),
        Chart::Restarts => format!("kube_pod_container_status_restarts_total{{{sel}}}"),
        Chart::NetworkRx => {
            return format!("sum(rate(container_network_receive_bytes_total{{{sel}}}[{window}s]))")
        }
        Chart::NetworkTx => {
            return format!("sum(rate(container_network_transmit_bytes_total{{{sel}}}[{window}s]))")
        }
    };
    if per_container {
        format!("sum by (container) ({inner})")
    } else {
        format!("sum({inner})")
    }
}

/// What the Metrics section asks for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsRequest {
    /// Workload namespace.
    pub namespace: String,
    /// Pod, deployment or StatefulSet.
    pub workload: Workload,
    /// Chart range.
    pub range: MetricsRange,
    /// One line per container instead of the sum.
    #[serde(default)]
    pub per_container: bool,
}

/// Every chart's PromQL for `request`.
pub fn metrics_queries(request: &MetricsRequest, cluster: Option<&str>) -> Vec<(Chart, String)> {
    let sel = selector(&request.namespace, &request.workload, cluster);
    let window = request.range.window();
    Chart::ALL
        .iter()
        .map(|&chart| {
            (
                chart,
                chart_query(chart, &sel, request.per_container, window),
            )
        })
        .collect()
}

/// One line of a chart: its label (container, pod, or empty when summed)
/// and `[unix seconds, value]` points (`null` for NaN/Inf, so lines break).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Series {
    /// Container or pod name; empty for a sum.
    pub label: String,
    /// Points, oldest first.
    pub points: Vec<(f64, Option<f64>)>,
}

/// One chart's data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartData {
    /// Which chart.
    pub chart: Chart,
    /// Its PromQL (for Open in Grafana).
    pub query: String,
    /// Lines; empty when the series does not exist.
    pub series: Vec<Series>,
    /// Why this chart failed, when the others did not.
    pub error: Option<String>,
}

/// The Metrics section's data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsResult {
    /// Range start (unix seconds).
    pub start: u64,
    /// Range end (unix seconds).
    pub end: u64,
    /// Step (seconds).
    pub step: u64,
    /// Charts in [`Chart::ALL`] order.
    pub charts: Vec<ChartData>,
}

/// CPU and memory of the last hour per pod, for list sparklines.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Sparklines {
    /// Cores per pod.
    pub cpu: BTreeMap<String, Vec<(f64, Option<f64>)>>,
    /// Working-set bytes per pod.
    pub memory: BTreeMap<String, Vec<(f64, Option<f64>)>>,
}

/// Sparkline range and step: the last hour at 2 m.
pub const SPARKLINE_RANGE: u64 = 3_600;
/// Sparkline step.
pub const SPARKLINE_STEP: u64 = 120;

/// The two sparkline queries of a namespace (CPU, memory), `by (pod)`.
pub fn sparkline_queries(namespace: &str, cluster: Option<&str>) -> (String, String) {
    let mut sel = format!("namespace={}", escape(namespace));
    if let Some(c) = cluster.map(str::trim).filter(|c| !c.is_empty()) {
        sel.push_str(&format!(", cluster={}", escape(c)));
    }
    let containers = r#"container!="", container!="POD""#;
    (
        format!(
            "sum by (pod) (rate(container_cpu_usage_seconds_total{{{sel}, {containers}}}[5m]))"
        ),
        format!("sum by (pod) (container_memory_working_set_bytes{{{sel}, {containers}}})"),
    )
}

fn sample(v: &Value) -> Option<(f64, Option<f64>)> {
    let pair = v.as_array()?;
    let t = pair.first()?.as_f64()?;
    let value = pair
        .get(1)?
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|x| x.is_finite());
    Some((t, value))
}

/// Parses a `query_range` (matrix) or `query` (vector) `data` object into
/// series labelled by `label` (`container`, `pod`, or none for a sum).
pub fn parse_series(data: &Value, label: Option<&str>) -> Result<Vec<Series>, PromError> {
    let result = data
        .get("result")
        .and_then(Value::as_array)
        .ok_or_else(|| PromError::Response("no data.result array".to_string()))?;
    let mut series: Vec<Series> = result
        .iter()
        .map(|item| {
            let name = label
                .and_then(|l| item.get("metric")?.get(l)?.as_str())
                .unwrap_or("")
                .to_string();
            let points = match (item.get("values"), item.get("value")) {
                (Some(Value::Array(values)), _) => values.iter().filter_map(sample).collect(),
                (_, Some(v)) => sample(v).into_iter().collect(),
                _ => Vec::new(),
            };
            Series {
                label: name,
                points,
            }
        })
        .collect();
    series.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(series)
}

/// The `data` of a successful API response, or the server's error.
pub fn unwrap_data(body: Value) -> Result<Value, PromError> {
    match body.get("status").and_then(Value::as_str) {
        Some("success") => body
            .get("data")
            .cloned()
            .ok_or_else(|| PromError::Response("no data".to_string())),
        Some("error") => Err(PromError::Http {
            status: 400,
            reason: body
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("query failed")
                .to_string(),
        }),
        _ => Err(PromError::Response("no status field".to_string())),
    }
}

/// The server's reason from an error body (`error`), else a status explanation.
pub fn error_reason(body: &str, status: u16) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| match status {
            401 => "authentication failed — check the credentials".to_string(),
            403 => "access denied".to_string(),
            404 => "not found — check the URL (it should end before /api/v1)".to_string(),
            _ => body.chars().take(200).collect(),
        })
}

/// Grafana Explore with `queries` over `[from, to]` (Grafana 10+ `panes`
/// state). `datasource` empty uses Grafana's default datasource.
pub fn grafana_explore_url(
    grafana_base: &str,
    datasource: Option<&str>,
    queries: &[String],
    from: &str,
    to: &str,
) -> String {
    let ds = datasource.map(str::trim).filter(|d| !d.is_empty());
    let queries: Vec<Value> = queries
        .iter()
        .enumerate()
        .map(|(n, expr)| {
            // refId A, B, …, Z, AA, …
            let ref_id = {
                let mut id = String::new();
                let mut k = n;
                loop {
                    id.insert(0, char::from(b'A' + (k % 26) as u8));
                    if k < 26 {
                        break;
                    }
                    k = k / 26 - 1;
                }
                id
            };
            let mut q = serde_json::json!({ "refId": ref_id, "expr": expr });
            if let Some(ds) = ds {
                q["datasource"] = serde_json::json!({ "uid": ds });
            }
            q
        })
        .collect();
    let mut pane = serde_json::json!({
        "queries": queries,
        "range": { "from": from, "to": to },
    });
    if let Some(ds) = ds {
        pane["datasource"] = Value::String(ds.to_string());
    }
    let panes = serde_json::json!({ "a": pane }).to_string();
    let encoded: String = url::form_urlencoded::byte_serialize(panes.as_bytes()).collect();
    format!(
        "{}/explore?schemaVersion=1&panes={encoded}",
        grafana_base.trim().trim_end_matches('/')
    )
}

#[cfg(test)]
mod tests;
