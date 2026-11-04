use super::*;
use crate::prometheus::transport::connect;
use crate::prometheus::{PromAuth, PromTarget};
use crate::test_support::mock_server;
use serde_json::json;

fn alerts_body() -> serde_json::Value {
    json!({ "alerts": [
        {
            "labels": { "alertname": "Watchdog", "severity": "none" },
            "annotations": { "description": "This is an alert meant to ensure that the entire alerting pipeline is functional." },
            "state": "firing",
            "activeAt": "2026-11-03T19:29:26.774Z",
            "value": "1e+00"
        },
        {
            "labels": {
                "alertname": "KubePodCrashLooping", "severity": "warning",
                "namespace": "shop", "pod": "api-7d9c8b6f5-x2k4p", "container": "api"
            },
            "annotations": { "summary": "Pod is crash looping.", "description": "Pod shop/api is in waiting state." },
            "state": "firing",
            "activeAt": "2026-11-04T08:00:00Z"
        },
        {
            "labels": { "alertname": "KubeNodeNotReady", "severity": "warning", "node": "minikube" },
            "annotations": {},
            "state": "pending",
            "activeAt": "2026-11-04T09:00:00Z"
        },
        { "labels": {}, "annotations": {}, "state": "firing" }
    ] })
}

#[test]
fn alerts_api_keeps_firing_alerts_with_their_summary() {
    let alerts = parse_alerts_api(&alerts_body()).expect("alerts");
    assert_eq!(alerts.len(), 2, "pending and nameless alerts are left out");
    let watchdog = &alerts[0];
    assert_eq!(watchdog.name, "Watchdog");
    assert_eq!(watchdog.severity.as_deref(), Some("none"));
    assert!(watchdog
        .summary
        .as_deref()
        .is_some_and(|s| s.starts_with("This is an alert")));
    assert_eq!(
        watchdog.active_at.as_deref(),
        Some("2026-11-03T19:29:26.774Z")
    );
    let crash = &alerts[1];
    assert_eq!(crash.summary.as_deref(), Some("Pod is crash looping."));
    assert_eq!(crash.namespace.as_deref(), Some("shop"));
    assert_eq!(crash.pod.as_deref(), Some("api-7d9c8b6f5-x2k4p"));
    assert_eq!(crash.node, None);
    assert_eq!(crash.labels["container"], "api");
    assert!(parse_alerts_api(&json!({})).is_err());
}

#[test]
fn alerts_series_have_labels_only() {
    let data = json!({ "resultType": "vector", "result": [
        { "metric": { "__name__": "ALERTS", "alertname": "KubeNodeNotReady", "alertstate": "firing",
                      "severity": "warning", "node": "minikube" }, "value": [1.0, "1"] }
    ] });
    let alerts = parse_alerts_metric(&data).expect("alerts");
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0].node.as_deref(), Some("minikube"));
    assert_eq!(alerts[0].summary, None);
    assert_eq!(alerts[0].active_at, None);
    assert!(!alerts[0].labels.contains_key("__name__"));
    assert!(!alerts[0].labels.contains_key("alertstate"));
    assert_eq!(
        alerts_metric_query(Some("eu")),
        r#"ALERTS{alertstate="firing", cluster="eu"}"#
    );
    assert_eq!(alerts_metric_query(None), r#"ALERTS{alertstate="firing"}"#);
}

#[test]
fn rules_give_alerts_their_expression() {
    let rules = parse_alert_rules(&json!({ "groups": [
        { "name": "general", "rules": [
            { "type": "alerting", "name": "Watchdog", "query": "vector(1)", "labels": { "severity": "none" } },
            { "type": "recording", "name": "node:cpu", "query": "sum(x)" }
        ] },
        { "name": "pods", "rules": [
            { "type": "alerting", "name": "KubePodCrashLooping", "query": "crash_critical > 0", "labels": { "severity": "critical" } },
            { "type": "alerting", "name": "KubePodCrashLooping", "query": "crash_warning > 0", "labels": { "severity": "warning" } }
        ] }
    ] }));
    assert_eq!(rules.len(), 3, "recording rules are left out");
    let mut alerts = parse_alerts_api(&alerts_body()).expect("alerts");
    alerts.push(Alert {
        name: "Unknown\"Rule".into(),
        severity: None,
        namespace: None,
        pod: None,
        node: None,
        summary: None,
        active_at: None,
        expr: String::new(),
        labels: BTreeMap::new(),
    });
    attach_exprs(&mut alerts, &rules, Some("eu"));
    assert_eq!(alerts[0].expr, "vector(1)");
    // Same name, the rule whose labels the alert carries.
    assert_eq!(alerts[1].expr, "crash_warning > 0");
    assert_eq!(
        alerts[2].expr,
        r#"ALERTS{alertname="Unknown\"Rule", alertstate="firing", cluster="eu"}"#
    );
}

