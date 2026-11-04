//! Cluster and node history from Prometheus (#530): the Overview's cluster
//! CPU and memory next to the metrics-server meters, and a node's Metrics
//! section (CPU, memory, pods running, network, filesystem).
//!
//! Each chart has **candidate queries** in order of preference. The first
//! one that returns series wins, so every chart picks its own exporter:
//! node-exporter when it scrapes the node, else cAdvisor (kubelet) series
//! labelled `node="<n>"` (kube-prometheus-stack) or `instance="<n>"`
//! (Azure Monitor), else nothing ("not available" in the UI).
//!
//! **Finding the node-exporter of a node.** Its `instance` label is the
//! scrape address (`10.0.1.2:9100`), not the node name. The robust key is
//! `node_uname_info{nodename="<n>"}`: node-exporter reports the host name,
//! which is the node name unless the kubelet overrides it. When it does not
//! match, the node's `internal_ip` from `kube_node_info` (kube-state-metrics)
//! is matched against the instance address. Setups that relabel `instance`
//! to the node name are covered by `node_uname_info{instance="<n>"}`.
//! The charts then select `instance="…"` — readable in Grafana, and cheap.
//!
//! **Reference lines come from the usage's exporter.** A chart's reference
//! (CPU and memory capacity, filesystem size) is paired with each usage
//! candidate, so the line drawn next to node-exporter usage is node-exporter
//! capacity, and next to cAdvisor usage kube-state-metrics allocatable or
//! cAdvisor's filesystem limit. No pair for the winner: no reference line.

use futures::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::transport::PromConnection;
use super::{escape, parse_series, regex_literal, MetricsRange, PromEndpoint, PromError, Series};

/// One chart of the cluster or node history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostChart {
    /// CPU in use (cores).
    Cpu,
    /// The CPU reference line (cores): allocatable from kube-state-metrics
    /// next to cAdvisor usage, capacity next to node-exporter usage.
    CpuAllocatable,
    /// Memory in use (bytes).
    Memory,
    /// The memory reference line (bytes): allocatable or capacity, as for CPU.
    MemoryAllocatable,
    /// Pods running on the node.
    Pods,
    /// Received bytes per second.
    NetworkRx,
    /// Transmitted bytes per second.
    NetworkTx,
    /// Filesystem bytes in use.
    Filesystem,
    /// Filesystem size (bytes), the reference line, from the usage's exporter.
    FilesystemCapacity,
}

/// Which exporter a chart's data comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MetricSource {
    /// node-exporter (`node_*`).
    NodeExporter,
    /// cAdvisor through the kubelet (`container_*`).
    Cadvisor,
    /// kube-state-metrics (`kube_*`).
    KubeStateMetrics,
    /// The kubelet's own metrics (`kubelet_*`).
    Kubelet,
}

/// One way of drawing a chart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// Exporter the query needs.
    pub source: MetricSource,
    /// PromQL.
    pub query: String,
}

/// A chart, its candidates (best first) and its reference line, whose
/// candidates pair with the usage ones by index (`None`: no reference for
/// that usage candidate).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChartPlan {
    /// The usage chart.
    pub chart: HostChart,
    /// Its candidates, best first.
    pub candidates: Vec<Candidate>,
    /// The reference chart and one optional candidate per usage candidate.
    pub reference: Option<(HostChart, Vec<Option<Candidate>>)>,
}

impl ChartPlan {
    fn usage(chart: HostChart, candidates: Vec<Candidate>) -> Self {
        Self {
            chart,
            candidates,
            reference: None,
        }
    }

    fn with_reference(
        chart: HostChart,
        pairs: Vec<(Candidate, Option<Candidate>)>,
        reference: HostChart,
    ) -> Self {
        let (candidates, refs) = pairs.into_iter().unzip();
        Self {
            chart,
            candidates,
            reference: Some((reference, refs)),
        }
    }
}

