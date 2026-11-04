use super::*;
use crate::prometheus::transport::connect;
use crate::prometheus::PromAuth;
use crate::test_support::{
    mock_server, prom_endpoint as endpoint, prom_matrix as matrix, prom_vector as vector,
};
use serde_json::json;

/// A chart's candidates, usage or reference (`None` for an unpaired one).
fn candidates(plan: &[ChartPlan], chart: HostChart) -> Vec<Option<Candidate>> {
    for p in plan {
        if p.chart == chart {
            return p.candidates.iter().cloned().map(Some).collect();
        }
        if let Some((reference, refs)) = &p.reference {
            if *reference == chart {
                return refs.clone();
            }
        }
    }
    Vec::new()
}

fn queries(plan: &[ChartPlan], chart: HostChart) -> Vec<String> {
    candidates(plan, chart)
        .into_iter()
        .map(|c| c.map(|c| c.query).unwrap_or_default())
        .collect()
}

fn sources(plan: &[ChartPlan], chart: HostChart) -> Vec<MetricSource> {
    candidates(plan, chart)
        .into_iter()
        .flatten()
        .map(|c| c.source)
        .collect()
}

fn charts(plan: &[ChartPlan]) -> Vec<HostChart> {
    plan.iter()
        .flat_map(|p| std::iter::once(p.chart).chain(p.reference.as_ref().map(|(c, _)| *c)))
        .collect()
}

