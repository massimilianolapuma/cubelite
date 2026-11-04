import Foundation

// Cluster and node history from Prometheus (#530), mirroring
// `crates/cubelite-core/src/prometheus/nodes.rs` with the same test vectors.
//
// Each chart has candidate queries, best first; the first with data wins,
// so every chart picks its own exporter: node-exporter when it scrapes the
// node, else cAdvisor (kubelet) series labelled `node="<n>"`
// (kube-prometheus-stack) or `instance="<n>"` (Azure Monitor).
//
// node-exporter's `instance` is the scrape address, not the node name. It
// is found by `node_uname_info{nodename="<n>"}` (the host name, which is
// the node name unless the kubelet overrides it), else by the node's
// `internal_ip` from `kube_node_info` matched against the address; setups
// that relabel `instance` to the node name match `node_uname_info{instance="<n>"}`.

/// One chart of the cluster or node history.
enum HostChart: String, CaseIterable, Sendable {
    case cpu
    case cpuAllocatable = "cpu-allocatable"
    case memory
    case memoryAllocatable = "memory-allocatable"
    case pods
    case networkRx = "network-rx"
    case networkTx = "network-tx"
    case filesystem
    case filesystemCapacity = "filesystem-capacity"
}

/// Which exporter a chart's data comes from.
enum MetricSource: String, Sendable {
    case nodeExporter = "node-exporter"
    case cadvisor
    case kubeStateMetrics = "kube-state-metrics"
    case kubelet

    /// Display name ("from cAdvisor").
    var displayName: String {
        switch self {
        case .nodeExporter: "node-exporter"
        case .cadvisor: "cAdvisor"
        case .kubeStateMetrics: "kube-state-metrics"
        case .kubelet: "kubelet"
        }
    }
}

/// One way of drawing a chart.
struct HostCandidate: Equatable, Sendable {
    let source: MetricSource
    let query: String
}

/// A chart and its candidates, best first.
struct HostChartPlan: Equatable, Sendable {
    let chart: HostChart
    let candidates: [HostCandidate]
}

struct HostChartData: Equatable, Sendable {
    let chart: HostChart
    /// The exporter that answered; nil when no candidate had data.
    let source: MetricSource?
    /// The PromQL shown (the winning candidate, else the preferred one).
    let query: String
    let series: [MetricSeries]
    /// Why this chart failed, when every candidate failed.
    let error: String?
}

struct HostMetrics: Equatable, Sendable {
    let start: Int
    let end: Int
    let step: Int
    let charts: [HostChartData]

    func data(_ chart: HostChart) -> HostChartData? { charts.first { $0.chart == chart } }
}

enum HostQueries {

    /// Interfaces left out of node traffic: loopback and container networking.
    static let virtualDevices =
        "lo|veth.*|cali.*|cilium.*|lxc.*|cni.*|flannel.*|docker.*|br-.*|virbr.*|vxlan.*|tunl.*|kube-.*"
    /// Filesystems that are not disks.
    static let pseudoFS = "tmpfs|ramfs|overlay|squashfs|nsfs|fuse.*|autofs|devtmpfs"
    private static let containers = #"container!="", pod!="""#

    /// Rate window of host charts: the range's window, at least 5 m.
    static func window(_ range: MetricsRange) -> Int { max(range.window, 300) }

    private static func clusterMatcher(_ cluster: String?) -> String? {
        guard let c = cluster?.trimmingCharacters(in: .whitespaces), !c.isEmpty else { return nil }
        return "cluster=\(Prometheus.escape(c))"
    }

    private static func join(_ matchers: [String?]) -> String {
        matchers.compactMap { $0 }.joined(separator: ", ")
    }

    /// The Overview's cluster CPU and memory against allocatable.
    static func clusterPlan(cluster: String?, range: MetricsRange) -> [HostChartPlan] {
        let c = clusterMatcher(cluster)
        let sel = join([containers, c])
        let w = window(range)
        func allocatable(_ resource: String) -> [HostCandidate] {
            [
                HostCandidate(
                    source: .kubeStateMetrics,
                    query: "sum(kube_node_status_allocatable{\(join([#"resource="\#(resource)""#, c]))})")
            ]
        }
        return [
            HostChartPlan(
                chart: .cpu,
                candidates: [
                    HostCandidate(
                        source: .cadvisor, query: "sum(rate(container_cpu_usage_seconds_total{\(sel)}[\(w)s]))")
                ]),
            HostChartPlan(chart: .cpuAllocatable, candidates: allocatable("cpu")),
            HostChartPlan(
                chart: .memory,
                candidates: [
                    HostCandidate(source: .cadvisor, query: "sum(container_memory_working_set_bytes{\(sel)})")
                ]),
            HostChartPlan(chart: .memoryAllocatable, candidates: allocatable("memory")),
        ]
    }

    /// `instance` matcher of a node's node-exporter targets (nil: none).
    static func instanceMatcher(_ instances: [String]) -> String? {
        switch instances.count {
        case 0: return nil
        case 1: return "instance=\(Prometheus.escape(instances[0]))"
        default:
            return "instance=~\(Prometheus.escape(instances.map(Prometheus.regexLiteral).joined(separator: "|")))"
        }
    }