/// One chart's data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostChartData {
    /// Which chart.
    pub chart: HostChart,
    /// The exporter that answered; `None` when no candidate had data.
    pub source: Option<MetricSource>,
    /// The PromQL shown (the winning candidate, else the preferred one).
    pub query: String,
    /// Lines (one, summed); empty when not available.
    pub series: Vec<Series>,
    /// Why this chart failed, when every candidate failed.
    pub error: Option<String>,
}

/// The cluster or node history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMetrics {
    /// Range start (unix seconds).
    pub start: u64,
    /// Range end (unix seconds).
    pub end: u64,
    /// Step (seconds).
    pub step: u64,
    /// Charts in plan order.
    pub charts: Vec<HostChartData>,
}

/// Interfaces left out of node network traffic: loopback and the virtual
/// ones of container networking (pod veths would count traffic twice).
const VIRTUAL_DEVICES: &str =
    "lo|veth.*|cali.*|cilium.*|lxc.*|cni.*|flannel.*|docker.*|br-.*|virbr.*|vxlan.*|tunl.*|kube-.*";
/// Filesystems that are not disks.
const PSEUDO_FS: &str = "tmpfs|ramfs|overlay|squashfs|nsfs|fuse.*|autofs|devtmpfs";
/// cAdvisor series of containers (not the pod sandbox, not cgroup totals).
const CONTAINERS: &str = r#"container!="", pod!="""#;

/// Rate window of host charts: the range's window, at least 5 m.
pub fn host_window(range: MetricsRange) -> u64 {
    range.window().max(300)
}

/// `cluster="…"` when the endpoint has a cluster label.
fn cluster_matcher(cluster: Option<&str>) -> Option<String> {
    cluster
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(|c| format!("cluster={}", escape(c)))
}

/// Joins matchers, skipping the absent ones.
fn join(matchers: &[Option<String>]) -> String {
    matchers
        .iter()
        .flatten()
        .cloned()
        .collect::<Vec<_>>()
        .join(", ")
}

fn candidate(source: MetricSource, query: String) -> Candidate {
    Candidate { source, query }
}

type Make<'a> = &'a dyn Fn(&str) -> String;
type MakeRef<'a> = &'a dyn Fn(&str) -> Option<Candidate>;

/// Usage candidates for the node-exporter selector (if any) then each
/// cAdvisor selector, each paired with its reference.
fn pair_candidates(
    ne: Option<&str>,
    kubelet: &[String],
    exporter: Make,
    exporter_ref: MakeRef,
    cadvisor: Make,
    cadvisor_ref: MakeRef,
) -> Vec<(Candidate, Option<Candidate>)> {
    let ne_pairs = ne.into_iter().map(|sel| {
        (
            candidate(MetricSource::NodeExporter, exporter(sel)),
            exporter_ref(sel),
        )
    });
    let cad_pairs = kubelet.iter().map(|sel| {
        (
            candidate(MetricSource::Cadvisor, cadvisor(sel)),
            cadvisor_ref(sel),
        )
    });
    ne_pairs.chain(cad_pairs).collect()
}

/// A node-exporter reference candidate for each node-exporter selector.
fn exporter_ref(make: fn(&str) -> String) -> impl Fn(&str) -> Option<Candidate> {
    move |sel| Some(candidate(MetricSource::NodeExporter, make(sel)))
}

