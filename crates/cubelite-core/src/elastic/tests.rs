use super::transport::{classify, connect, ready_pod, service_host, target_port};
use super::*;
use k8s_openapi::api::core::v1::{Pod, Service};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn query() -> HistoryQuery {
    HistoryQuery {
        namespace: "shop".into(),
        pod: "api-0".into(),
        container: None,
        from: "now-1h".into(),
        to: "now".into(),
        text: None,
        search_after: None,
        size: None,
    }
}

#[test]
fn search_body_filters_pod_namespace_and_time_newest_first() {
    let body = search_body(&query(), FieldPreset::Ecs);
    assert_eq!(body["size"], 500);
    let filter = body["query"]["bool"]["filter"].as_array().expect("filter");
    assert!(filter.contains(&json!({ "term": { "kubernetes.namespace": "shop" } })));
    assert!(filter.contains(&json!({ "term": { "kubernetes.pod.name": "api-0" } })));
    assert!(
        filter.contains(&json!({ "range": { "@timestamp": { "gte": "now-1h", "lte": "now" } } }))
    );
    assert_eq!(
        body["sort"][0],
        json!({ "@timestamp": { "order": "desc" } })
    );
    assert!(body.get("search_after").is_none());
    assert_eq!(body["query"]["bool"]["must"], json!([]));
}

#[test]
fn search_body_adds_container_text_paging_and_caps_size() {
    let mut q = query();
    q.container = Some("worker".into());
    q.text = Some("  timeout \"db\"  ".into());
    q.search_after = Some(vec![json!(1_730_000_000_000_u64), json!(42)]);
    q.size = Some(5000);
    let body = search_body(&q, FieldPreset::FluentBit);
    let filter = body["query"]["bool"]["filter"].as_array().expect("filter");
    assert!(filter.contains(&json!({ "term": { "kubernetes.container_name": "worker" } })));
    assert!(filter.contains(&json!({ "term": { "kubernetes.pod_name": "api-0" } })));
    let text = &body["query"]["bool"]["must"][0]["simple_query_string"];
    assert_eq!(text["query"], "timeout \"db\"");
    assert_eq!(text["fields"], json!(["log"]));
    assert_eq!(body["search_after"], json!([1_730_000_000_000_u64, 42]));
    assert_eq!(body["size"], MAX_PAGE);
}

#[test]
fn map_response_reads_ecs_fluent_bit_and_flat_documents() {
    let response = json!({
        "hits": {
            "total": { "value": 10000, "relation": "gte" },
            "hits": [
                { "_source": { "@timestamp": "2026-11-03T08:00:00Z", "log": { "level": "WARN" },
                    "message": "disk almost full\n", "kubernetes": { "container": { "name": "web" } } },
                  "sort": [3, 1] },
                { "_source": { "@timestamp": "2026-11-03T07:59:00Z", "log.level": "error",
                    "message": "boom", "kubernetes.container.name": "web" }, "sort": [2, 2] },
                { "_source": { "@timestamp": "2026-11-03T07:58:00Z", "event": { "original": "ERROR raw" } },
                  "sort": [1, 3] }
            ]
        }
    });
    let page = map_response(&response, FieldPreset::Ecs, 3).expect("page");
    assert_eq!(page.total, Some(10000));
    assert!(page.total_is_lower_bound);
    assert_eq!(page.next, Some(vec![json!(1), json!(3)]));
    let [a, b, c] = &page.lines[..] else {
        panic!("three lines")
    };
    assert_eq!(a.message, "disk almost full");
    assert_eq!(a.level, LogLevel::Warn);
    assert_eq!(a.container.as_deref(), Some("web"));
    assert_eq!(a.time.as_deref(), Some("2026-11-03T08:00:00Z"));
    assert!(a.document.contains("\"message\":\"disk almost full\\n\""));
    assert_eq!(b.level, LogLevel::Error);
    assert_eq!(b.container.as_deref(), Some("web"));
    assert_eq!(c.message, "ERROR raw");
    assert_eq!(
        c.level,
        LogLevel::Error,
        "detected from the message without a level field"
    );

    let fluent = json!({ "hits": { "total": 1, "hits": [
        { "_source": { "@timestamp": "t", "log": "plain line", "kubernetes": { "container_name": "c" } } }
    ] } });
    let page = map_response(&fluent, FieldPreset::FluentBit, 500).expect("page");
    assert_eq!(page.total, Some(1));
    assert!(!page.total_is_lower_bound);
    assert_eq!(page.next, None, "short page is the last");
    assert_eq!(page.lines[0].message, "plain line");
    assert_eq!(page.lines[0].container.as_deref(), Some("c"));
}