    /// A node's charts; without `instances` only cAdvisor, kube-state-metrics
    /// and kubelet series.
    static func nodePlan(node: String, instances: [String], cluster: String?, range: MetricsRange)
        -> [HostChartPlan]
    {
        let c = clusterMatcher(cluster)
        let w = window(range)
        let exporter = instanceMatcher(instances).map { join([$0, c]) }
        let kubelet = ["node", "instance"].map { join(["\($0)=\(Prometheus.escape(node))", c]) }
        let byNode = join(["node=\(Prometheus.escape(node))", c])
        let fs = #"fstype!~"\#(pseudoFS)""#

        func plan(
            _ chart: HostChart, exporterQuery: ((String) -> String)?, cadvisor: ((String) -> String)?
        ) -> HostChartPlan {
            var out: [HostCandidate] = []
            if let exporterQuery, let exporter {
                out.append(HostCandidate(source: .nodeExporter, query: exporterQuery(exporter)))
            }
            if let cadvisor { out += kubelet.map { HostCandidate(source: .cadvisor, query: cadvisor($0)) } }
            return HostChartPlan(chart: chart, candidates: out)
        }
        func allocatable(_ chart: HostChart, _ resource: String) -> HostChartPlan {
            HostChartPlan(
                chart: chart,
                candidates: [
                    HostCandidate(
                        source: .kubeStateMetrics,
                        query: #"sum(kube_node_status_allocatable{\#(byNode), resource="\#(resource)"})"#)
                ])
        }
        func network(_ chart: HostChart, _ direction: String) -> HostChartPlan {
            plan(
                chart,
                exporterQuery: {
                    #"sum(rate(node_network_\#(direction)_bytes_total{\#($0), device!~"\#(virtualDevices)"}[\#(w)s]))"#
                },
                cadvisor: { #"sum(rate(container_network_\#(direction)_bytes_total{\#($0), pod!=""}[\#(w)s]))"# })
        }
        let phase = join([#"phase="Running""#, c])
        let pods = HostChartPlan(
            chart: .pods,
            candidates: [
                HostCandidate(
                    source: .kubeStateMetrics,
                    query:
                        "count(kube_pod_status_phase{\(phase)} == 1 and on (namespace, pod) kube_pod_info{\(byNode)})"
                )
            ] + kubelet.map { HostCandidate(source: .kubelet, query: "sum(kubelet_running_pods{\($0)})") })

        return [
            plan(
                .cpu,
                exporterQuery: { #"sum(rate(node_cpu_seconds_total{\#($0), mode!~"idle|iowait|steal"}[\#(w)s]))"# },
                cadvisor: { "sum(rate(container_cpu_usage_seconds_total{\($0), \(containers)}[\(w)s]))" }),
            allocatable(.cpuAllocatable, "cpu"),
            plan(
                .memory,
                exporterQuery: { "sum(node_memory_MemTotal_bytes{\($0)} - node_memory_MemAvailable_bytes{\($0)})" },
                cadvisor: { "sum(container_memory_working_set_bytes{\($0), \(containers)})" }),
            allocatable(.memoryAllocatable, "memory"),
            pods,
            network(.networkRx, "receive"),
            network(.networkTx, "transmit"),
            plan(
                .filesystem,
                exporterQuery: {
                    "sum(max by (device) (node_filesystem_size_bytes{\($0), \(fs)} - node_filesystem_avail_bytes{\($0), \(fs)}))"
                },
                cadvisor: { #"sum(container_fs_usage_bytes{\#($0), id="/"})"# }),
            plan(
                .filesystemCapacity,
                exporterQuery: { "sum(max by (device) (node_filesystem_size_bytes{\($0), \(fs)}))" },
                cadvisor: { #"sum(container_fs_limit_bytes{\#($0), id="/"})"# }),
        ]
    }

    /// node-exporter series of the node, by host name or by an `instance`
    /// relabelled to the node name.
    static func unameQuery(node: String, cluster: String?) -> String {
        let c = clusterMatcher(cluster)
        func by(_ label: String) -> String { join(["\(label)=\(Prometheus.escape(node))", c]) }
        return "node_uname_info{\(by("nodename"))} or node_uname_info{\(by("instance"))}"
    }

    /// The node's `kube_node_info` (its `internal_ip`).
    static func nodeInfoQuery(node: String, cluster: String?) -> String {
        "kube_node_info{\(join(["node=\(Prometheus.escape(node))", clusterMatcher(cluster)]))}"
    }

    /// node-exporter series scraped at one of `ips` (any port; IPv6 in brackets).
    static func unameByIPQuery(ips: [String], cluster: String?) -> String {
        let pattern = #"\[?("# + ips.map(Prometheus.regexLiteral).joined(separator: "|") + #")\]?:[0-9]+"#
        return "node_uname_info{\(join(["instance=~\(Prometheus.escape(pattern))", clusterMatcher(cluster)]))}"
    }

    /// Distinct non-empty values of `label` in a vector or matrix result.
    static func seriesLabels(_ data: JSONValue, label: String) -> [String] {
        let values = (try? Prometheus.parseSeries(data, labels: [label]))?.map(\.label) ?? []
        return Array(Set(values.filter { !$0.isEmpty })).sorted()
    }

    /// Whether a series list has at least one value.
    static func hasData(_ series: [MetricSeries]) -> Bool {
        series.contains { $0.points.contains { $0.value != nil } }
    }

    /// A chart from its tried candidates (in order): the first with data
    /// wins; with none the chart is "not available", unless every candidate
    /// failed, in which case it carries the first error.
    static func settle(
        _ chart: HostChart, preferred: String, attempts: [(HostCandidate, Result<[MetricSeries], Error>)]
    ) -> HostChartData {
        var firstError: Error?
        var answered = false
        for (candidate, result) in attempts {
            switch result {
            case .success(let series) where hasData(series):
                return HostChartData(
                    chart: chart, source: candidate.source, query: candidate.query, series: series, error: nil)
            case .success:
                answered = true
            case .failure(let error):
                if firstError == nil { firstError = error }
            }
        }
        return HostChartData(
            chart: chart, source: nil, query: preferred, series: [],
            error: answered ? nil : firstError?.localizedDescription)
    }
}
