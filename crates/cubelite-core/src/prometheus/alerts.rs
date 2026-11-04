//! Firing alerts for the Overview (#530).
//!
//! `/api/v1/alerts` is preferred: it carries the annotations (summary) and
//! `activeAt`. Endpoints without it (Azure Monitor, some proxies) fall back
//! to the `ALERTS{alertstate="firing"}` series, which have the labels only.
//! When alerts fire, the alerting rules (`/api/v1/rules?type=alert`, best
//! effort) give each alert its expression for Open in Grafana; without them
//! the link explores the alert's own `ALERTS` series.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::transport::PromConnection;
use super::{escape, unwrap_data, PromEndpoint, PromError};

/// A firing alert.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    /// `alertname`.
    pub name: String,
    /// `severity` label (`critical`, `warning`, `info`, `none`, …).
    pub severity: Option<String>,
    /// Affected namespace.
    pub namespace: Option<String>,
    /// Affected pod (with `namespace`).
    pub pod: Option<String>,
    /// Affected node.
    pub node: Option<String>,
    /// `summary` annotation, else `description` / `message`.
    pub summary: Option<String>,
    /// Firing since (RFC 3339), when the source has it.
    pub active_at: Option<String>,
    /// PromQL for Open in Grafana.
    pub expr: String,
    /// Every label.
    pub labels: BTreeMap<String, String>,
}

/// Where the alerts came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlertSource {
    /// `/api/v1/alerts`.
    AlertsApi,
    /// The `ALERTS` series.
    AlertsMetric,
}

/// The Overview's alerts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertsResult {
    /// Firing alerts, most severe first.
    pub alerts: Vec<Alert>,
    /// Their source.
    pub source: AlertSource,
}

/// An alerting rule's name, extra labels and expression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertRule {
    /// Rule (alert) name.
    pub name: String,
    /// Labels the rule adds (`severity`, …).
    pub labels: BTreeMap<String, String>,
    /// Its PromQL.
    pub query: String,
}