fn named(
    name: &str,
    severity: Option<&str>,
    active_at: Option<&str>,
    cluster: Option<&str>,
) -> Alert {
    let mut labels = BTreeMap::from([("alertname".to_string(), name.to_string())]);
    if let Some(c) = cluster {
        labels.insert("cluster".into(), c.into());
    }
    Alert {
        name: name.into(),
        severity: severity.map(str::to_owned),
        namespace: None,
        pod: None,
        node: None,
        summary: None,
        active_at: active_at.map(str::to_owned),
        expr: String::new(),
        labels,
    }
}

#[test]
fn alerts_sort_by_severity_then_age_and_keep_their_cluster() {
    let sorted = finish(
        vec![
            named("Watchdog", Some("none"), Some("2026-01-01T00:00:00Z"), None),
            named("B", Some("warning"), Some("2026-11-04T00:00:00Z"), None),
            named("A", Some("warning"), Some("2026-11-03T00:00:00Z"), None),
            named("Crit", Some("critical"), None, Some("eu")),
            named("Other", Some("critical"), None, Some("us")),
            named("Plain", None, None, None),
        ],
        Some("eu"),
    );
    let names: Vec<&str> = sorted.iter().map(|a| a.name.as_str()).collect();
    assert_eq!(names, ["Crit", "A", "B", "Plain", "Watchdog"]);
    assert_eq!(
        finish(vec![named("Other", None, None, Some("us"))], None).len(),
        1
    );
}

fn endpoint(url: &str) -> PromEndpoint {
    PromEndpoint {
        target: PromTarget::External { url: url.into() },
        cluster: None,
        grafana_url: None,
        grafana_datasource: None,
        grafana_service: None,
        skip_tls_verify: false,
    }
}

fn success(data: serde_json::Value) -> (u16, String) {
    (
        200,
        json!({ "status": "success", "data": data }).to_string(),
    )
}

#[tokio::test]
async fn alerts_come_from_the_alerts_api_with_rule_expressions() {
    let (url, server) = mock_server(vec![
        success(alerts_body()),
        success(json!({ "groups": [{ "rules": [
            { "type": "alerting", "name": "Watchdog", "query": "vector(1)", "labels": {} }
        ] }] })),
    ])
    .await;
    let ep = endpoint(&url);
    let conn = connect(None, &ep, &PromAuth::None).await.expect("connect");
    let result = conn.alerts(&ep).await.expect("alerts");
    assert_eq!(result.source, AlertSource::AlertsApi);
    let names: Vec<&str> = result.alerts.iter().map(|a| a.name.as_str()).collect();
    assert_eq!(names, ["KubePodCrashLooping", "Watchdog"]);
    assert_eq!(result.alerts[1].expr, "vector(1)");
    assert!(result.alerts[0]
        .expr
        .starts_with("ALERTS{alertname=\"KubePodCrashLooping\""));
    let requests = server.await.expect("server");
    assert!(requests[0].starts_with("GET /api/v1/alerts "));
    assert!(requests[1].starts_with("GET /api/v1/rules?type=alert"));
}

#[tokio::test]
async fn alerts_fall_back_to_the_alerts_series() {
    let (url, server) = mock_server(vec![
        (404, "404 page not found".into()),
        success(json!({ "resultType": "vector", "result": [
            { "metric": { "alertname": "Watchdog", "alertstate": "firing", "severity": "none" }, "value": [1.0, "1"] }
        ] })),
        (404, "404 page not found".into()),
    ])
    .await;
    let ep = endpoint(&url);
    let conn = connect(None, &ep, &PromAuth::None).await.expect("connect");
    let result = conn.alerts(&ep).await.expect("alerts");
    assert_eq!(result.source, AlertSource::AlertsMetric);
    assert_eq!(result.alerts.len(), 1);
    assert_eq!(
        result.alerts[0].expr,
        r#"ALERTS{alertname="Watchdog", alertstate="firing"}"#
    );
    let requests = server.await.expect("server");
    assert!(requests[1].contains("query=ALERTS"));
}

#[tokio::test]
async fn rejected_credentials_are_not_a_missing_api() {
    let (url, server) = mock_server(vec![(401, "{}".into())]).await;
    let ep = endpoint(&url);
    let conn = connect(None, &ep, &PromAuth::None).await.expect("connect");
    let err = conn.alerts(&ep).await.expect_err("unauthorized");
    assert!(matches!(err, PromError::Http { status: 401, .. }), "{err}");
    assert_eq!(server.await.expect("server").len(), 1);
}
