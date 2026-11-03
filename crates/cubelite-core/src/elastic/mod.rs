//! Elasticsearch log history and Kibana deep links (#483, #500).
//!
//! Spec: `docs/superpowers/specs/2026-11-03-elastic-kibana-design.md`.
//! This module holds the pure parts — endpoint model, `_search` body,
//! hit → line mapping, Kibana Discover URL — and [`transport`] reaches the
//! cluster (port-forward for in-cluster, HTTPS for external endpoints).

pub mod transport;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::logs::{detect_level, LogLevel};

/// Where the Elasticsearch HTTP API lives (shared with the other integrations).
pub use crate::integration::Target as EsTarget;

/// Which log shipper wrote the documents, i.e. which field names to filter on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum FieldPreset {
    /// Elastic Agent / Filebeat (ECS): `kubernetes.pod.name`, `message`.
    #[default]
    Ecs,
    /// Fluent Bit / Fluentd: `kubernetes.pod_name`, `log`.
    FluentBit,
}

/// Field names of a preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresetFields {
    /// Namespace field.
    pub namespace: &'static str,
    /// Pod name field.
    pub pod: &'static str,
    /// Container name field.
    pub container: &'static str,
    /// Message text field.
    pub message: &'static str,
}

impl FieldPreset {
    /// Field names to filter and read.
    pub fn fields(self) -> PresetFields {
        match self {
            FieldPreset::Ecs => PresetFields {
                namespace: "kubernetes.namespace",
                pod: "kubernetes.pod.name",
                container: "kubernetes.container.name",
                message: "message",
            },
            FieldPreset::FluentBit => PresetFields {
                namespace: "kubernetes.namespace_name",
                pod: "kubernetes.pod_name",
                container: "kubernetes.container_name",
                message: "log",
            },
        }
    }
}

/// Default index pattern: Elastic Agent data streams, Filebeat, Logstash.
pub const DEFAULT_INDEX_PATTERN: &str = "logs-*,filebeat-*,logstash-*";

/// A context's Elasticsearch endpoint (no secrets: those live in the OS keychain).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EsEndpoint {
    /// Where the API lives.
    pub target: EsTarget,
    /// Comma-separated index pattern.
    pub index_pattern: String,
    /// Field names of the shipper.
    #[serde(default)]
    pub preset: FieldPreset,
    /// Kibana base URL, when known.
    #[serde(default)]
    pub kibana_url: Option<String>,
    /// In-cluster Kibana service, opened through a port-forward when there
    /// is no Kibana URL (#505).
    #[serde(default)]
    pub kibana_service: Option<KibanaService>,
    /// Accept any certificate (opt-in, for self-signed endpoints without a CA).
    #[serde(default)]
    pub skip_tls_verify: bool,
}

/// A Kibana service in the cluster (from Detect).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KibanaService {
    /// Namespace.
    pub namespace: String,
    /// Service name.
    pub service: String,
    /// Service port (5601).
    pub port: u16,
    /// Whether it speaks HTTPS (ECK default).
    pub https: bool,
}

/// Credentials for an endpoint.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "method", rename_all = "kebab-case")]
pub enum EsAuth {
    /// No authentication (security disabled).
    #[default]
    None,
    /// Basic auth.
    Basic {
        /// User name.
        username: String,
        /// Password.
        password: String,
    },
    /// Elasticsearch API key (base64 `id:key`, as Kibana shows it).
    ApiKey {
        /// Encoded API key.
        key: String,
    },
    /// Bearer token.
    Bearer {
        /// Token.
        token: String,
    },
    /// ECK's built-in `elastic` user, read from the cluster at connect time
    /// (never stored, so rotations are picked up).
    EckUser,
}

impl std::fmt::Debug for EsAuth {
    // Never print secrets.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let method = match self {
            EsAuth::None => "none",
            EsAuth::Basic { .. } => "basic",
            EsAuth::ApiKey { .. } => "api-key",
            EsAuth::Bearer { .. } => "bearer",
            EsAuth::EckUser => "eck-user",
        };
        write!(f, "EsAuth({method})")
    }
}

impl EsAuth {
    /// `Authorization` header value, if any (`EckUser` is resolved to
    /// `Basic` before a connection is made).
    pub fn header(&self) -> Option<String> {
        use base64::Engine;
        match self {
            EsAuth::None | EsAuth::EckUser => None,
            EsAuth::Basic { username, password } => Some(format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
            )),
            EsAuth::ApiKey { key } => Some(format!("ApiKey {}", key.trim())),
            EsAuth::Bearer { token } => Some(format!("Bearer {}", token.trim())),
        }
    }
}

