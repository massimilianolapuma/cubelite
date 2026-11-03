use super::transport::{
    check_external_url, classify, connect, ready_pod, service_host, target_port,
};
use super::*;
use crate::test_support::mock_server;
use k8s_openapi::api::core::v1::{Pod, Service};
use serde_json::json;

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
    let body = search_body(&query(), FieldPreset::Ecs, None);
    assert_eq!(body["size"], 500);
    let filter = body["query"]["bool"]["filter"].as_array().expect("filter");
    assert!(filter.contains(&json!({ "term": { "kubernetes.namespace": "shop" } })));
    assert!(filter.contains(&json!({ "term": { "kubernetes.pod.name": "api-0" } })));
    assert!(
        filter.contains(&json!({ "range": { "@timestamp": { "gte": "now-1h", "lte": "now" } } }))
    );
    assert_eq!(
        body["sort"][0],
        json!({ "@timestamp": { "order": "desc", "unmapped_type": "date" } })
    );
    assert_eq!(body["sort"][1], json!({ "_index": "asc" }));
    assert!(body.get("search_after").is_none());
    assert!(body.get("pit").is_none());
    assert_eq!(body["query"]["bool"]["must"], json!([]));
}

#[test]
fn search_body_on_a_point_in_time_breaks_ties_with_shard_doc() {
    let mut q = query();
    q.search_after = Some(HistoryCursor {
        pit_id: Some("pit-1".into()),
        sort: vec![json!(1_730_000_000_000_u64), json!(7)],
    });
    let body = search_body(&q, FieldPreset::Ecs, Some("pit-2"));
    assert_eq!(body["pit"], json!({ "id": "pit-2", "keep_alive": "5m" }));
    assert_eq!(
        body["sort"],
        json!([
            { "@timestamp": { "order": "desc", "unmapped_type": "date" } },
            { "_shard_doc": "desc" }
        ])
    );
    assert_eq!(body["search_after"], json!([1_730_000_000_000_u64, 7]));
}

#[test]
fn cursor_serialises_camel_case_and_omits_a_missing_pit() {
    let with = HistoryCursor {
        pit_id: Some("p".into()),
        sort: vec![json!(1)],
    };
    assert_eq!(
        serde_json::to_value(&with).expect("json"),
        json!({ "pitId": "p", "sort": [1] })
    );
    let without: HistoryCursor = serde_json::from_value(json!({ "sort": [1, 2] })).expect("cursor");
    assert_eq!(without.pit_id, None);
    assert_eq!(
        serde_json::to_value(&without).expect("json"),
        json!({ "sort": [1, 2] })
    );
}