fn strings(v: Option<&Value>) -> BTreeMap<String, String> {
    v.and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// `ALERTS{alertname="…", alertstate="firing"}`: the fallback expression.
pub fn alert_series_query(name: &str, cluster: Option<&str>) -> String {
    let mut sel = format!(r#"alertname={}, alertstate="firing""#, escape(name));
    if let Some(c) = cluster.map(str::trim).filter(|c| !c.is_empty()) {
        sel.push_str(&format!(", cluster={}", escape(c)));
    }
    format!("ALERTS{{{sel}}}")
}

/// Every firing alert's series (the fallback list).
pub fn alerts_metric_query(cluster: Option<&str>) -> String {
    let mut sel = r#"alertstate="firing""#.to_string();
    if let Some(c) = cluster.map(str::trim).filter(|c| !c.is_empty()) {
        sel.push_str(&format!(", cluster={}", escape(c)));
    }
    format!("ALERTS{{{sel}}}")
}

fn alert(
    labels: BTreeMap<String, String>,
    annotations: &BTreeMap<String, String>,
    active_at: Option<String>,
) -> Option<Alert> {
    let name = labels.get("alertname")?.clone();
    let label = |k: &str| labels.get(k).filter(|v| !v.is_empty()).cloned();
    let summary = ["summary", "description", "message"]
        .iter()
        .find_map(|k| annotations.get(*k).filter(|v| !v.trim().is_empty()))
        .map(|s| s.trim().to_string());
    Some(Alert {
        severity: label("severity"),
        namespace: label("namespace"),
        pod: label("pod"),
        node: label("node"),
        expr: String::new(),
        name,
        summary,
        active_at,
        labels,
    })
}

/// Firing alerts of an `/api/v1/alerts` `data` object (pending ones are
/// left out).
pub fn parse_alerts_api(data: &Value) -> Result<Vec<Alert>, PromError> {
    let items = data
        .get("alerts")
        .and_then(Value::as_array)
        .ok_or_else(|| PromError::Response("no data.alerts array".to_string()))?;
    Ok(items
        .iter()
        .filter(|a| a.get("state").and_then(Value::as_str) == Some("firing"))
        .filter_map(|a| {
            alert(
                strings(a.get("labels")),
                &strings(a.get("annotations")),
                a.get("activeAt").and_then(Value::as_str).map(str::to_owned),
            )
        })
        .collect())
}

/// Alerts of an `ALERTS{alertstate="firing"}` vector (`data`).
pub fn parse_alerts_metric(data: &Value) -> Result<Vec<Alert>, PromError> {
    let items = data
        .get("result")
        .and_then(Value::as_array)
        .ok_or_else(|| PromError::Response("no data.result array".to_string()))?;
    Ok(items
        .iter()
        .filter_map(|item| {
            let mut labels = strings(item.get("metric"));
            labels.remove("__name__");
            labels.remove("alertstate");
            alert(labels, &BTreeMap::new(), None)
        })
        .collect())
}

/// Alerting rules of an `/api/v1/rules` `data` object.
pub fn parse_alert_rules(data: &Value) -> Vec<AlertRule> {
    let groups = data.get("groups").and_then(Value::as_array);
    groups
        .into_iter()
        .flatten()
        .filter_map(|g| g.get("rules").and_then(Value::as_array))
        .flatten()
        .filter(|r| r.get("type").and_then(Value::as_str).unwrap_or("alerting") == "alerting")
        .filter_map(|r| {
            Some(AlertRule {
                name: r.get("name")?.as_str()?.to_string(),
                labels: strings(r.get("labels")),
                query: r.get("query")?.as_str()?.to_string(),
            })
        })
        .collect()
}

/// Gives each alert its rule's expression (same name, the rule's labels
/// on the alert), else its `ALERTS` series.
pub fn attach_exprs(alerts: &mut [Alert], rules: &[AlertRule], cluster: Option<&str>) {
    for alert in alerts {
        alert.expr = rules
            .iter()
            .find(|r| {
                r.name == alert.name && r.labels.iter().all(|(k, v)| alert.labels.get(k) == Some(v))
            })
            .map(|r| r.query.clone())
            .unwrap_or_else(|| alert_series_query(&alert.name, cluster));
    }
}

fn severity_rank(severity: Option<&str>) -> u8 {
    match severity.map(str::to_ascii_lowercase).as_deref() {
        Some("critical") | Some("page") => 0,
        Some("error") | Some("high") => 1,
        Some("warning") | Some("warn") => 2,
        Some("info") | Some("low") => 3,
        Some("none") => 5,
        _ => 4,
    }
}

/// Keeps the alerts of `cluster` (those without a `cluster` label too)
/// and sorts them: most severe first, then oldest first, then by name.
pub fn finish(mut alerts: Vec<Alert>, cluster: Option<&str>) -> Vec<Alert> {
    if let Some(c) = cluster.map(str::trim).filter(|c| !c.is_empty()) {
        alerts.retain(|a| a.labels.get("cluster").is_none_or(|v| v == c));
    }
    alerts.sort_by(|a, b| {
        severity_rank(a.severity.as_deref())
            .cmp(&severity_rank(b.severity.as_deref()))
            .then_with(|| match (&a.active_at, &b.active_at) {
                (Some(x), Some(y)) => x.cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.labels.cmp(&b.labels))
    });
    alerts
}

/// The alerts endpoint is missing or not supported here (not a reachability
/// or credentials problem): try the `ALERTS` series.
fn unsupported(e: &PromError) -> bool {
    match e {
        PromError::Http { status, .. } => !matches!(status, 401 | 403),
        PromError::Response(_) => true,
        PromError::Connect(_) | PromError::Config(_) => false,
    }
}

impl PromConnection {
    /// Firing alerts (see the module docs).
    pub async fn alerts(&self, endpoint: &PromEndpoint) -> Result<AlertsResult, PromError> {
        let cluster = endpoint.cluster.as_deref();
        let api = match self.get("/api/v1/alerts").await.and_then(unwrap_data) {
            Ok(data) => parse_alerts_api(&data),
            Err(e) => Err(e),
        };
        let (mut alerts, source) = match api {
            Ok(alerts) => (alerts, AlertSource::AlertsApi),
            Err(e) if unsupported(&e) => {
                let data = self.query(&alerts_metric_query(cluster)).await?;
                (parse_alerts_metric(&data)?, AlertSource::AlertsMetric)
            }
            Err(e) => return Err(e),
        };
        let rules = if alerts.is_empty() {
            Vec::new()
        } else {
            self.get("/api/v1/rules?type=alert&exclude_alerts=true")
                .await
                .and_then(unwrap_data)
                .map(|data| parse_alert_rules(&data))
                .unwrap_or_default()
        };
        attach_exprs(&mut alerts, &rules, cluster);
        Ok(AlertsResult {
            alerts: finish(alerts, cluster),
            source,
        })
    }
}

#[cfg(test)]
mod tests;