/// Errors of the Elasticsearch integration, with user-facing text.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ElasticError {
    /// The endpoint configuration is unusable.
    #[error("{0}")]
    Config(String),
    /// Could not reach the endpoint (port-forward, DNS, TLS, timeout).
    #[error("Cannot reach Elasticsearch: {0}")]
    Connect(String),
    /// Elasticsearch answered with an error status.
    #[error("Elasticsearch returned {status}: {reason}")]
    Http {
        /// HTTP status.
        status: u16,
        /// Server reason (`error.reason`) or a status explanation.
        reason: String,
    },
    /// The response was not what `_search` returns.
    #[error("Unexpected Elasticsearch response: {0}")]
    Response(String),
}

/// Characters Elasticsearch allows in index names and patterns (no `/`,
/// `\`, `?`, `"`, `<`, `>`, `|`, `#`, space), so the pattern is safe in a path.
pub fn validate_index_pattern(pattern: &str) -> Result<(), ElasticError> {
    let ok = !pattern.trim().is_empty()
        && pattern
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-*,:+".contains(c))
        && !pattern.starts_with(['_', '-', '+'])
        // `.`/`..` segments would be normalised away and escape the base path.
        && pattern.split(',').all(|seg| !matches!(seg.split(':').next_back(), Some("." | "..")));
    if ok {
        Ok(())
    } else {
        Err(ElasticError::Config(format!(
            "Invalid index pattern \"{pattern}\": use names and wildcards separated by commas"
        )))
    }
}

/// A page request for one pod's history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    /// Pod namespace.
    pub namespace: String,
    /// Pod name.
    pub pod: String,
    /// Container filter; `None` for every container.
    #[serde(default)]
    pub container: Option<String>,
    /// RFC 3339 or Elasticsearch date math (`now-1h`) lower bound.
    pub from: String,
    /// Upper bound (`now`).
    pub to: String,
    /// Free text, as a `simple_query_string` on the message field.
    #[serde(default)]
    pub text: Option<String>,
    /// `sort` values of the last hit of the previous page.
    #[serde(default)]
    pub search_after: Option<Vec<Value>>,
    /// Page size (default 500, capped at 1000).
    #[serde(default)]
    pub size: Option<u32>,
}

/// Default and maximum page size.
pub const DEFAULT_PAGE: u32 = 500;
/// Upper bound for one page.
pub const MAX_PAGE: u32 = 1000;

/// The `_search` body for a history page: filter on namespace, pod,
/// optional container and time range; newest first; `search_after` paging.
pub fn search_body(query: &HistoryQuery, preset: FieldPreset) -> Value {
    let f = preset.fields();
    let mut filter = vec![
        json!({ "term": { f.namespace: query.namespace } }),
        json!({ "term": { f.pod: query.pod } }),
        json!({ "range": { "@timestamp": { "gte": query.from, "lte": query.to } } }),
    ];
    if let Some(container) = query.container.as_deref().filter(|c| !c.is_empty()) {
        filter.push(json!({ "term": { f.container: container } }));
    }
    let mut must = Vec::new();
    if let Some(text) = query
        .text
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        must.push(json!({
            "simple_query_string": {
                "query": text,
                "fields": [f.message],
                "default_operator": "and"
            }
        }));
    }
    let size = query.size.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
    let mut body = json!({
        "size": size,
        "track_total_hits": 10_000,
        "query": { "bool": { "filter": filter, "must": must } },
        // `_index` + `_doc` break most ties for `search_after`; without a
        // point-in-time, hits with equal timestamps on different shards of one
        // index can still share sort values (rare; accepted in v1).
        // `unmapped_type` keeps indices without `@timestamp` from failing the search.
        "sort": [
            { "@timestamp": { "order": "desc", "unmapped_type": "date" } },
            { "_index": "asc" },
            { "_doc": "asc" }
        ],
    });
    if let Some(after) = &query.search_after {
        body["search_after"] = Value::Array(after.clone());
    }
    body
}

/// One history line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryLine {
    /// `@timestamp`.
    pub time: Option<String>,
    /// Level from `log.level` / `level`, else detected from the message.
    pub level: LogLevel,
    /// The message text (what Raw mode shows).
    pub message: String,
    /// Container, when the document names it.
    pub container: Option<String>,
    /// The stored `_source`, compact JSON (what JSON / ECS modes render).
    pub document: String,
}

/// One page of history, newest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    /// Lines, newest first.
    pub lines: Vec<HistoryLine>,
    /// Total hits, when Elasticsearch counted them.
    pub total: Option<u64>,
    /// `total` is a lower bound (more than 10 000 hits).
    pub total_is_lower_bound: bool,
    /// `search_after` for the next (older) page; `None` at the end.
    pub next: Option<Vec<Value>>,
}