#[test]
fn search_body_adds_container_text_paging_and_caps_size() {
    let mut q = query();
    q.container = Some("worker".into());
    q.text = Some("  timeout \"db\"  ".into());
    q.search_after = Some(HistoryCursor {
        pit_id: None,
        sort: vec![json!(1_730_000_000_000_u64), json!(42)],
    });
    q.size = Some(5000);
    let body = search_body(&q, FieldPreset::FluentBit, None);
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
                { "_index": ".ds-logs-1", "_id": "id-3",
                  "_source": { "@timestamp": "2026-11-03T08:00:00Z", "log": { "level": "WARN" },
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
    assert_eq!(
        page.next,
        Some(HistoryCursor {
            pit_id: None,
            sort: vec![json!(1), json!(3)]
        })
    );
    let [a, b, c] = &page.lines[..] else {
        panic!("three lines")
    };
    assert_eq!(a.doc_index.as_deref(), Some(".ds-logs-1"));
    assert_eq!(a.doc_id.as_deref(), Some("id-3"));
    assert_eq!(b.doc_id, None);
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
    assert_eq!(endpoint.kibana_service, None, "endpoints saved before #505");
    let with_kibana: EsEndpoint = serde_json::from_value(json!({
        "target": { "kind": "external", "url": "https://es.example" },
        "indexPattern": "logs-*",
        "kibanaService": { "namespace": "logging", "service": "quickstart-kb-http", "port": 5601, "https": true }
    }))
    .expect("endpoint with kibana");
    assert_eq!(
        with_kibana.kibana_service,
        Some(KibanaService {
            namespace: "logging".into(),
            service: "quickstart-kb-http".into(),
            port: 5601,
            https: true
        })
    );
}

#[test]
fn index_patterns_are_path_safe() {
    assert!(validate_index_pattern(DEFAULT_INDEX_PATTERN).is_ok());
    assert!(validate_index_pattern("remote:logs-*").is_ok());
    for bad in [
        "",
        "logs/x",
        "logs x",
        "_all",
        "a?b",
        "../x",
        "-x",
        "..",
        ".",
        "logs-*,..",
        "remote:..",
    ] {
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

fn external(url: &str) -> EsEndpoint {
    EsEndpoint {
        target: EsTarget::External {
            url: url.to_string(),
        },
        index_pattern: "logs-*".into(),
        preset: FieldPreset::Ecs,
        kibana_url: None,
        kibana_service: None,
        skip_tls_verify: false,
    }
}

/// A newest-first `_search` response with one hit per `sort` value pair.
fn pit_hits(pit_id: &str, sorts: &[[u64; 2]]) -> String {
    let hits: Vec<Value> = sorts
        .iter()
        .map(|s| json!({ "_source": { "@timestamp": "t", "message": format!("m{}", s[0]) }, "sort": s }))
        .collect();
    json!({ "pit_id": pit_id, "hits": { "total": { "value": 3, "relation": "eq" }, "hits": hits } })
        .to_string()
}

/// The JSON body of a recorded request.
fn body_of(request: &str) -> Value {
    let (_, body) = request.split_once("\r\n\r\n").expect("body");
    serde_json::from_str(body).expect("json body")
}

#[tokio::test]
async fn history_pages_on_a_point_in_time_and_close_it_at_the_end() {
    let (url, server) = mock_server(vec![
        (200, json!({ "id": "pit-a" }).to_string()),
        (200, pit_hits("pit-b", &[[3, 9], [2, 8]])),
        (200, pit_hits("pit-c", &[[1, 7]])),
        (
            200,
            json!({ "succeeded": true, "num_freed": 1 }).to_string(),
        ),
    ])
    .await;
    let endpoint = external(&url);
    let conn = connect(None, &endpoint, &EsAuth::ApiKey { key: "k1".into() })
        .await
        .expect("connect");
    let mut q = query();
    q.size = Some(2);
    let first = conn.search(&endpoint, &q).await.expect("first page");
    assert_eq!(first.lines[0].message, "m3");
    let cursor = first.next.clone().expect("more pages");
    assert_eq!(cursor.pit_id.as_deref(), Some("pit-b"), "latest PIT id");
    assert_eq!(cursor.sort, vec![json!(2), json!(8)]);
    q.search_after = Some(cursor);
    let older = conn.search(&endpoint, &q).await.expect("older page");
    assert_eq!(older.lines[0].message, "m1");
    assert_eq!(older.next, None, "short page is the last");

    let requests = server.await.expect("server");
    assert_eq!(requests.len(), 4);
    let open = requests[0].to_ascii_lowercase();
    assert!(
        open.starts_with("post /logs-*/_pit?keep_alive=5m&ignore_unavailable=true "),
        "{open}"
    );
    assert!(open.contains("authorization: apikey k1"));
    assert!(
        requests[1].starts_with("POST /_search "),
        "no index with a PIT"
    );
    let body = body_of(&requests[1]);
    assert_eq!(body["pit"], json!({ "id": "pit-a", "keep_alive": "5m" }));
    assert_eq!(body["sort"][1], json!({ "_shard_doc": "desc" }));
    assert!(body.get("search_after").is_none());
    assert_eq!(
        body["query"]["bool"]["filter"][1]["term"]["kubernetes.pod.name"],
        "api-0"
    );
    assert!(requests[2].starts_with("POST /_search "));
    let body = body_of(&requests[2]);
    assert_eq!(
        body["pit"]["id"], "pit-b",
        "Load older reuses the updated id"
    );
    assert_eq!(body["search_after"], json!([2, 8]));
    assert!(
        requests[3].starts_with("DELETE /_pit "),
        "closed after the last page"
    );
    assert_eq!(body_of(&requests[3]), json!({ "id": "pit-c" }));
}

#[tokio::test]
async fn history_falls_back_to_search_after_without_pit_and_remembers_it() {
    let hits = json!({ "hits": { "total": { "value": 1, "relation": "eq" }, "hits": [
        { "_source": { "@timestamp": "t", "message": "hello" }, "sort": [1, 1] }
    ] } });
    let (url, server) = mock_server(vec![
        (
            403,
            r#"{"error":{"reason":"action [indices:data/read/open_point_in_time] is unauthorized"}}"#
                .into(),
        ),
        (200, hits.to_string()),
        (200, hits.to_string()),
    ])
    .await;
    let endpoint = external(&url);
    let conn = connect(None, &endpoint, &EsAuth::ApiKey { key: "k1".into() })
        .await
        .expect("connect");
    let page = conn.search(&endpoint, &query()).await.expect("search");
    assert_eq!(page.lines[0].message, "hello");
    // Another first page on the same connection does not probe again.
    let mut q = query();
    q.size = Some(1);
    let page = conn.search(&endpoint, &q).await.expect("search again");
    assert_eq!(
        page.next,
        Some(HistoryCursor {
            pit_id: None,
            sort: vec![json!(1), json!(1)]
        })
    );
    let requests = server.await.expect("server");
    assert!(requests[0].starts_with("POST /logs-*/_pit?"));
    for req in &requests[1..] {
        let lower = req.to_ascii_lowercase();
        assert!(
            lower.starts_with("post /logs-*/_search?ignore_unavailable=true&allow_no_indices=true"),
            "{lower}"
        );
        assert!(lower.contains("authorization: apikey k1"));
        let body = body_of(req);
        assert!(body.get("pit").is_none());
        assert_eq!(body["sort"][1], json!({ "_index": "asc" }));
    }
}

#[tokio::test]
async fn closing_a_cursor_deletes_its_point_in_time() {
    let (url, server) =
        mock_server(vec![(404, r#"{"succeeded":true,"num_freed":0}"#.into())]).await;
    let endpoint = external(&url);
    let conn = connect(None, &endpoint, &EsAuth::None)
        .await
        .expect("connect");
    // Without a PIT there is nothing to close: no request.
    conn.close_cursor(&HistoryCursor {
        pit_id: None,
        sort: vec![json!(1)],
    })
    .await;
    // Best effort: an expired PIT (404) is not an error.
    conn.close_cursor(&HistoryCursor {
        pit_id: Some("pit-z".into()),
        sort: vec![json!(1)],
    })
    .await;
    let requests = server.await.expect("server");
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("DELETE /_pit "));
    assert_eq!(body_of(&requests[0]), json!({ "id": "pit-z" }));
}

#[tokio::test]
async fn an_expired_point_in_time_continues_on_a_new_one() {
    let (url, server) = mock_server(vec![
        (
            404,
            r#"{"error":{"root_cause":[{"type":"search_context_missing_exception","reason":"No search context found"}]},"status":404}"#.into(),
        ),
        (200, json!({ "id": "pit-new" }).to_string()),
        (200, pit_hits("pit-new", &[[1, 7]])),
        (200, json!({ "succeeded": true }).to_string()),
    ])
    .await;
    let endpoint = external(&url);
    let conn = connect(None, &endpoint, &EsAuth::None)
        .await
        .expect("connect");
    let mut q = query();
    q.search_after = Some(HistoryCursor {
        pit_id: Some("pit-old".into()),
        sort: vec![json!(2), json!(8)],
    });
    let page = conn.search(&endpoint, &q).await.expect("older page");
    assert_eq!(page.lines[0].message, "m1");
    let requests = server.await.expect("server");
    assert_eq!(body_of(&requests[0])["pit"]["id"], "pit-old");
    assert!(requests[1].starts_with("POST /logs-*/_pit?"));
    let body = body_of(&requests[2]);
    assert_eq!(body["pit"]["id"], "pit-new");
    assert_eq!(
        body["search_after"],
        json!([2, i64::MAX]),
        "the old _shard_doc means nothing on a new PIT: resume at the boundary millisecond"
    );
    assert!(requests[3].starts_with("DELETE /_pit "));
}

#[tokio::test]
async fn other_pit_open_failures_page_without_pit_for_that_request_only() {
    let hits = json!({ "hits": { "total": 1, "hits": [
        { "_source": { "@timestamp": "t", "message": "hello" }, "sort": [1, 1] }
    ] } })
    .to_string();
    let (url, server) = mock_server(vec![
        (
            429,
            r#"{"error":{"reason":"Trying to create too many Point In Time contexts"}}"#.into(),
        ),
        (200, hits.clone()),
        (503, r#"{"error":{"reason":"unavailable"}}"#.into()),
        (200, hits),
        (200, json!({ "id": "pit-a" }).to_string()),
        (200, pit_hits("pit-a", &[[1, 7]])),
        (200, json!({ "succeeded": true }).to_string()),
    ])
    .await;
    let endpoint = external(&url);
    let conn = connect(None, &endpoint, &EsAuth::None)
        .await
        .expect("connect");
    for _ in 0..2 {
        let page = conn.search(&endpoint, &query()).await.expect("plain page");
        assert_eq!(page.lines[0].message, "hello");
    }
    let page = conn.search(&endpoint, &query()).await.expect("PIT again");
    assert_eq!(page.lines[0].message, "m1");
    let requests = server.await.expect("server");
    assert!(requests[1].starts_with("POST /logs-*/_search?"));
    assert!(
        requests[2].starts_with("POST /logs-*/_pit?"),
        "probed again"
    );
    assert!(requests[3].starts_with("POST /logs-*/_search?"));
    assert!(
        requests[4].starts_with("POST /logs-*/_pit?"),
        "probed again"
    );
    assert!(requests[5].starts_with("POST /_search "));
}

#[tokio::test]
async fn a_pit_without_shard_doc_closes_it_and_pages_without_pit() {
    let hits = json!({ "hits": { "total": 1, "hits": [
        { "_source": { "@timestamp": "t", "message": "hello" }, "sort": [1, 1] }
    ] } })
    .to_string();
    let (url, server) = mock_server(vec![
        (200, json!({ "id": "pit-7" }).to_string()),
        (
            400,
            r#"{"error":{"reason":"No mapping found for [_shard_doc] in order to sort on"}}"#
                .into(),
        ),
        (200, json!({ "succeeded": true }).to_string()),
        (200, hits.clone()),
        (200, hits),
    ])
    .await;
    let endpoint = external(&url);
    let conn = connect(None, &endpoint, &EsAuth::None)
        .await
        .expect("connect");
    let page = conn.search(&endpoint, &query()).await.expect("plain page");
    assert_eq!(page.lines[0].message, "hello");
    conn.search(&endpoint, &query())
        .await
        .expect("no probe on the next first page");
    let requests = server.await.expect("server");
    assert!(requests[1].starts_with("POST /_search "));
    assert!(requests[2].starts_with("DELETE /_pit "));
    assert_eq!(body_of(&requests[2]), json!({ "id": "pit-7" }));
    assert!(requests[3].starts_with("POST /logs-*/_search?"));
    assert!(requests[4].starts_with("POST /logs-*/_search?"));
}

#[tokio::test]
async fn external_errors_carry_the_server_reason() {
    let unauthorized = r#"{"error":{"root_cause":[{"reason":"unable to authenticate user [elastic]"}]},"status":401}"#;
    // The PIT open fails, then the plain search reports the reason.
    let (url, server) =
        mock_server(vec![(401, unauthorized.into()), (401, unauthorized.into())]).await;
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

#[test]
fn external_urls_refuse_embedded_or_cleartext_credentials() {
    let key = EsAuth::ApiKey { key: "k".into() };
    assert!(check_external_url("https://es.example:9243", &key).is_ok());
    assert!(check_external_url("http://es.example:9200", &EsAuth::None).is_ok());
    // Loopback (a user's own `kubectl port-forward`) never leaves the machine.
    assert!(check_external_url("http://127.0.0.1:9200", &key).is_ok());
    assert!(check_external_url("http://localhost:9200", &key).is_ok());
    for (url, auth) in [
        ("http://es.example:9200", &key),
        ("https://elastic:pw@es.example", &EsAuth::None),
        ("https://es.example", &EsAuth::EckUser),
        ("ftp://es.example", &EsAuth::None),
    ] {
        let err = check_external_url(url, auth).expect_err(url);
        assert!(!err.to_string().contains("pw"), "no secret echoed: {err}");
    }
}

#[test]
fn eck_detection_skips_node_set_services_and_follows_the_port_scheme() {
    let node_set = service(json!({
        "metadata": { "name": "quickstart-es-default", "labels": { "common.k8s.elastic.co/type": "elasticsearch" } },
        "spec": { "ports": [{ "name": "https", "port": 9200 }] }
    }));
    assert!(classify(&node_set).is_none());
    let plain = service(json!({
        "metadata": { "name": "quickstart-es-http", "labels": { "common.k8s.elastic.co/type": "elasticsearch" } },
        "spec": { "ports": [{ "name": "http", "port": 9200 }] }
    }));
    assert!(!classify(&plain).expect("plain").https);
}

#[test]
fn eck_user_is_not_a_stored_secret() {
    assert_eq!(EsAuth::EckUser.header(), None);
    assert_eq!(format!("{:?}", EsAuth::EckUser), "EsAuth(eck-user)");
    assert_eq!(
        serde_json::to_value(EsAuth::EckUser).expect("json"),
        json!({ "method": "eck-user" })
    );
}