/// The Overview's cluster CPU and memory against allocatable.
pub fn cluster_plan(cluster: Option<&str>, range: MetricsRange) -> Vec<ChartPlan> {
    let c = cluster_matcher(cluster);
    let containers = join(&[Some(CONTAINERS.to_string()), c.clone()]);
    let w = host_window(range);
    let allocatable = |resource: &str| {
        let sel = join(&[Some(format!(r#"resource="{resource}""#)), c.clone()]);
        Some(candidate(
            MetricSource::KubeStateMetrics,
            format!("sum(kube_node_status_allocatable{{{sel}}})"),
        ))
    };
    let usage = |query: String| candidate(MetricSource::Cadvisor, query);
    vec![
        ChartPlan::with_reference(
            HostChart::Cpu,
            vec![(
                usage(format!(
                    "sum(rate(container_cpu_usage_seconds_total{{{containers}}}[{w}s]))"
                )),
                allocatable("cpu"),
            )],
            HostChart::CpuAllocatable,
        ),
        ChartPlan::with_reference(
            HostChart::Memory,
            vec![(
                usage(format!(
                    "sum(container_memory_working_set_bytes{{{containers}}})"
                )),
                allocatable("memory"),
            )],
            HostChart::MemoryAllocatable,
        ),
    ]
}

/// `instance` matcher of a node's node-exporter targets (none: no
/// node-exporter for this node).
pub fn instance_matcher(instances: &[String]) -> Option<String> {
    match instances {
        [] => None,
        [one] => Some(format!("instance={}", escape(one))),
        many => {
            let alternatives: Vec<String> = many.iter().map(|i| regex_literal(i)).collect();
            Some(format!("instance=~{}", escape(&alternatives.join("|"))))
        }
    }
}

/// A node's charts. `instances` are its node-exporter targets
/// ([`PromConnection::node_exporter_instances`]); without them the charts
/// use cAdvisor, kube-state-metrics and kubelet series only.
pub fn node_plan(
    node: &str,
    instances: &[String],
    cluster: Option<&str>,
    range: MetricsRange,
) -> Vec<ChartPlan> {
    let c = cluster_matcher(cluster);
    let w = host_window(range);
    let ne = instance_matcher(instances).map(|i| join(&[Some(i), c.clone()]));
    // cAdvisor and kubelet series: `node` (kube-prometheus-stack), else
    // `instance` holding the node name (Azure Monitor).
    let kubelet: Vec<String> = ["node", "instance"]
        .iter()
        .map(|label| join(&[Some(format!("{label}={}", escape(node))), c.clone()]))
        .collect();
    let by_node = join(&[Some(format!("node={}", escape(node))), c.clone()]);
    // Pods on the host network see the node's interfaces: leave them out.
    let pod_network = join(&[Some(r#"host_network="false""#.to_string()), c.clone()]);

    // Usage candidates (node-exporter first, then cAdvisor by `node` and
    // `instance`), each with its paired reference.
    let usage_only = |exporter: Make, cadvisor: Make| {
        pair_candidates(
            ne.as_deref(),
            &kubelet,
            exporter,
            &|_| None,
            cadvisor,
            &|_| None,
        )
        .into_iter()
        .map(|(c, _)| c)
        .collect::<Vec<_>>()
    };
    let allocatable = |resource: &str| {
        Some(candidate(
            MetricSource::KubeStateMetrics,
            format!(r#"sum(kube_node_status_allocatable{{{by_node}, resource="{resource}"}})"#),
        ))
    };
    let fs = format!(r#"fstype!~"{PSEUDO_FS}""#);
    let network = |direction: &str| {
        usage_only(
            &|sel| {
                format!(
                    r#"sum(rate(node_network_{direction}_bytes_total{{{sel}, device!~"{VIRTUAL_DEVICES}"}}[{w}s]))"#
                )
            },
            &|sel| {
                format!(
                    r#"sum(rate(container_network_{direction}_bytes_total{{{sel}, pod!=""}}[{w}s]) and on (namespace, pod) kube_pod_info{{{pod_network}}})"#
                )
            },
        )
    };
    let pods_ksm = {
        let phase = join(&[Some(r#"phase="Running""#.to_string()), c.clone()]);
        candidate(
            MetricSource::KubeStateMetrics,
            format!(
                "count(kube_pod_status_phase{{{phase}}} == 1 and on (namespace, pod) kube_pod_info{{{by_node}}})"
            ),
        )
    };
    let pods_kubelet = kubelet.iter().map(|sel| {
        candidate(
            MetricSource::Kubelet,
            format!("sum(kubelet_running_pods{{{sel}}})"),
        )
    });
    let cpu_capacity: fn(&str) -> String =
        |sel| format!(r#"count(node_cpu_seconds_total{{{sel}, mode="idle"}})"#);
    let memory_capacity: fn(&str) -> String =
        |sel| format!("sum(node_memory_MemTotal_bytes{{{sel}}})");
    let fs_size: fn(&str) -> String = |sel| {
        format!(
            r#"sum(max by (device) (node_filesystem_size_bytes{{{sel}, fstype!~"{PSEUDO_FS}"}}))"#
        )
    };

    vec![
        ChartPlan::with_reference(
            HostChart::Cpu,
            pair_candidates(
                ne.as_deref(),
                &kubelet,
                &|sel| {
                    format!(
                        r#"sum(rate(node_cpu_seconds_total{{{sel}, mode!~"idle|iowait|steal"}}[{w}s]))"#
                    )
                },
                &exporter_ref(cpu_capacity),
                &|sel| {
                    format!(
                        "sum(rate(container_cpu_usage_seconds_total{{{sel}, {CONTAINERS}}}[{w}s]))"
                    )
                },
                &|_| allocatable("cpu"),
            ),
            HostChart::CpuAllocatable,
        ),
        ChartPlan::with_reference(
            HostChart::Memory,
            pair_candidates(
                ne.as_deref(),
                &kubelet,
                &|sel| {
                    format!(
                        "sum(node_memory_MemTotal_bytes{{{sel}}} - node_memory_MemAvailable_bytes{{{sel}}})"
                    )
                },
                &exporter_ref(memory_capacity),
                &|sel| format!("sum(container_memory_working_set_bytes{{{sel}, {CONTAINERS}}})"),
                &|_| allocatable("memory"),
            ),
            HostChart::MemoryAllocatable,
        ),
        ChartPlan::usage(
            HostChart::Pods,
            std::iter::once(pods_ksm).chain(pods_kubelet).collect(),
        ),
        ChartPlan::usage(HostChart::NetworkRx, network("receive")),
        ChartPlan::usage(HostChart::NetworkTx, network("transmit")),
        ChartPlan::with_reference(
            HostChart::Filesystem,
            pair_candidates(
                ne.as_deref(),
                &kubelet,
                &|sel| {
                    format!(
                        "sum(max by (device) (node_filesystem_size_bytes{{{sel}, {fs}}} - node_filesystem_avail_bytes{{{sel}, {fs}}}))"
                    )
                },
                &exporter_ref(fs_size),
                &|sel| format!(r#"sum(container_fs_usage_bytes{{{sel}, id="/"}})"#),
                &|sel| {
                    Some(candidate(
                        MetricSource::Cadvisor,
                        format!(r#"sum(container_fs_limit_bytes{{{sel}, id="/"}})"#),
                    ))
                },
            ),
            HostChart::FilesystemCapacity,
        ),
    ]
}

/// node-exporter series of the node, by host name or by an `instance`
/// relabelled to the node name.
pub fn uname_query(node: &str, cluster: Option<&str>) -> String {
    let c = cluster_matcher(cluster);
    let by = |label: &str| join(&[Some(format!("{label}={}", escape(node))), c.clone()]);
    format!(
        "node_uname_info{{{}}} or node_uname_info{{{}}}",
        by("nodename"),
        by("instance")
    )
}

/// The node's `kube_node_info` (its `internal_ip`).
pub fn node_info_query(node: &str, cluster: Option<&str>) -> String {
    let sel = join(&[
        Some(format!("node={}", escape(node))),
        cluster_matcher(cluster),
    ]);
    format!("kube_node_info{{{sel}}}")
}

/// node-exporter series scraped at one of `ips` (any port; IPv6 in brackets).
pub fn uname_by_ip_query(ips: &[String], cluster: Option<&str>) -> String {
    let alternatives: Vec<String> = ips.iter().map(|ip| regex_literal(ip)).collect();
    let pattern = format!(r"\[?({})\]?:[0-9]+", alternatives.join("|"));
    let sel = join(&[
        Some(format!("instance=~{}", escape(&pattern))),
        cluster_matcher(cluster),
    ]);
    format!("node_uname_info{{{sel}}}")
}

/// Distinct non-empty values of `label` in a vector or matrix result.
pub fn series_labels(data: &Value, label: &str) -> Vec<String> {
    let mut values: Vec<String> = parse_series(data, &[label])
        .map(|s| s.into_iter().map(|s| s.label).collect())
        .unwrap_or_default();
    values.retain(|v| !v.is_empty());
    values.sort();
    values.dedup();
    values
}

/// A chart from its tried candidates (in order): the first with series
/// wins (its index is returned, to pick the paired reference); with none,
/// the chart is "not available" unless every candidate failed, in which
/// case it carries the first error.
pub fn settle(
    chart: HostChart,
    preferred: &str,
    attempts: Vec<(Candidate, Result<Vec<Series>, PromError>)>,
) -> (HostChartData, Option<usize>) {
    let mut first_error = None;
    let mut any_answer = false;
    for (index, (candidate, result)) in attempts.into_iter().enumerate() {
        match result {
            Ok(series) if has_data(&series) => {
                return (
                    HostChartData {
                        chart,
                        source: Some(candidate.source),
                        query: candidate.query,
                        series,
                        error: None,
                    },
                    Some(index),
                )
            }
            Ok(_) => any_answer = true,
            Err(e) => {
                first_error.get_or_insert(e);
            }
        }
    }
    let data = HostChartData {
        chart,
        source: None,
        query: preferred.to_string(),
        series: Vec::new(),
        error: if any_answer {
            None
        } else {
            first_error.map(|e| e.to_string())
        },
    };
    (data, None)
}

/// Whether any series has a value.
fn has_data(series: &[Series]) -> bool {
    series
        .iter()
        .any(|s| s.points.iter().any(|p| p.1.is_some()))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Unreachable endpoint or rejected credentials.
fn fatal(e: &PromError) -> bool {
    matches!(
        e,
        PromError::Connect(_)
            | PromError::Http {
                status: 401 | 403,
                ..
            }
    )
}

impl PromConnection {
    /// node-exporter targets of `node` (see the module docs); empty when
    /// node-exporter does not scrape it. Only an unreachable endpoint is an
    /// error.
    pub async fn node_exporter_instances(
        &self,
        node: &str,
        cluster: Option<&str>,
    ) -> Result<Vec<String>, PromError> {
        let by_name = match self.query(&uname_query(node, cluster)).await {
            Ok(data) => series_labels(&data, "instance"),
            Err(e) if fatal(&e) => return Err(e),
            Err(_) => Vec::new(),
        };
        if !by_name.is_empty() {
            return Ok(by_name);
        }
        let ips = match self.query(&node_info_query(node, cluster)).await {
            Ok(data) => series_labels(&data, "internal_ip"),
            Err(_) => Vec::new(),
        };
        if ips.is_empty() {
            return Ok(Vec::new());
        }
        Ok(match self.query(&uname_by_ip_query(&ips, cluster)).await {
            Ok(data) => series_labels(&data, "instance"),
            Err(_) => Vec::new(),
        })
    }

    /// Tries `candidates` in order until one has data; stops at a fatal
    /// answer. `Err` when every candidate was unreachable or rejected.
    async fn run_chart(
        &self,
        chart: HostChart,
        candidates: Vec<Candidate>,
        (start, end, step): (u64, u64, u64),
    ) -> Result<(HostChartData, Option<usize>), PromError> {
        let preferred = candidates
            .first()
            .map(|c| c.query.clone())
            .unwrap_or_default();
        let mut attempts = Vec::new();
        for candidate in candidates {
            let result = self
                .query_range(&candidate.query, start, end, step)
                .await
                .and_then(|data| parse_series(&data, &[]));
            let stop =
                result.as_ref().is_ok_and(|s| has_data(s)) || result.as_ref().is_err_and(fatal);
            attempts.push((candidate, result));
            if stop {
                break;
            }
        }
        if !attempts.is_empty() && attempts.iter().all(|(_, r)| r.as_ref().is_err_and(fatal)) {
            if let Some((_, Err(e))) = attempts.into_iter().next() {
                return Err(e);
            }
            return Err(PromError::Response("no charts".to_string()));
        }
        Ok(settle(chart, &preferred, attempts))
    }

    /// One plan: its usage chart, then the reference paired with the
    /// winning candidate (nothing when it has none).
    async fn run_plan(
        &self,
        plan: ChartPlan,
        window: (u64, u64, u64),
    ) -> Result<Vec<HostChartData>, (Vec<HostChartData>, PromError)> {
        let failed = |chart: HostChart, query: String, e: &PromError| HostChartData {
            chart,
            source: None,
            query,
            series: Vec::new(),
            error: Some(e.to_string()),
        };
        let preferred = plan
            .candidates
            .first()
            .map(|c| c.query.clone())
            .unwrap_or_default();
        let ref_preferred = |refs: &[Option<Candidate>]| {
            refs.iter()
                .flatten()
                .next()
                .map(|c| c.query.clone())
                .unwrap_or_default()
        };
        let (usage, winner) = match self.run_chart(plan.chart, plan.candidates, window).await {
            Ok(done) => done,
            Err(e) => {
                let mut charts = vec![failed(plan.chart, preferred, &e)];
                if let Some((chart, refs)) = &plan.reference {
                    charts.push(failed(*chart, ref_preferred(refs), &e));
                }
                return Err((charts, e));
            }
        };
        let mut charts = vec![usage];
        if let Some((chart, refs)) = plan.reference {
            let paired = winner.and_then(|i| refs.get(i).cloned().flatten());
            let data = match paired {
                Some(c) => match self.run_chart(chart, vec![c.clone()], window).await {
                    Ok((data, _)) => data,
                    Err(e) => failed(chart, c.query, &e),
                },
                None => settle(chart, &ref_preferred(&refs), Vec::new()).0,
            };
            charts.push(data);
        }
        Ok(charts)
    }

    /// Runs `plan` over the last `range`: charts concurrently, each trying
    /// its candidates in order until one has data, then its reference.
    pub async fn host_metrics(
        &self,
        plan: Vec<ChartPlan>,
        range: MetricsRange,
    ) -> Result<HostMetrics, PromError> {
        let step = range.step();
        let end = now_secs() / step * step;
        let start = end.saturating_sub(range.seconds());
        let results = join_all(
            plan.into_iter()
                .map(|p| self.run_plan(p, (start, end, step))),
        )
        .await;
        // Unreachable or rejected credentials are everyone's problem:
        // report them once (the caller then drops the connection).
        if results.iter().all(Result::is_err) {
            if let Some(Err((_, e))) = results.into_iter().next() {
                return Err(e);
            }
            return Err(PromError::Response("no charts".to_string()));
        }
        let charts = results
            .into_iter()
            .flat_map(|r| r.unwrap_or_else(|(charts, _)| charts))
            .collect();
        Ok(HostMetrics {
            start,
            end,
            step,
            charts,
        })
    }

    /// The Overview's cluster CPU and memory history.
    pub async fn cluster_usage(
        &self,
        endpoint: &PromEndpoint,
        range: MetricsRange,
    ) -> Result<HostMetrics, PromError> {
        self.host_metrics(cluster_plan(endpoint.cluster.as_deref(), range), range)
            .await
    }

    /// A node's Metrics section.
    pub async fn node_metrics(
        &self,
        endpoint: &PromEndpoint,
        node: &str,
        range: MetricsRange,
    ) -> Result<HostMetrics, PromError> {
        let cluster = endpoint.cluster.as_deref();
        let instances = self.node_exporter_instances(node, cluster).await?;
        self.host_metrics(node_plan(node, &instances, cluster, range), range)
            .await
    }
}

#[cfg(test)]
mod tests;