/// Reads a dotted path from a document that may be nested
/// (`{"log":{"level":…}}`) or flat (`{"log.level":…}`).
fn field<'a>(doc: &'a Value, path: &str) -> Option<&'a Value> {
    if let Some(v) = doc.get(path) {
        return Some(v);
    }
    let (head, rest) = path.split_once('.')?;
    let child = doc.get(head)?;
    field(child, rest).or_else(|| {
        // `kubernetes.pod.name` may also be stored as `kubernetes` → `pod.name`.
        child.get(rest)
    })
}

fn string_field(doc: &Value, path: &str) -> Option<String> {
    match field(doc, path)? {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => items.first().and_then(|v| v.as_str()).map(str::to_owned),
        _ => None,
    }
}

fn map_level(raw: &str) -> Option<LogLevel> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "trace" | "debug" | "verbose" => Some(LogLevel::Debug),
        "info" | "information" | "notice" => Some(LogLevel::Info),
        "warn" | "warning" => Some(LogLevel::Warn),
        "error" | "err" | "fatal" | "critical" | "crit" | "alert" | "emerg" | "panic" => {
            Some(LogLevel::Error)
        }
        _ => None,
    }
}

/// Maps a `_search` response to a history page.
pub fn map_response(
    response: &Value,
    preset: FieldPreset,
    page_size: u32,
) -> Result<HistoryPage, ElasticError> {
    let f = preset.fields();
    let hits = response
        .get("hits")
        .and_then(|h| h.get("hits"))
        .and_then(Value::as_array)
        .ok_or_else(|| ElasticError::Response("no hits.hits array".to_string()))?;
    let lines = hits
        .iter()
        .map(|hit| {
            let source = hit
                .get("_source")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            let message = string_field(&source, f.message)
                .or_else(|| string_field(&source, "event.original"))
                .unwrap_or_else(|| source.to_string());
            let level = ["log.level", "level", "severity"]
                .iter()
                .find_map(|k| string_field(&source, k).and_then(|l| map_level(&l)))
                .unwrap_or_else(|| detect_level(&message));
            HistoryLine {
                time: string_field(&source, "@timestamp"),
                level,
                container: string_field(&source, f.container),
                message: message.trim_end_matches(['\n', '\r']).to_string(),
                document: source.to_string(),
            }
        })
        .collect::<Vec<_>>();
    let total = response.get("hits").and_then(|h| h.get("total"));
    let (total, lower) = match total {
        Some(Value::Number(n)) => (n.as_u64(), false),
        Some(obj) => (
            obj.get("value").and_then(Value::as_u64),
            obj.get("relation").and_then(Value::as_str) == Some("gte"),
        ),
        None => (None, false),
    };
    let next = if hits.len() as u32 >= page_size {
        hits.last()
            .and_then(|h| h.get("sort"))
            .and_then(Value::as_array)
            .cloned()
    } else {
        None
    };
    Ok(HistoryPage {
        lines,
        total,
        total_is_lower_bound: lower,
        next,
    })
}

/// The server's reason from an error body (`error.root_cause[0].reason`, `error.reason`, `error`).
pub fn error_reason(body: &str, status: u16) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let from_json = parsed.as_ref().and_then(|v| {
        let error = v.get("error")?;
        error
            .get("root_cause")
            .and_then(|r| r.get(0))
            .and_then(|r| r.get("reason"))
            .or_else(|| error.get("reason"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| error.as_str().map(str::to_owned))
    });
    from_json.unwrap_or_else(|| match status {
        401 => "authentication failed — check the credentials".to_string(),
        403 => "the user may not read these indices".to_string(),
        404 => "not found — check the index pattern".to_string(),
        _ => body.chars().take(200).collect(),
    })
}

/// Rison string literal (Kibana URL state): `'…'` with `!` → `!!`, `'` → `!'`.
fn rison(s: &str) -> String {
    format!("'{}'", s.replace('!', "!!").replace('\'', "!'"))
}

/// KQL string literal: `"…"` with `\` and `"` escaped.
fn kql(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Kibana Discover URL for one pod's logs over `[from, to]`.
pub fn kibana_discover_url(
    kibana_base: &str,
    preset: FieldPreset,
    namespace: &str,
    pod: &str,
    container: Option<&str>,
    from: &str,
    to: &str,
) -> String {
    let f = preset.fields();
    let mut query = format!(
        "{}:{} and {}:{}",
        f.namespace,
        kql(namespace),
        f.pod,
        kql(pod)
    );
    if let Some(c) = container.filter(|c| !c.is_empty()) {
        query.push_str(&format!(" and {}:{}", f.container, kql(c)));
    }
    let g = format!("(time:(from:{},to:{}))", rison(from), rison(to));
    let a = format!("(query:(language:kuery,query:{}))", rison(&query));
    format!(
        "{}/app/discover#/?_g={}&_a={}",
        kibana_base.trim_end_matches('/'),
        percent_encode(&g),
        percent_encode(&a)
    )
}

/// Percent-encodes everything outside the URL-safe unreserved set.
fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests;
