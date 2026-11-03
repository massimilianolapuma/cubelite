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
use crate::prometheus::{workload_pods_regex, Workload};

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
    /// The pod name as a keyword, for regexp queries on a workload's pods
    /// (#529): Fluent Bit's dynamic mapping makes the name `text` with a
    /// `.keyword` subfield.
    pub pod_keyword: &'static str,
    /// The `batch.kubernetes.io/job-name` pod label, when the shipper stores
    /// it under a predictable field (Filebeat / Elastic Agent dedot label
    /// keys); a Job's history also matches it.
    pub job_label: Option<&'static str>,
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
                pod_keyword: "kubernetes.pod.name",
                job_label: Some("kubernetes.labels.batch_kubernetes_io/job-name"),
                container: "kubernetes.container.name",
                message: "message",
            },
            FieldPreset::FluentBit => PresetFields {
                namespace: "kubernetes.namespace_name",
                pod: "kubernetes.pod_name",
                pod_keyword: "kubernetes.pod_name.keyword",
                job_label: None,
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

/// A Kibana service in the cluster (from Detect; port 5601, HTTPS by
/// default with ECK).
pub type KibanaService = crate::integration::ServiceRef;

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

/// A page request for the history of one pod, a workload's pods (#529) or
/// a whole namespace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    /// Pod namespace.
    pub namespace: String,
    /// Pod name; empty (with no `workload`) for every pod of the namespace.
    #[serde(default)]
    pub pod: String,
    /// The pods of a workload instead of `pod`: a regexp on the pod name
    /// (see [`pod_filter`]). Takes precedence over `pod`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workload: Option<Workload>,
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
    /// Where the previous page ended (its `next`); `None` for the first page.
    #[serde(default)]
    pub search_after: Option<HistoryCursor>,
    /// Page size (default 500, capped at 1000).
    #[serde(default)]
    pub size: Option<u32>,
}

/// Opaque paging cursor (#531): the `sort` values of the last hit and, when
/// the search runs on a point in time, its id. The frontends pass it back
/// untouched for the next (older) page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCursor {
    /// Point-in-time id; `None` when the server has no PIT (fallback to
    /// plain `search_after`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pit_id: Option<String>,
    /// `sort` values of the last hit.
    pub sort: Vec<Value>,
}

/// How long Elasticsearch keeps a history point in time between pages.
pub const PIT_KEEP_ALIVE: &str = "5m";

/// Default and maximum page size.
pub const DEFAULT_PAGE: u32 = 500;
/// Upper bound for one page.
pub const MAX_PAGE: u32 = 1000;

/// The `_search` body for a history page: filter on namespace, pod,
/// optional container and time range; newest first; `search_after` paging.
///
/// With a point in time (`pit`), the search names no index and `_shard_doc`
/// breaks every tie, so pages on one PIT neither skip nor repeat hits with
/// equal timestamps (#531). When an expired PIT is replaced, paging resumes
/// at the boundary millisecond, whose hits may repeat (never skip); the
/// frontends drop repeats by `_index` + `_id`. Without a PIT (servers
/// without one), `_index` + `_doc` break most ties; hits with equal
/// timestamps on different shards of one index can still share sort values
/// (rare).
pub fn search_body(query: &HistoryQuery, preset: FieldPreset, pit: Option<&str>) -> Value {
    let f = preset.fields();
    let mut filter = vec![json!({ "term": { f.namespace: query.namespace } })];
    filter.extend(pod_filter(query, preset));
    filter.push(json!({ "range": { "@timestamp": { "gte": query.from, "lte": query.to } } }));
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
    // `unmapped_type` keeps indices without `@timestamp` from failing the search.
    let timestamp = json!({ "@timestamp": { "order": "desc", "unmapped_type": "date" } });
    let sort = match pit {
        Some(_) => json!([timestamp, { "_shard_doc": "desc" }]),
        None => json!([timestamp, { "_index": "asc" }, { "_doc": "asc" }]),
    };
    let mut body = json!({
        "size": size,
        "track_total_hits": 10_000,
        "query": { "bool": { "filter": filter, "must": must } },
        "sort": sort,
    });
    if let Some(id) = pit {
        body["pit"] = json!({ "id": id, "keep_alive": PIT_KEEP_ALIVE });
    }
    if let Some(after) = &query.search_after {
        body["search_after"] = Value::Array(after.sort.clone());
    }
    body
}