#[test]
fn cluster_plan_uses_the_issue_queries_and_the_cluster_label() {
    let plan = cluster_plan(None, MetricsRange::Hour);
    assert_eq!(
        queries(&plan, HostChart::Cpu),
        [r#"sum(rate(container_cpu_usage_seconds_total{container!="", pod!=""}[300s]))"#]
    );
    assert_eq!(
        queries(&plan, HostChart::CpuAllocatable),
        [r#"sum(kube_node_status_allocatable{resource="cpu"})"#]
    );
    assert_eq!(
        queries(&plan, HostChart::Memory),
        [r#"sum(container_memory_working_set_bytes{container!="", pod!=""})"#]
    );
    assert_eq!(
        queries(&plan, HostChart::MemoryAllocatable),
        [r#"sum(kube_node_status_allocatable{resource="memory"})"#]
    );
    let shared = cluster_plan(Some(" aks-\"prod\" "), MetricsRange::Week);
    for chart in charts(&shared) {
        let q = &queries(&shared, chart)[0];
        assert!(q.contains(r#"cluster="aks-\"prod\"""#), "{q}");
    }
    // A week's window follows the step (2520 s × 4).
    assert!(queries(&shared, HostChart::Cpu)[0].contains("[10080s]"));
    let blank = cluster_plan(Some("  "), MetricsRange::Hour);
    assert!(charts(&blank)
        .into_iter()
        .all(|c| !queries(&blank, c)[0].contains("cluster=")));
}

#[test]
fn node_plan_prefers_node_exporter_then_cadvisor() {
    let instances = vec!["192.168.49.2:9100".to_string()];
    let plan = node_plan("minikube", &instances, Some("eu"), MetricsRange::Hour);
    assert_eq!(
        charts(&plan),
        [
            HostChart::Cpu,
            HostChart::CpuAllocatable,
            HostChart::Memory,
            HostChart::MemoryAllocatable,
            HostChart::Pods,
            HostChart::NetworkRx,
            HostChart::NetworkTx,
            HostChart::Filesystem,
            HostChart::FilesystemCapacity,
        ]
    );
    assert_eq!(
        sources(&plan, HostChart::Cpu),
        [
            MetricSource::NodeExporter,
            MetricSource::Cadvisor,
            MetricSource::Cadvisor
        ]
    );
    let cpu = queries(&plan, HostChart::Cpu);
    assert_eq!(
        cpu[0],
        r#"sum(rate(node_cpu_seconds_total{instance="192.168.49.2:9100", cluster="eu", mode!~"idle|iowait|steal"}[300s]))"#
    );
    assert_eq!(
        cpu[1],
        r#"sum(rate(container_cpu_usage_seconds_total{node="minikube", cluster="eu", container!="", pod!=""}[300s]))"#
    );
    assert!(
        cpu[2].contains(r#"{instance="minikube", cluster="eu", "#),
        "{}",
        cpu[2]
    );
    let memory = queries(&plan, HostChart::Memory);
    assert!(memory[0].contains("node_memory_MemTotal_bytes{instance=\"192.168.49.2:9100\""));
    assert!(memory[0].contains("node_memory_MemAvailable_bytes"));
    assert!(memory[1].starts_with("sum(container_memory_working_set_bytes{node=\"minikube\""));
    let rx = queries(&plan, HostChart::NetworkRx);
    assert!(rx[0].starts_with("sum(rate(node_network_receive_bytes_total{instance="));
    assert!(rx[0].contains(r#"device!~"lo|veth.*"#));
    assert_eq!(
        rx[1],
        r#"sum(rate(container_network_receive_bytes_total{node="minikube", cluster="eu", pod!=""}[300s]) and on (namespace, pod) kube_pod_info{host_network="false", cluster="eu"})"#,
        "host-network pods see the node's interfaces"
    );
    assert!(queries(&plan, HostChart::NetworkTx)[0].contains("node_network_transmit_bytes_total"));
    let fs = queries(&plan, HostChart::Filesystem);
    assert!(fs[0].contains("node_filesystem_avail_bytes"));
    assert!(fs[0].contains("max by (device)"));
    assert_eq!(
        queries(&plan, HostChart::Pods)[0],
        r#"count(kube_pod_status_phase{phase="Running", cluster="eu"} == 1 and on (namespace, pod) kube_pod_info{node="minikube", cluster="eu"})"#
    );
    assert_eq!(
        sources(&plan, HostChart::Pods),
        [
            MetricSource::KubeStateMetrics,
            MetricSource::Kubelet,
            MetricSource::Kubelet
        ]
    );
    // References pair with the usage's exporter: capacity next to
    // node-exporter, allocatable (or cAdvisor's limit) next to cAdvisor.
    let alloc =
        r#"sum(kube_node_status_allocatable{node="minikube", cluster="eu", resource="cpu"})"#;
    assert_eq!(
        queries(&plan, HostChart::CpuAllocatable),
        [
            r#"count(node_cpu_seconds_total{instance="192.168.49.2:9100", cluster="eu", mode="idle"})"#,
            alloc,
            alloc
        ]
    );
    assert_eq!(
        queries(&plan, HostChart::MemoryAllocatable)[0],
        r#"sum(node_memory_MemTotal_bytes{instance="192.168.49.2:9100", cluster="eu"})"#
    );
    let fs_size = queries(&plan, HostChart::FilesystemCapacity);
    assert!(fs_size[0].starts_with("sum(max by (device) (node_filesystem_size_bytes{instance="));
    assert_eq!(
        fs_size[2],
        r#"sum(container_fs_limit_bytes{instance="minikube", cluster="eu", id="/"})"#
    );
    assert!(candidates(&plan, HostChart::Pods)
        .iter()
        .all(Option::is_some));
}

#[test]
fn node_plan_without_node_exporter_uses_cadvisor_only() {
    let plan = node_plan("minikube", &[], None, MetricsRange::Hour);
    for chart in [
        HostChart::Cpu,
        HostChart::Memory,
        HostChart::NetworkRx,
        HostChart::Filesystem,
    ] {
        assert_eq!(
            sources(&plan, chart),
            [MetricSource::Cadvisor, MetricSource::Cadvisor],
            "{chart:?}"
        );
    }
}

#[test]
fn node_names_and_instances_are_escaped() {
    let plan = node_plan("we\"ird\\node", &[], None, MetricsRange::Hour);
    assert!(queries(&plan, HostChart::Cpu)[0].contains(r#"node="we\"ird\\node""#));
    assert_eq!(
        instance_matcher(&["10.0.0.1:9100".into(), "10.0.0.2:9100".into()]),
        Some(r#"instance=~"10\\.0\\.0\\.1:9100|10\\.0\\.0\\.2:9100""#.to_string())
    );
    assert_eq!(instance_matcher(&[]), None);
    assert_eq!(
        uname_query("n\"1", Some("eu")),
        r#"node_uname_info{nodename="n\"1", cluster="eu"} or node_uname_info{instance="n\"1", cluster="eu"}"#
    );
    assert_eq!(
        node_info_query("minikube", None),
        r#"kube_node_info{node="minikube"}"#
    );
    assert_eq!(
        uname_by_ip_query(&["192.168.49.2".into(), "fd00::1".into()], None),
        r#"node_uname_info{instance=~"\\[?(192\\.168\\.49\\.2|fd00::1)\\]?:[0-9]+"}"#
    );
}

fn series(values: &[Option<f64>]) -> Vec<Series> {
    vec![Series {
        label: String::new(),
        points: values
            .iter()
            .enumerate()
            .map(|(i, v)| (i as f64, *v))
            .collect(),
    }]
}

fn cand(source: MetricSource, q: &str) -> Candidate {
    candidate(source, q.to_string())
}

#[test]
fn settle_picks_the_first_candidate_with_data() {
    let ne = cand(MetricSource::NodeExporter, "ne");
    let cad = cand(MetricSource::Cadvisor, "cad");
    // node-exporter has data: it wins.
    let (data, winner) = settle(
        HostChart::Cpu,
        "ne",
        vec![(ne.clone(), Ok(series(&[Some(1.0)])))],
    );
    assert_eq!(winner, Some(0));
    assert_eq!(data.source, Some(MetricSource::NodeExporter));
    assert_eq!(data.query, "ne");
    // No node-exporter series (or only gaps): cAdvisor.
    let (data, winner) = settle(
        HostChart::Cpu,
        "ne",
        vec![
            (ne.clone(), Ok(series(&[None]))),
            (cad.clone(), Ok(series(&[Some(0.5)]))),
        ],
    );
    assert_eq!(winner, Some(1));
    assert_eq!(data.source, Some(MetricSource::Cadvisor));
    assert_eq!(data.query, "cad");
    assert_eq!(data.error, None);
    // Nothing anywhere: not available, no error, the preferred query.
    let (data, winner) = settle(
        HostChart::Filesystem,
        "ne",
        vec![(ne.clone(), Ok(Vec::new())), (cad.clone(), Ok(Vec::new()))],
    );
    assert_eq!(winner, None);
    assert_eq!(data.source, None);
    assert_eq!(data.query, "ne");
    assert!(data.series.is_empty());
    assert_eq!(data.error, None);
    // One empty, one failing: still "not available" (the data is missing).
    let boom = || PromError::Http {
        status: 422,
        reason: "boom".into(),
    };
    let (data, _) = settle(
        HostChart::Cpu,
        "ne",
        vec![(ne.clone(), Ok(Vec::new())), (cad.clone(), Err(boom()))],
    );
    assert_eq!(data.error, None);
    // Every candidate failed: the first error.
    let (data, _) = settle(
        HostChart::Cpu,
        "ne",
        vec![(ne, Err(boom())), (cad, Err(boom()))],
    );
    assert_eq!(data.error.as_deref(), Some("Prometheus returned 422: boom"));
}

#[test]
fn series_labels_are_distinct_and_non_empty() {
    let data = json!({ "result": [
        { "metric": { "instance": "b:9100" }, "value": [1.0, "1"] },
        { "metric": { "instance": "a:9100" }, "value": [1.0, "1"] },
        { "metric": { "instance": "a:9100" }, "value": [1.0, "1"] },
        { "metric": {}, "value": [1.0, "1"] }
    ] });
    assert_eq!(series_labels(&data, "instance"), ["a:9100", "b:9100"]);
    assert!(series_labels(&json!({}), "instance").is_empty());
}

#[tokio::test]
async fn node_exporter_is_found_through_the_node_internal_ip() {
    let (url, server) = mock_server(vec![
        // The host name does not match the node name.
        vector(json!([])),
        vector(json!([
            { "metric": { "node": "n1", "internal_ip": "10.0.0.7" }, "value": [1.0, "1"] }
        ])),
        vector(json!([
            { "metric": { "instance": "10.0.0.7:9100", "nodename": "ip-10-0-0-7" }, "value": [1.0, "1"] }
        ])),
    ])
    .await;
    let ep = endpoint(&url);
    let conn = connect(None, &ep, &PromAuth::None).await.expect("connect");
    let instances = conn
        .node_exporter_instances("n1", None)
        .await
        .expect("instances");
    assert_eq!(instances, ["10.0.0.7:9100"]);
    let requests = server.await.expect("server");
    assert!(requests[0].contains("node_uname_info%7Bnodename%3D%22n1%22%7D"));
    assert!(requests[1].contains("kube_node_info%7Bnode%3D%22n1%22%7D"));
    assert!(
        requests[2].contains("10%5C%5C.0%5C%5C.0%5C%5C.7"),
        "{}",
        requests[2]
    );
}

#[tokio::test]
async fn no_node_exporter_means_no_instances() {
    let (url, server) = mock_server(vec![vector(json!([])), vector(json!([]))]).await;
    let ep = endpoint(&url);
    let conn = connect(None, &ep, &PromAuth::None).await.expect("connect");
    assert!(conn
        .node_exporter_instances("minikube", None)
        .await
        .expect("instances")
        .is_empty());
    assert_eq!(server.await.expect("server").len(), 2);
}

#[tokio::test]
async fn host_metrics_fall_back_per_chart_and_pair_the_reference() {
    let (url, server) = mock_server(vec![
        matrix(json!([])),
        matrix(json!([{ "metric": {}, "values": [[1.0, "0.4"], [2.0, "0.5"]] }])),
        matrix(json!([{ "metric": {}, "values": [[1.0, "4"]] }])),
    ])
    .await;
    let ep = endpoint(&url);
    let conn = connect(None, &ep, &PromAuth::None).await.expect("connect");
    let plan = vec![ChartPlan::with_reference(
        HostChart::Cpu,
        vec![
            (
                cand(MetricSource::NodeExporter, "ne_query"),
                Some(cand(MetricSource::NodeExporter, "ne_capacity")),
            ),
            (
                cand(MetricSource::Cadvisor, "cad_query"),
                Some(cand(MetricSource::KubeStateMetrics, "ksm_alloc")),
            ),
            (cand(MetricSource::Cadvisor, "never_asked"), None),
        ],
        HostChart::CpuAllocatable,
    )];
    let result = conn
        .host_metrics(plan, MetricsRange::Hour)
        .await
        .expect("metrics");
    assert_eq!(result.end - result.start, 3_600);
    assert_eq!(result.charts.len(), 2);
    assert_eq!(result.charts[0].source, Some(MetricSource::Cadvisor));
    assert_eq!(result.charts[0].query, "cad_query");
    assert_eq!(result.charts[0].series[0].points.len(), 2);
    // The reference of the winner, never node-exporter capacity.
    assert_eq!(result.charts[1].chart, HostChart::CpuAllocatable);
    assert_eq!(
        result.charts[1].source,
        Some(MetricSource::KubeStateMetrics)
    );
    assert_eq!(result.charts[1].query, "ksm_alloc");
    let requests = server.await.expect("server");
    assert_eq!(requests.len(), 3, "stops at the first candidate with data");
    assert!(requests[0].contains("query=ne_query"));
    assert!(requests[2].contains("query=ksm_alloc"));
}

#[tokio::test]
async fn a_winner_without_a_paired_reference_draws_none() {
    let (url, server) = mock_server(vec![matrix(json!([
        { "metric": {}, "values": [[1.0, "1"]] }
    ]))])
    .await;
    let ep = endpoint(&url);
    let conn = connect(None, &ep, &PromAuth::None).await.expect("connect");
    let plan = vec![ChartPlan::with_reference(
        HostChart::Filesystem,
        vec![(cand(MetricSource::Cadvisor, "usage"), None)],
        HostChart::FilesystemCapacity,
    )];
    let result = conn
        .host_metrics(plan, MetricsRange::Hour)
        .await
        .expect("metrics");
    assert_eq!(result.charts[1].source, None);
    assert!(result.charts[1].series.is_empty());
    assert_eq!(result.charts[1].error, None);
    assert_eq!(server.await.expect("server").len(), 1);
}

#[tokio::test]
async fn host_metrics_report_an_unreachable_endpoint_once() {
    let (url, server) = mock_server(vec![(401, "{}".into()), (401, "{}".into())]).await;
    let ep = endpoint(&url);
    let conn = connect(None, &ep, &PromAuth::None).await.expect("connect");
    let plan = vec![
        ChartPlan::usage(
            HostChart::Cpu,
            vec![
                cand(MetricSource::Cadvisor, "a"),
                cand(MetricSource::Cadvisor, "b"),
            ],
        ),
        ChartPlan::usage(HostChart::Memory, vec![cand(MetricSource::Cadvisor, "c")]),
    ];
    let err = conn
        .host_metrics(plan, MetricsRange::Hour)
        .await
        .expect_err("unauthorized");
    assert!(matches!(err, PromError::Http { status: 401, .. }), "{err}");
    // A fatal answer stops a chart's fallbacks.
    assert_eq!(server.await.expect("server").len(), 2);
}
