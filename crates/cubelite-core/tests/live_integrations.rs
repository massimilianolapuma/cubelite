//! Live checks of the Elasticsearch, Kibana and Prometheus integrations
//! against a real cluster (the spec's manual checklist, #483 #484 #505).
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

/// A running pod of `namespace` whose name starts with `prefix`.
async fn pod_named(client: &kube::Client, namespace: &str, prefix: &str) -> String {
    let pods: kube::Api<k8s_openapi::api::core::v1::Pod> =
        kube::Api::namespaced(client.clone(), namespace);
    pods.list(&Default::default())
        .await
        .expect("pods")
        .items
        .into_iter()
        .filter_map(|p| p.metadata.name)
        .find(|n| n.starts_with(prefix))
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
    assert!(page.next.is_some(), "more than one page");
    let text = conn
        .search(
            &endpoint,
            &HistoryQuery {
                namespace: "shop".into(),
                pod,
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
    let svc = found.first().expect("Prometheus service");
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
