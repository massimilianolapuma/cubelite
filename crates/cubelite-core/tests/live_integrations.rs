//! Live checks of the Elasticsearch, Kibana, Prometheus and Grafana
//! integrations against a real cluster (the spec's manual checklist, #483
//! #484 #505 #525).
//!
//! Ignored by default. Run against a cluster with ECK (`logging/quickstart`),
//! kube-prometheus-stack (`monitoring`) and pods in `shop`:
//!
//! ```sh
//! CUBELITE_LIVE_CONTEXT=minikube cargo test -p cubelite-core --test live_integrations -- --ignored --nocapture
//! ```

use cubelite_core::elastic::transport as es;
use cubelite_core::elastic::{EsAuth, EsEndpoint, EsTarget, FieldPreset, HistoryQuery};
use cubelite_core::integration;
use cubelite_core::prometheus::transport as prom;
use cubelite_core::prometheus::{
    MetricsRange, MetricsRequest, PromAuth, PromEndpoint, PromTarget, Workload,
};
use cubelite_core::KubeClient;

async fn client() -> Option<kube::Client> {
    let context = std::env::var("CUBELITE_LIVE_CONTEXT").ok()?;
    let home = std::env::var("HOME").ok()?;
    let kubeconfig = std::env::var("KUBECONFIG").unwrap_or(format!("{home}/.kube/config"));
    Some(
        KubeClient::new(&kubeconfig, Some(&context))
            .await
            .expect("kube client")
            .client(),
    )
}

/// Pods of `namespace` whose names start with `prefix`.
async fn pods_named(client: &kube::Client, namespace: &str, prefix: &str) -> Vec<String> {
    let pods: kube::Api<k8s_openapi::api::core::v1::Pod> =
        kube::Api::namespaced(client.clone(), namespace);
    pods.list(&Default::default())
        .await
        .expect("pods")
        .items
        .into_iter()
        .filter_map(|p| p.metadata.name)
        .filter(|n| n.starts_with(prefix))
        .collect()
}

/// A pod of `namespace` whose name starts with `prefix`.
async fn pod_named(client: &kube::Client, namespace: &str, prefix: &str) -> String {
    pods_named(client, namespace, prefix)
        .await
        .into_iter()
        .next()
        .expect("pod")
}

