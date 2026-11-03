use std::time::{Duration, UNIX_EPOCH};

use super::azure::{cli_error, is_azure_monitor_url, parse_token};
use super::transport::{classify, connect, proxy_base};
use super::*;
use crate::test_support::mock_server;
use k8s_openapi::api::core::v1::Service;
use serde_json::json;

fn pod(name: &str) -> Workload {
    Workload::Pod { name: name.into() }
}

#[test]
fn selectors_match_pods_deployments_and_statefulsets_literally() {
    assert_eq!(
        selector("shop", &pod("api-0"), None),
        r#"namespace="shop", pod="api-0""#
    );
    assert_eq!(
        selector(
            "shop",
            &Workload::Deployment {
                name: "api.v2".into()
            },
            Some(" aks-prod ")
        ),
        r#"namespace="shop", pod=~"api\\.v2-[bcdfghjklmnpqrstvwxz2456789]{6,10}-[bcdfghjklmnpqrstvwxz2456789]{5}", cluster="aks-prod""#
    );
    assert_eq!(
        selector(
            "shop",
            &Workload::StatefulSet { name: "db".into() },
            Some("")
        ),
        r#"namespace="shop", pod=~"db-[0-9]+""#
    );
    assert_eq!(escape("a\"b\\c\nd"), r#""a\"b\\c\nd""#);
}

#[test]
fn deployment_regex_matches_its_pods_only() {
    let sel = |name: &str| selector("ns", &Workload::Deployment { name: name.into() }, None);
    let regex_of = |s: String| {
        let start = s.find("pod=~\"").expect("regex") + 6;
        let end = s[start..].find('"').expect("end") + start;
        s[start..end].replace("\\\\", "\\")
    };
    let matches = |name: &str, pod: &str| {
        let re = regex::Regex::new(&format!("^(?:{})$", regex_of(sel(name)))).expect("regex");
        re.is_match(pod)
    };
    assert!(matches("api", "api-7c9f8b6d54-x2kzq"));
    assert!(!matches("api", "api-28345678-ab0cd"), "CronJob pod");
    assert!(!matches("api", "api-gateway-7c9f8b6d54-x2kzq"));
    let long = "a".repeat(50);
    let truncated = format!("{}-7c9f8b6", long);
    let pod = format!("{}{}", &truncated[..58], "x2kzq");
    assert!(matches(&long, &pod), "generateName cut at 58 characters");
}

#[test]
fn chart_queries_group_by_container_or_sum() {
    let sel = r#"namespace="shop", pod="api-0""#;
    assert_eq!(
        chart_query(Chart::Cpu, sel, true, 60),
        r#"sum by (container) (rate(container_cpu_usage_seconds_total{namespace="shop", pod="api-0", container!="", container!="POD"}[60s]))"#
    );
    assert_eq!(
        chart_query(Chart::MemoryLimit, sel, false, 60),
        r#"sum(kube_pod_container_resource_limits{namespace="shop", pod="api-0", resource="memory"})"#
    );
    assert_eq!(
        chart_query(Chart::Restarts, sel, true, 360),
        r#"sum by (container) (kube_pod_container_status_restarts_total{namespace="shop", pod="api-0"})"#,
        "cumulative: summing windowed increases would count each restart several times"
    );
    assert_eq!(
        chart_query(Chart::NetworkTx, sel, true, 60),
        r#"sum(rate(container_network_transmit_bytes_total{namespace="shop", pod="api-0"}[60s]))"#,
        "network is pod level"
    );
    let request = MetricsRequest {
        namespace: "shop".into(),
        workload: pod("api-0"),
        range: MetricsRange::Day,
        per_container: false,
    };
    let queries = metrics_queries(&request, None);
    assert_eq!(
        queries.iter().map(|(c, _)| *c).collect::<Vec<_>>(),
        Chart::ALL
    );
    assert!(queries[0].1.contains("[1440s]"));
    let total = &queries
        .iter()
        .find(|(c, _)| *c == Chart::RestartsTotal)
        .expect("total")
        .1;
    assert_eq!(
        total,
        r#"sum(increase(kube_pod_container_status_restarts_total{namespace="shop", pod="api-0"}[86400s]))"#,
        "per pod and container over the whole range, then summed"
    );
}

#[test]
fn steps_and_windows_follow_the_range() {
    let table: Vec<_> = [
        MetricsRange::Hour,
        MetricsRange::SixHours,
        MetricsRange::Day,
        MetricsRange::Week,
    ]
    .iter()
    .map(|r| (r.step(), r.window(), r.grafana_from()))
    .collect();
    assert_eq!(
        table,
        [
            (15, 60, "now-1h"),
            (90, 360, "now-6h"),
            (360, 1440, "now-24h"),
            (2520, 10080, "now-7d")
        ]
    );
    assert_eq!(
        serde_json::to_value(MetricsRange::Week).expect("json"),
        "7d"
    );
}

#[test]
fn series_parse_matrix_vector_and_non_finite_values() {
    let data = json!({ "resultType": "matrix", "result": [
        { "metric": { "container": "web" }, "values": [[1.0, "0.5"], [16.0, "NaN"], [31.0, "+Inf"]] },
        { "metric": { "container": "app" }, "values": [[1.0, "2"]] }
    ] });
    let series = parse_series(&data, &["container"]).expect("series");
    assert_eq!(series[0].label, "app", "sorted by label");
    assert_eq!(
        series[1].points,
        vec![(1.0, Some(0.5)), (16.0, None), (31.0, None)]
    );
    let vector =
        json!({ "resultType": "vector", "result": [{ "metric": {}, "value": [5.0, "1"] }] });
    let summed = parse_series(&vector, &[]).expect("vector");
    assert_eq!(summed[0].label, "");
    assert_eq!(summed[0].points, vec![(5.0, Some(1.0))]);
    assert!(parse_series(&json!({}), &[]).is_err());
    assert!(parse_series(&json!({ "result": [] }), &[])
        .expect("empty")
        .is_empty());
}

#[test]
fn sparklines_cover_one_or_every_namespace() {
    let (cpu, memory) = sparkline_queries(Some("shop"), Some("aks"));
    assert_eq!(
        cpu,
        r#"sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{namespace="shop", container!="", container!="POD", cluster="aks"}[5m]))"#
    );
    assert!(memory.starts_with("sum by (namespace, pod) (container_memory_working_set_bytes{"));
    let (all, _) = sparkline_queries(None, None);
    assert!(!all.contains("namespace="));
    let data = json!({ "result": [{ "metric": { "namespace": "shop", "pod": "api-0" }, "values": [[1.0, "1"]] }] });
    assert_eq!(
        parse_series(&data, &["namespace", "pod"]).expect("series")[0].label,
        "shop/api-0"
    );
}

#[test]
fn api_errors_carry_the_server_reason() {
    let err = unwrap_data(
        json!({ "status": "error", "errorType": "bad_data", "error": "parse error at char 5" }),
    )
    .expect_err("error");
    assert_eq!(
        err,
        PromError::Http {
            status: 400,
            reason: "parse error at char 5".into()
        }
    );
    assert_eq!(
        unwrap_data(json!({ "status": "success", "data": { "result": [] } })).expect("data"),
        json!({ "result": [] })
    );
    assert_eq!(
        error_reason(r#"{"status":"error","error":"bad"}"#, 422),
        "bad"
    );
    assert!(error_reason("", 401).starts_with("authentication failed"));
}

#[test]
fn auth_tags_headers_and_debug_hide_secrets() {
    let basic = PromAuth::Basic {
        username: "123".into(),
        password: "glc_x".into(),
    };
    assert_eq!(basic.header().as_deref(), Some("Basic MTIzOmdsY194"));
    assert_eq!(
        PromAuth::Bearer {
            token: " t ".into()
        }
        .header()
        .as_deref(),
        Some("Bearer t")
    );
    assert_eq!(PromAuth::AzureCli.header(), None);
    assert_eq!(format!("{basic:?}"), "PromAuth(basic)");
    for auth in [
        PromAuth::None,
        basic,
        PromAuth::Bearer { token: "t".into() },
        PromAuth::AzureCli,
    ] {
        let v = serde_json::to_value(&auth).expect("json");
        assert_eq!(v["method"], auth.method());
    }
    let endpoint: PromEndpoint = serde_json::from_value(json!({
        "target": { "kind": "external", "url": "https://x.westeurope.prometheus.monitor.azure.com" }
    }))
    .expect("endpoint");
    assert_eq!(endpoint.cluster, None);
    assert!(!endpoint.skip_tls_verify);
}

#[test]
fn grafana_explore_url_encodes_panes() {
    let url = grafana_explore_url(
        "https://grafana.example/",
        Some("prom-uid"),
        &["sum(a)".to_string(), "sum(b)".to_string()],
        "now-6h",
        "now",
    );
    assert!(url.starts_with("https://grafana.example/explore?schemaVersion=1&panes="));
    let encoded = url.split("panes=").nth(1).expect("panes");
    let decoded: String = url::form_urlencoded::parse(format!("p={encoded}").as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .expect("decoded");
    let panes: serde_json::Value = serde_json::from_str(&decoded).expect("json");
    assert_eq!(panes["a"]["datasource"], "prom-uid");
    assert_eq!(
        panes["a"]["range"],
        json!({ "from": "now-6h", "to": "now" })
    );
    assert_eq!(panes["a"]["queries"][1]["refId"], "B");
    assert_eq!(panes["a"]["queries"][1]["expr"], "sum(b)");
    let default_ds = grafana_explore_url("http://g", None, &["x".to_string()], "now-1h", "now");
    assert!(!default_ds.contains("datasource"));
}

#[test]
fn azure_tokens_parse_and_only_go_to_azure_monitor() {
    let now = UNIX_EPOCH + Duration::from_secs(1_000);
    let (token, expires) =
        parse_token(r#"{"accessToken":"eyJ","expires_on":1730000000}"#, now).expect("token");
    assert_eq!(token, "eyJ");
    assert_eq!(expires, UNIX_EPOCH + Duration::from_secs(1_730_000_000));
    let (_, fallback) = parse_token(
        r#"{"accessToken":"eyJ","expiresOn":"2026-11-03 16:00:00.000000"}"#,
        now,
    )
    .expect("old cli");
    assert_eq!(fallback, now + Duration::from_secs(600));
    assert!(parse_token(r#"{"accessToken":""}"#, now).is_err());
    assert!(cli_error("ERROR: Please run 'az login' to setup account.")
        .to_string()
        .contains("az login"));
    let ok =
        url::Url::parse("https://ws-ab12.westeurope.prometheus.monitor.azure.com").expect("url");
    assert!(is_azure_monitor_url(&ok));
    for bad in [
        "http://ws.westeurope.prometheus.monitor.azure.com",
        "https://prometheus.monitor.azure.com.evil.example",
        "https://grafana.net",
    ] {
        assert!(
            !is_azure_monitor_url(&url::Url::parse(bad).expect("url")),
            "{bad}"
        );
    }
}

fn service(v: serde_json::Value) -> Service {
    serde_json::from_value(v).expect("service")
}

#[test]
fn classify_finds_prometheus_servers_only() {
    let operated = service(json!({
        "metadata": { "name": "prometheus-operated", "namespace": "monitoring", "labels": { "operated-prometheus": "true" } },
        "spec": { "ports": [{ "name": "http-web", "port": 9090 }] }
    }));
    let found = classify(&operated).expect("operated");
    assert_eq!(
        (found.namespace.as_str(), found.port, found.https),
        ("monitoring", 9090, false)
    );
    let chart = service(json!({
        "metadata": { "name": "kps-prometheus", "labels": { "app": "kube-prometheus-stack-prometheus" } },
        "spec": { "ports": [{ "name": "http-web", "port": 9090 }, { "name": "reloader-web", "port": 8080 }] }
    }));
    assert_eq!(classify(&chart).expect("chart").port, 9090);
    for other in [
        "kps-alertmanager",
        "kps-prometheus-node-exporter",
        "kps-operator",
        "web",
    ] {
        let s = service(json!({
            "metadata": { "name": other, "labels": { "app.kubernetes.io/name": "prometheus" } },
            "spec": { "ports": [{ "port": 9090 }] }
        }));
        let classified = classify(&s);
        if other == "web" {
            assert!(classified.is_some(), "labelled prometheus counts");
        } else {
            assert!(classified.is_none(), "{other}");
        }
    }
    assert_eq!(
        proxy_base("monitoring", "prometheus-operated", 9090, false),
        "/api/v1/namespaces/monitoring/services/http:prometheus-operated:9090/proxy"
    );
}

fn external(url: &str) -> PromEndpoint {
    PromEndpoint {
        target: PromTarget::External { url: url.into() },
        cluster: Some("aks-prod".into()),
        grafana_url: None,
        grafana_datasource: None,
        skip_tls_verify: false,
    }
}

#[tokio::test]
async fn metrics_query_every_chart_and_keep_partial_failures() {
    let matrix = json!({ "status": "success", "data": { "resultType": "matrix", "result": [
        { "metric": { "container": "web" }, "values": [[1.0, "0.25"]] }
    ] } })
    .to_string();
    let mut responses = vec![(200, matrix); Chart::ALL.len()];
    // One chart fails (kube-state-metrics missing behind a strict proxy).
    responses[1] = (
        422,
        r#"{"status":"error","errorType":"execution","error":"boom"}"#.into(),
    );
    let (url, server) = mock_server(responses).await;
    let endpoint = external(&url);
    let conn = connect(None, &endpoint, &PromAuth::None)
        .await
        .expect("connect");
    let result = conn
        .metrics(
            &endpoint,
            &MetricsRequest {
                namespace: "shop".into(),
                workload: pod("api-0"),
                range: MetricsRange::Hour,
                per_container: true,
            },
        )
        .await
        .expect("metrics");
    assert_eq!(result.step, 15);
    assert_eq!(result.end - result.start, 3_600);
    assert_eq!(result.charts.len(), Chart::ALL.len());
    assert_eq!(
        result.charts.iter().filter(|c| c.error.is_some()).count(),
        1
    );
    let ok = result
        .charts
        .iter()
        .find(|c| c.error.is_none() && c.chart == Chart::Memory)
        .expect("memory");
    assert_eq!(ok.series[0].label, "web");
    let requests = server.await.expect("server");
    assert!(requests
        .iter()
        .all(|r| r.starts_with("GET /api/v1/query_range?query=")));
    assert!(requests
        .iter()
        .any(|r| r.contains("cluster%3D%22aks-prod%22")));
}

#[tokio::test]
async fn connect_enforces_credential_rules() {
    let bearer = PromAuth::Bearer { token: "t".into() };
    assert!(matches!(
        connect(None, &external("http://prom.example"), &bearer).await,
        Err(PromError::Config(_))
    ));
    let err = connect(None, &external("https://prom.example"), &PromAuth::AzureCli)
        .await
        .expect_err("azure only to azure");
    assert!(err.to_string().contains("prometheus.monitor.azure.com"));
    let mut in_cluster = external("http://x");
    in_cluster.target = PromTarget::InCluster {
        namespace: "monitoring".into(),
        service: "prometheus-operated".into(),
        port: 9090,
        https: false,
    };
    assert!(matches!(
        connect(None, &in_cluster, &bearer).await,
        Err(PromError::Config(_))
    ));
    assert!(matches!(
        connect(None, &in_cluster, &PromAuth::None).await,
        Err(PromError::Config(_))
    ));
}

#[tokio::test]
async fn info_reports_exporters_and_clusters() {
    let ok = |result: serde_json::Value| {
        (
            200,
            json!({ "status": "success", "data": { "resultType": "vector", "result": result } })
                .to_string(),
        )
    };
    let (url, server) = mock_server(vec![
        ok(json!([{ "metric": {}, "value": [1.0, "1"] }])),
        (
            200,
            json!({ "status": "success", "data": { "version": "2.54.1" } }).to_string(),
        ),
        ok(json!([{ "metric": {}, "value": [1.0, "42"] }])),
        ok(json!([])),
        ok(json!([
            { "metric": { "cluster": "aks-prod" }, "value": [1.0, "3"] },
            { "metric": { "cluster": "aks-test" }, "value": [1.0, "3"] }
        ])),
    ])
    .await;
    let endpoint = external(&url);
    let conn = connect(None, &endpoint, &PromAuth::None)
        .await
        .expect("connect");
    let info = conn.info(&endpoint).await.expect("info");
    assert_eq!(info.version, "2.54.1");
    assert!(info.cadvisor);
    assert!(!info.kube_state_metrics);
    assert_eq!(info.clusters, ["aks-prod", "aks-test"]);
    server.await.expect("server");
}

/// A kube client whose API server answers every request with `reply`.
fn api_server(status: u16, reply: serde_json::Value) -> kube::Client {
    use http::{Request, Response};
    use kube::client::Body;
    let (service, handle) = tower_test::mock::pair::<Request<Body>, Response<Body>>();
    tokio::spawn(async move {
        let mut handle = std::pin::pin!(handle);
        while let Some((_request, send)) = handle.next_request().await {
            let response = Response::builder()
                .status(status)
                .body(Body::from(reply.to_string().into_bytes()))
                .expect("response");
            send.send_response(response);
        }
    });
    kube::Client::new(service, "default")
}

fn in_cluster() -> PromEndpoint {
    let mut endpoint = external("http://unused");
    endpoint.target = PromTarget::InCluster {
        namespace: "monitoring".into(),
        service: "prometheus-operated".into(),
        port: 9090,
        https: false,
    };
    endpoint
}

#[tokio::test]
async fn proxy_tells_the_api_server_from_prometheus() {
    // Prometheus itself answered (even with an error): use the proxy.
    let prom = api_server(
        200,
        json!({ "status": "success", "data": { "version": "2.54.1" } }),
    );
    assert!(connect(Some(prom), &in_cluster(), &PromAuth::None)
        .await
        .is_ok());
    // The API server says the service does not exist: a config error, not
    // "check the URL".
    let missing = api_server(
        404,
        json!({ "kind": "Status", "code": 404, "message": "services \"prometheus-operated\" not found" }),
    );
    let err = connect(Some(missing), &in_cluster(), &PromAuth::None)
        .await
        .expect_err("missing service");
    assert!(
        matches!(&err, PromError::Config(t) if t.contains("not found")),
        "{err}"
    );
    // Forbidden proxy: falls back to a port-forward, which needs the
    // service (forbidden too here) — the error is the tunnel's, not the proxy's.
    let forbidden = api_server(
        403,
        json!({ "kind": "Status", "code": 403, "message": "services \"prometheus-operated\" is forbidden" }),
    );
    let err = connect(Some(forbidden), &in_cluster(), &PromAuth::None)
        .await
        .expect_err("no tunnel either");
    assert!(matches!(err, PromError::Connect(_)), "{err}");
    let mut bad = in_cluster();
    bad.target = PromTarget::InCluster {
        namespace: "../x".into(),
        service: "s".into(),
        port: 9090,
        https: false,
    };
    assert!(matches!(
        connect(Some(api_server(200, json!({}))), &bad, &PromAuth::None).await,
        Err(PromError::Config(_))
    ));
}