/// The pod clause of a history search: a `term` on one pod, a `regexp` on
/// the keyword pod name for a workload's pods (the regexp Prometheus uses,
/// so `api` never matches `api-gateway-…`; Lucene regexps match the whole
/// term), or `None` for the whole namespace. A Job's pods also match its
/// `job-name` label when the preset stores it.
pub fn pod_filter(query: &HistoryQuery, preset: FieldPreset) -> Option<Value> {
    let f = preset.fields();
    let Some(workload) = &query.workload else {
        return (!query.pod.is_empty()).then(|| json!({ "term": { f.pod: query.pod } }));
    };
    let Some(pods) = workload_pods_regex(workload, lucene_regex_literal) else {
        return Some(json!({ "term": { f.pod: workload.name() } }));
    };
    let regexp = json!({ "regexp": { f.pod_keyword: { "value": pods } } });
    match (workload, f.job_label) {
        (Workload::Job { name }, Some(label)) => Some(json!({
            "bool": {
                "should": [regexp, { "term": { label: name } }],
                "minimum_should_match": 1
            }
        })),
        _ => Some(regexp),
    }
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
    /// Pod, when the document names it (a workload's or namespace's history
    /// spans several pods, #529).
    #[serde(default)]
    pub pod: Option<String>,
    /// The stored `_source`, compact JSON (what JSON / ECS modes render).
    pub document: String,
    /// `_index` of the hit (with `doc_id`, drops repeats between pages).
    #[serde(default)]
    pub doc_index: Option<String>,
    /// `_id` of the hit.
    #[serde(default)]
    pub doc_id: Option<String>,
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
    /// Cursor of the next (older) page; `None` at the end.
    pub next: Option<HistoryCursor>,
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

/// Maps a `_search` response to a history page. The cursor carries the
/// response's `pit_id` (Elasticsearch may update it between pages).
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
                pod: string_field(&source, f.pod),
                message: message.trim_end_matches(['\n', '\r']).to_string(),
                document: source.to_string(),
                doc_index: hit.get("_index").and_then(Value::as_str).map(str::to_owned),
                doc_id: hit.get("_id").and_then(Value::as_str).map(str::to_owned),
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
            .map(|sort| HistoryCursor {
                pit_id: response
                    .get("pit_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                sort: sort.clone(),
            })
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
    discover_link(kibana_base, "kuery", &query, from, to)
}

/// Escapes Lucene regexp operators (and `/`, the regexp delimiter in a
/// query string) so a name matches literally.
fn lucene_regex_literal(name: &str) -> String {
    name.chars()
        .flat_map(|c| {
            let meta = r#".?+*|{}[]()"\#@&<>~/"#.contains(c);
            meta.then_some('\\').into_iter().chain(std::iter::once(c))
        })
        .collect()
}

/// Escapes a field name for a Lucene query string (`/` and `-` in label
/// fields such as `batch_kubernetes_io/job-name`).
fn lucene_field(name: &str) -> String {
    name.chars()
        .flat_map(|c| {
            let plain = c.is_ascii_alphanumeric() || c == '.' || c == '_';
            (!plain)
                .then_some('\\')
                .into_iter()
                .chain(std::iter::once(c))
        })
        .collect()
}

/// Lucene query for a workload's pods in `namespace` (#526, #529): ECS has
/// no deployment field, so the pod name must match the regexp of
/// [`pod_filter`] (same alphabet and long-name cut as Prometheus), which
/// keeps `name-gateway-…` or `name-0` pods out. A Job also matches its
/// `job-name` label when the preset stores it. One pod is matched by name,
/// and `None` is the whole namespace.
pub fn workload_lucene_query(
    preset: FieldPreset,
    namespace: &str,
    workload: Option<&Workload>,
) -> String {
    let f = preset.fields();
    let mut query = format!("{}:{}", f.namespace, kql(namespace));
    let Some(workload) = workload else {
        return query;
    };
    let pods = match workload_pods_regex(workload, lucene_regex_literal) {
        Some(pods) => format!("{}:/{pods}/", f.pod_keyword),
        None => format!("{}:{}", f.pod, kql(workload.name())),
    };
    match (workload, f.job_label) {
        (Workload::Job { name }, Some(label)) => query.push_str(&format!(
            " AND ({pods} OR {}:{})",
            lucene_field(label),
            kql(name)
        )),
        _ => query.push_str(&format!(" AND {pods}")),
    }
    query
}

/// Kibana Discover URL for a workload's logs over `[from, to]`, the Lucene
/// query of [`workload_lucene_query`] (the same filter as the history).
pub fn kibana_workload_discover_url(
    kibana_base: &str,
    preset: FieldPreset,
    namespace: &str,
    workload: Option<&Workload>,
    from: &str,
    to: &str,
) -> String {
    let query = workload_lucene_query(preset, namespace, workload);
    discover_link(kibana_base, "lucene", &query, from, to)
}

/// Kibana Discover without a filter (command palette, #526).
pub fn kibana_discover_home(kibana_base: &str) -> String {
    format!("{}/app/discover#/", clean_base(kibana_base))
}

/// The Kibana base without its query, fragment or trailing slash.
fn clean_base(kibana_base: &str) -> &str {
    let base = kibana_base.trim();
    let end = base.find(['?', '#']).unwrap_or(base.len());
    base[..end].trim_end_matches('/')
}

/// Discover link showing `query` (`kuery` or `lucene`) over `[from, to]`.
fn discover_link(kibana_base: &str, language: &str, query: &str, from: &str, to: &str) -> String {
    let g = format!("(time:(from:{},to:{}))", rison(from), rison(to));
    let a = format!("(query:(language:{language},query:{}))", rison(query));
    format!(
        "{}/app/discover#/?_g={}&_a={}",
        clean_base(kibana_base),
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