#[tokio::test]
#[ignore = "needs a live cluster (CUBELITE_LIVE_CONTEXT)"]
async fn elasticsearch_history_through_the_eck_tunnel() {
    let Some(client) = client().await else { return };
    let found = es::detect(client.clone()).await.expect("detect");
    println!("detected: {found:?}");
    let svc = found
        .iter()
        .find(|s| s.kind == "elasticsearch")
        .expect("ES service");
    let endpoint = EsEndpoint {
        target: EsTarget::InCluster {
            namespace: svc.namespace.clone(),
            service: svc.name.clone(),
            port: svc.port,
            https: svc.https,
        },
        index_pattern: "logs-*,filebeat-*".into(),
        preset: FieldPreset::Ecs,
        kibana_url: None,
        kibana_service: None,
        skip_tls_verify: false,
    };
    let conn = es::connect(Some(client.clone()), &endpoint, &EsAuth::EckUser)
        .await
        .expect("connect with ECK user and pinned CA");
    let info = conn.info(&endpoint).await.expect("info");
    println!("info: {info:?}");
    assert!(info.version.starts_with('8'));
    assert!(info.indices.unwrap_or(0) > 0, "filebeat data stream");

    let pod = pod_named(&client, "shop", "api-").await;
    let page = conn
        .search(
            &endpoint,
            &HistoryQuery {
                namespace: "shop".into(),
                pod: pod.clone(),
                workload: None,
                container: None,
                from: "now-1h".into(),
                to: "now".into(),
                text: None,
                search_after: None,
                size: Some(50),
            },
        )
        .await
        .expect("search");
    println!(
        "{pod}: {} hits, first: {:?}",
        page.total.unwrap_or(0),
        page.lines.first()
    );
    assert!(!page.lines.is_empty(), "history for {pod}");
    let cursor = page.next.clone().expect("more than one page");
    // #531: the first page opened a point in time (ECK's `elastic` user may).
    assert!(cursor.pit_id.is_some(), "paging on a point in time");
    let older = conn
        .search(
            &endpoint,
            &HistoryQuery {
                namespace: "shop".into(),
                pod: pod.clone(),
                workload: None,
                container: None,
                from: "now-1h".into(),
                to: "now".into(),
                text: None,
                search_after: Some(cursor),
                size: Some(50),
            },
        )
        .await
        .expect("older page on the PIT");
    assert!(!older.lines.is_empty(), "a second page");
    let first: std::collections::HashSet<&str> =
        page.lines.iter().map(|l| l.document.as_str()).collect();
    assert!(
        older
            .lines
            .iter()
            .all(|l| !first.contains(l.document.as_str())),
        "no hit repeated between pages"
    );
    assert!(
        older.lines.first().and_then(|l| l.time.as_deref())
            <= page.lines.last().and_then(|l| l.time.as_deref()),
        "older page continues where the first ended"
    );
    if let Some(next) = older.next.clone() {
        assert!(next.pit_id.is_some());
        // A gone PIT (closed here, like one idle past its keep-alive)
        // resumes on a new one at the boundary millisecond: repeats only
        // there, nothing skipped.
        let gone = next.pit_id.clone();
        conn.close_cursor(&next).await;
        let resumed = conn
            .search(
                &endpoint,
                &HistoryQuery {
                    namespace: "shop".into(),
                    pod: pod.clone(),
                    workload: None,
                    container: None,
                    from: "now-1h".into(),
                    to: "now".into(),
                    text: None,
                    search_after: Some(next),
                    size: Some(50),
                },
            )
            .await
            .expect("resumes on a new PIT");
        assert!(!resumed.lines.is_empty());
        let boundary = older.lines.last().and_then(|l| l.time.clone());
        let key = |l: &cubelite_core::elastic::HistoryLine| (l.doc_index.clone(), l.doc_id.clone());
        let seen: std::collections::HashSet<_> = older.lines.iter().map(key).collect();
        for line in &resumed.lines {
            assert!(line.time <= boundary, "older than the boundary");
            if seen.contains(&key(line)) {
                assert_eq!(line.time, boundary, "repeats only at the boundary");
            }
        }
        if let Some(next) = &resumed.next {
            assert_ne!(
                next.pit_id, gone,
                "a new PIT (the DELETE freed the old one)"
            );
            conn.close_cursor(next).await;
        }
    }
    let text = conn
        .search(
            &endpoint,
            &HistoryQuery {
                namespace: "shop".into(),
                pod,
                workload: None,
                container: Some("api".into()),
                from: "now-1h".into(),
                to: "now".into(),
                text: Some("payment".into()),
                search_after: None,
                size: Some(20),
            },
        )
        .await
        .expect("text search");
    assert!(text.lines.iter().all(|l| l.message.contains("payment")));
    assert!(!text.lines.is_empty());
    if let Some(next) = &text.next {
        conn.close_cursor(next).await;
    }

    // #529: the deployment's history spans its pods (a regexp on the pod
    // name), and every line names its pod.
    let api_pods = pods_named(&client, "shop", "api-").await;
    let workload = conn
        .search(
            &endpoint,
            &HistoryQuery {
                namespace: "shop".into(),
                pod: String::new(),
                workload: Some(Workload::Deployment { name: "api".into() }),
                container: None,
                from: "now-1h".into(),
                to: "now".into(),
                text: None,
                search_after: None,
                size: Some(500),
            },
        )
        .await
        .expect("deployment history");
    if let Some(next) = &workload.next {
        conn.close_cursor(next).await;
    }
    let seen: std::collections::BTreeSet<String> = workload
        .lines
        .iter()
        .filter_map(|l| l.pod.clone())
        .collect();
    println!("api pods {api_pods:?}, history from {seen:?}");
    assert!(!workload.lines.is_empty(), "history for deployment api");
    assert!(
        workload.lines.iter().all(|l| l.pod.is_some()),
        "every line names its pod"
    );
    assert!(
        seen.iter().all(|p| p.starts_with("api-")),
        "only the deployment's pods"
    );
    if api_pods.len() > 1 {
        assert!(seen.len() > 1, "lines from more than one api pod: {seen:?}");
    }
}

#[tokio::test]
#[ignore = "needs a live cluster (CUBELITE_LIVE_CONTEXT)"]
async fn kibana_answers_through_a_service_tunnel() {
    let Some(client) = client().await else { return };
    let found = es::detect(client.clone()).await.expect("detect");
    let kb = found
        .iter()
        .find(|s| s.kind == "kibana")
        .expect("Kibana service");
    let tunnel = integration::open_service_tunnel(&client, &kb.namespace, &kb.name, kb.port)
        .await
        .expect("tunnel");
    assert!(integration::pod_ready(&client, &kb.namespace, &tunnel.pod).await);
    // Verified TLS: ECK's CA for the Kibana service, and the service name
    // (what the certificate names) resolved to the tunnel.
    let secrets: kube::Api<k8s_openapi::api::core::v1::Secret> =
        kube::Api::namespaced(client.clone(), &kb.namespace);
    let ca = secrets
        .get(&format!("{}-certs-public", kb.name))
        .await
        .expect("Kibana CA secret")
        .data
        .and_then(|d| d.get("ca.crt").map(|b| b.0.clone()))
        .expect("ca.crt");
    let host = integration::service_host(&kb.namespace, &kb.name);
    let http = integration::http_builder(false)
        .add_root_certificate(reqwest::Certificate::from_pem(&ca).expect("CA"))
        .no_proxy()
        .resolve(
            &host,
            std::net::SocketAddr::from(([127, 0, 0, 1], tunnel.local_port)),
        )
        .build()
        .expect("http");
    let scheme = if kb.https { "https" } else { "http" };
    let response = http
        .get(format!(
            "{scheme}://{host}:{}/api/status",
            tunnel.local_port
        ))
        .send()
        .await
        .expect("kibana");
    println!("kibana /api/status: {}", response.status());
    assert!(matches!(response.status().as_u16(), 200 | 401));
}