#[test]
fn map_response_rejects_non_search_bodies() {
    assert!(matches!(
        map_response(&json!({ "acknowledged": true }), FieldPreset::Ecs, 1),
        Err(ElasticError::Response(_))
    ));
}

#[test]
fn error_reason_prefers_root_cause_then_status_text() {
    let body = r#"{"error":{"root_cause":[{"reason":"no such index [logs-x]"}],"reason":"outer"},"status":404}"#;
    assert_eq!(error_reason(body, 404), "no such index [logs-x]");
    assert_eq!(error_reason(r#"{"error":"plain"}"#, 400), "plain");
    assert!(error_reason("", 401).starts_with("authentication failed"));
}

#[test]
fn auth_headers_and_debug_hide_secrets() {
    let basic = EsAuth::Basic {
        username: "elastic".into(),
        password: "s3cret".into(),
    };
    assert_eq!(
        basic.header().as_deref(),
        Some("Basic ZWxhc3RpYzpzM2NyZXQ=")
    );
    assert_eq!(
        EsAuth::ApiKey {
            key: " abc== ".into()
        }
        .header()
        .as_deref(),
        Some("ApiKey abc==")
    );
    assert_eq!(
        EsAuth::Bearer { token: "t".into() }.header().as_deref(),
        Some("Bearer t")
    );
    assert_eq!(EsAuth::None.header(), None);
    assert_eq!(format!("{basic:?}"), "EsAuth(basic)");
}

#[test]
fn auth_serialises_with_a_method_tag() {
    let v = serde_json::to_value(EsAuth::ApiKey { key: "k".into() }).expect("json");
    assert_eq!(v, json!({ "method": "api-key", "key": "k" }));
    let endpoint: EsEndpoint = serde_json::from_value(json!({
        "target": { "kind": "in-cluster", "namespace": "logging", "service": "quickstart-es-http", "port": 9200, "https": true },
        "indexPattern": "logs-*"
    }))
    .expect("endpoint");
    assert_eq!(endpoint.preset, FieldPreset::Ecs);
    assert!(!endpoint.skip_tls_verify);
}

#[test]
fn index_patterns_are_path_safe() {
    assert!(validate_index_pattern(DEFAULT_INDEX_PATTERN).is_ok());
    assert!(validate_index_pattern("remote:logs-*").is_ok());
    for bad in ["", "logs/x", "logs x", "_all", "a?b", "../x", "-x"] {
        assert!(validate_index_pattern(bad).is_err(), "{bad}");
    }
}

#[test]
fn kibana_discover_url_escapes_rison_and_kql() {
    let url = kibana_discover_url(
        "https://kb.example/",
        FieldPreset::Ecs,
        "shop",
        "api-0",
        Some("web"),
        "now-1h",
        "now",
    );
    assert!(url.starts_with("https://kb.example/app/discover#/?_g="));
    let decoded = url
        .replace("%28", "(")
        .replace("%29", ")")
        .replace("%3A", ":")
        .replace("%27", "'")
        .replace("%2C", ",")
        .replace("%22", "\"")
        .replace("%20", " ");
    assert!(decoded.contains("_g=(time:(from:'now-1h',to:'now'))"));
    assert!(decoded.contains(
        "query:'kubernetes.namespace:\"shop\" and kubernetes.pod.name:\"api-0\" and kubernetes.container.name:\"web\"'"
    ));
    let tricky = kibana_discover_url(
        "http://k",
        FieldPreset::Ecs,
        "it's",
        "a\"b!",
        None,
        "now-1h",
        "now",
    );
    assert!(tricky.contains("%21%27"), "' escaped as !' in rison");
    assert!(tricky.contains("%21%21"), "! escaped as !! in rison");
    assert!(tricky.contains("%5C%22"), "\" escaped in KQL");
}

fn service(json: serde_json::Value) -> Service {
    serde_json::from_value(json).expect("service")
}

fn pod(json: serde_json::Value) -> Pod {
    serde_json::from_value(json).expect("pod")
}

#[test]
fn target_port_resolves_numeric_named_and_default() {
    let p = pod(
        json!({ "spec": { "containers": [{ "name": "es", "ports": [{ "name": "https", "containerPort": 9201 }] }] } }),
    );
    let numeric = service(json!({ "spec": { "ports": [{ "port": 9200, "targetPort": 9300 }] } }));
    let named = service(json!({ "spec": { "ports": [{ "port": 9200, "targetPort": "https" }] } }));
    let none = service(json!({ "spec": { "ports": [{ "port": 9200 }] } }));
    assert_eq!(target_port(&numeric, 9200, &p), Some(9300));
    assert_eq!(target_port(&named, 9200, &p), Some(9201));
    assert_eq!(target_port(&none, 9200, &p), Some(9200));
    assert_eq!(target_port(&none, 1234, &p), None);
}

#[test]
fn ready_pod_skips_pending_and_unready() {
    let pods = vec![
        pod(json!({ "metadata": { "name": "a" }, "status": { "phase": "Pending" } })),
        pod(
            json!({ "metadata": { "name": "b" }, "status": { "phase": "Running", "conditions": [{ "type": "Ready", "status": "False" }] } }),
        ),
        pod(
            json!({ "metadata": { "name": "c" }, "status": { "phase": "Running", "conditions": [{ "type": "Ready", "status": "True" }] } }),
        ),
    ];
    assert_eq!(
        ready_pod(&pods).and_then(|p| p.metadata.name.as_deref()),
        Some("c")
    );
    assert!(ready_pod(&pods[..2]).is_none());
}

#[test]
fn classify_finds_eck_and_helm_services() {
    let eck = service(json!({
        "metadata": { "name": "quickstart-es-http", "namespace": "logging", "labels": { "common.k8s.elastic.co/type": "elasticsearch" } },
        "spec": { "ports": [{ "name": "https", "port": 9200 }] }
    }));
    let found = classify(&eck).expect("eck");
    assert_eq!(
        (found.kind.as_str(), found.port, found.https),
        ("elasticsearch", 9200, true)
    );
    let helm_kibana = service(json!({
        "metadata": { "name": "kibana-kibana", "namespace": "logging" },
        "spec": { "ports": [{ "name": "http", "port": 5601 }] }
    }));
    let kb = classify(&helm_kibana).expect("kibana");
    assert_eq!((kb.kind.as_str(), kb.https), ("kibana", false));
    let transport = service(json!({
        "metadata": { "name": "quickstart-es-transport", "labels": { "common.k8s.elastic.co/type": "elasticsearch" } },
        "spec": { "ports": [{ "port": 9300 }] }
    }));
    assert!(classify(&transport).is_none());
    let other =
        service(json!({ "metadata": { "name": "web" }, "spec": { "ports": [{ "port": 80 }] } }));
    assert!(classify(&other).is_none());
    assert_eq!(
        service_host("logging", "quickstart-es-http"),
        "quickstart-es-http.logging.svc"
    );
}

/// Serves one canned HTTP response per connection and records the requests.
async fn mock_server(
    responses: Vec<(u16, String)>,
) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let handle = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in responses {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = vec![0u8; 16 * 1024];
            let mut read = 0;
            // Read headers and a JSON body (Content-Length) or none.
            loop {
                let n = socket.read(&mut buf[read..]).await.expect("read");
                read += n;
                let text = String::from_utf8_lossy(&buf[..read]).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if read >= end + 4 + len || n == 0 {
                        requests.push(text);
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.expect("write");
        }
        requests
    });
    (format!("http://{addr}"), handle)
}

fn external(url: &str) -> EsEndpoint {
    EsEndpoint {
        target: EsTarget::External {
            url: url.to_string(),
        },
        index_pattern: "logs-*".into(),
        preset: FieldPreset::Ecs,
        kibana_url: None,
        skip_tls_verify: false,
    }
}

#[tokio::test]
async fn external_search_sends_auth_and_maps_hits() {
    let hits = json!({ "hits": { "total": { "value": 1, "relation": "eq" }, "hits": [
        { "_source": { "@timestamp": "t", "message": "hello" }, "sort": [1, 1] }
    ] } });
    let (url, server) = mock_server(vec![(200, hits.to_string())]).await;
    let endpoint = external(&url);
    let conn = connect(None, &endpoint, &EsAuth::ApiKey { key: "k1".into() })
        .await
        .expect("connect");
    let page = conn.search(&endpoint, &query()).await.expect("search");
    assert_eq!(page.lines[0].message, "hello");
    let requests = server.await.expect("server");
    let req = requests[0].to_ascii_lowercase();
    assert!(req.starts_with("post /logs-*/_search?ignore_unavailable=true&allow_no_indices=true"));
    assert!(req.contains("authorization: apikey k1"));
    assert!(req.contains("\"kubernetes.pod.name\":\"api-0\""));
}

#[tokio::test]
async fn external_errors_carry_the_server_reason() {
    let (url, server) = mock_server(vec![(
        401,
        r#"{"error":{"root_cause":[{"reason":"unable to authenticate user [elastic]"}]},"status":401}"#.into(),
    )])
    .await;
    let endpoint = external(&url);
    let conn = connect(None, &endpoint, &EsAuth::None)
        .await
        .expect("connect");
    let err = conn.search(&endpoint, &query()).await.expect_err("401");
    assert_eq!(
        err,
        ElasticError::Http {
            status: 401,
            reason: "unable to authenticate user [elastic]".into()
        }
    );
    server.await.expect("server");
}

#[tokio::test]
async fn info_reads_version_health_and_index_count_best_effort() {
    let (url, server) = mock_server(vec![
        (200, json!({ "cluster_name": "prod", "version": { "number": "8.15.0" } }).to_string()),
        (403, r#"{"error":{"reason":"forbidden"}}"#.into()),
        (200, json!({ "indices": [{ "name": "a" }], "data_streams": [{ "name": "logs-x" }, { "name": "logs-y" }] }).to_string()),
    ])
    .await;
    let endpoint = external(&url);
    let conn = connect(None, &endpoint, &EsAuth::None)
        .await
        .expect("connect");
    let info = conn.info(&endpoint).await.expect("info");
    assert_eq!(info.version, "8.15.0");
    assert_eq!(info.cluster_name, "prod");
    assert_eq!(info.health, None);
    assert_eq!(info.indices, Some(3));
    server.await.expect("server");
}

#[tokio::test]
async fn connect_rejects_bad_urls_and_in_cluster_without_a_client() {
    for bad in ["not a url", "ftp://x"] {
        assert!(
            matches!(
                connect(None, &external(bad), &EsAuth::None).await,
                Err(ElasticError::Config(_))
            ),
            "{bad}"
        );
    }
    let mut endpoint = external("http://x");
    endpoint.target = EsTarget::InCluster {
        namespace: "n".into(),
        service: "s".into(),
        port: 9200,
        https: true,
    };
    assert!(matches!(
        connect(None, &endpoint, &EsAuth::None).await,
        Err(ElasticError::Config(_))
    ));
}