#[tokio::test]
#[ignore = "needs a live cluster (CUBELITE_LIVE_CONTEXT)"]
async fn prometheus_charts_through_the_service_proxy() {
    let Some(client) = client().await else { return };
    let found = prom::detect(client.clone()).await.expect("detect");
    println!("detected: {found:?}");
    let svc = found
        .iter()
        .find(|s| s.kind == "prometheus")
        .expect("Prometheus service");
    let endpoint = PromEndpoint {
        target: PromTarget::InCluster {
            namespace: svc.namespace.clone(),
            service: svc.name.clone(),
            port: svc.port,
            https: svc.https,
        },
        cluster: None,
        grafana_url: None,
        grafana_datasource: None,
        grafana_service: None,
        skip_tls_verify: false,
    };
    let conn = prom::connect(Some(client.clone()), &endpoint, &PromAuth::None)
        .await
        .expect("connect");
    let info = conn.info(&endpoint).await.expect("info");
    println!("info: {info:?}");
    assert!(info.cadvisor, "cAdvisor series");
    assert!(info.kube_state_metrics, "kube-state-metrics series");

    let pod = pod_named(&client, "shop", "api-").await;
    for workload in [
        Workload::Pod { name: pod.clone() },
        Workload::Deployment { name: "api".into() },
    ] {
        let result = conn
            .metrics(
                &endpoint,
                &MetricsRequest {
                    namespace: "shop".into(),
                    workload: workload.clone(),
                    range: MetricsRange::Hour,
                    per_container: true,
                },
            )
            .await
            .expect("metrics");
        for chart in &result.charts {
            println!(
                "{workload:?} {:?}: {} series, error {:?}",
                chart.chart,
                chart.series.len(),
                chart.error
            );
            assert!(
                chart.error.is_none(),
                "{:?}: {:?}",
                chart.chart,
                chart.error
            );
        }
        let cpu = &result.charts[0];
        assert!(!cpu.series.is_empty(), "CPU series for {workload:?}");
    }
    let sparklines = conn
        .sparklines(&endpoint, Some("shop"))
        .await
        .expect("sparklines");
    assert!(sparklines.cpu.keys().any(|k| k.starts_with("shop/api-")));
}

#[tokio::test]
#[ignore = "needs a live cluster (CUBELITE_LIVE_CONTEXT)"]
async fn grafana_answers_through_a_service_tunnel() {
    let Some(client) = client().await else { return };
    let found = prom::detect(client.clone()).await.expect("detect");
    let gf = found
        .iter()
        .find(|s| s.kind == "grafana")
        .expect("Grafana service");
    assert!(!gf.https, "kube-prometheus-stack's Grafana speaks http");
    let tunnel = integration::open_service_tunnel(&client, &gf.namespace, &gf.name, gf.port)
        .await
        .expect("tunnel");
    assert!(integration::pod_ready(&client, &gf.namespace, &tunnel.pod).await);
    // What Open in Grafana opens: http on the IPv4 loopback forward.
    let response = integration::http_builder(false)
        .no_proxy()
        .build()
        .expect("http")
        .get(format!("http://127.0.0.1:{}/api/health", tunnel.local_port))
        .send()
        .await
        .expect("grafana");
    println!("grafana /api/health: {}", response.status());
    assert_eq!(response.status().as_u16(), 200);
    let health: serde_json::Value = response.json().await.expect("health json");
    assert_eq!(health["database"], "ok");
}

#[tokio::test]
#[ignore = "needs a live cluster (CUBELITE_LIVE_CONTEXT)"]
async fn detect_all_finds_the_four_services_on_connect() {
    let Some(client) = client().await else { return };
    let found = integration::detect_all(client).await.expect("detect_all");
    println!("detected: {found:?}");
    // ECK controls quickstart-es-http, which selects its cluster: one click.
    assert!(
        found.elasticsearch_one_click,
        "ECK controls quickstart-es-http"
    );
    // prometheus-operated is the operator's governing Service: its owner
    // reference is not a controller one and it selects every Prometheus of
    // the namespace, and the chart's Service has no owner. Review only.
    assert!(!found.prometheus_one_click);
    let name = |namespace: &str, name: &str| (namespace.to_string(), name.to_string());
    let es = found.elasticsearch.expect("Elasticsearch");
    assert_eq!(
        (es.namespace, es.name),
        name("logging", "quickstart-es-http")
    );
    assert!(es.https, "ECK serves https");
    let kb = found.kibana.expect("Kibana");
    assert_eq!(
        (kb.namespace, kb.name),
        name("logging", "quickstart-kb-http")
    );
    let pr = found.prometheus.expect("Prometheus");
    assert_eq!(
        (pr.namespace, pr.name),
        name("monitoring", "prometheus-operated")
    );
    let gf = found.grafana.expect("Grafana");
    assert_eq!((gf.namespace, gf.name), name("monitoring", "kps-grafana"));
}

/// The in-cluster Prometheus, connected through the service proxy.
async fn live_prometheus(client: &kube::Client) -> (PromEndpoint, prom::PromConnection) {
    let found = prom::detect(client.clone()).await.expect("detect");
    let svc = found
        .iter()
        .find(|s| s.kind == "prometheus")
        .expect("Prometheus service");
    let endpoint = PromEndpoint {
        target: PromTarget::InCluster {
            namespace: svc.namespace.clone(),
            service: svc.name.clone(),
            port: svc.port,
            https: svc.https,
        },
        cluster: None,
        grafana_url: None,
        grafana_datasource: None,
        grafana_service: None,
        skip_tls_verify: false,
    };
    let conn = prom::connect(Some(client.clone()), &endpoint, &PromAuth::None)
        .await
        .expect("connect");
    (endpoint, conn)
}

#[tokio::test]
#[ignore = "needs a live cluster (CUBELITE_LIVE_CONTEXT)"]
async fn prometheus_cluster_and_node_history_and_alerts() {
    use cubelite_core::prometheus::nodes::HostChart;
    let Some(client) = client().await else { return };
    let (endpoint, conn) = live_prometheus(&client).await;

    // Overview: cluster CPU and memory against allocatable.
    let cluster = conn
        .cluster_usage(&endpoint, MetricsRange::Hour)
        .await
        .expect("cluster usage");
    for chart in &cluster.charts {
        println!(
            "cluster {:?} ({:?}): {} series",
            chart.chart,
            chart.source,
            chart.series.len()
        );
        assert!(
            chart.error.is_none(),
            "{:?}: {:?}",
            chart.chart,
            chart.error
        );
        assert!(!chart.series.is_empty(), "{:?} series", chart.chart);
    }

    // Node detail: the node's charts, from node-exporter where it runs,
    // else cAdvisor, kube-state-metrics and the kubelet.
    let nodes: kube::Api<k8s_openapi::api::core::v1::Node> = kube::Api::all(client.clone());
    let node = nodes.list(&Default::default()).await.expect("nodes").items[0]
        .metadata
        .name
        .clone()
        .expect("node name");
    let instances = conn
        .node_exporter_instances(&node, None)
        .await
        .expect("instances");
    println!("{node}: node-exporter instances {instances:?}");
    let result = conn
        .node_metrics(&endpoint, &node, MetricsRange::Hour)
        .await
        .expect("node metrics");
    for chart in &result.charts {
        println!(
            "{node} {:?} ({:?}): {} series, query {}",
            chart.chart,
            chart.source,
            chart.series.len(),
            chart.query
        );
        assert!(
            chart.error.is_none(),
            "{:?}: {:?}",
            chart.chart,
            chart.error
        );
    }
    let mut wanted = vec![
        HostChart::Cpu,
        HostChart::CpuAllocatable,
        HostChart::Memory,
        HostChart::MemoryAllocatable,
        HostChart::Pods,
        HostChart::NetworkRx,
        HostChart::NetworkTx,
    ];
    if !instances.is_empty() {
        wanted.push(HostChart::Filesystem);
    }
    for chart in wanted {
        let data = result
            .charts
            .iter()
            .find(|c| c.chart == chart)
            .expect("chart");
        assert!(data.source.is_some(), "{chart:?} has data on {node}");
    }

    // Overview alerts: kube-prometheus-stack's Watchdog always fires.
    let alerts = conn.alerts(&endpoint).await.expect("alerts");
    println!(
        "alerts ({:?}): {:?}",
        alerts.source,
        alerts.alerts.iter().map(|a| &a.name).collect::<Vec<_>>()
    );
    let watchdog = alerts
        .alerts
        .iter()
        .find(|a| a.name == "Watchdog")
        .expect("Watchdog fires");
    assert!(watchdog.active_at.is_some());
    assert!(watchdog.summary.is_some());
    assert_eq!(watchdog.expr, "vector(1)", "the rule's expression");
}
