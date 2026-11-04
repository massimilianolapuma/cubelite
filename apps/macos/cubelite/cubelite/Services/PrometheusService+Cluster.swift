import Foundation

/// The Overview's cluster history and alerts and a node's Metrics section
/// (#530): PrometheusService in the app, a stub in tests.
protocol PrometheusClusterQuerying: Sendable {
    func clusterUsage(context: String, endpoint: PromEndpoint, range: MetricsRange) async throws -> HostMetrics
    func nodeMetrics(context: String, endpoint: PromEndpoint, node: String, range: MetricsRange) async throws
        -> HostMetrics
    func alerts(context: String, endpoint: PromEndpoint) async throws -> PromAlertsResult
    func alertExpression(context: String, endpoint: PromEndpoint, alert: PromAlert) async -> String
}

extension PrometheusService: PrometheusClusterQuerying {

    func clusterUsage(context: String, endpoint: PromEndpoint, range: MetricsRange) async throws -> HostMetrics {
        let session = try await open(context: context, endpoint: endpoint)
        return try await hostMetrics(
            session, plan: HostQueries.clusterPlan(cluster: endpoint.cluster, range: range), range: range)
    }

    func nodeMetrics(context: String, endpoint: PromEndpoint, node: String, range: MetricsRange) async throws
        -> HostMetrics
    {
        let session = try await open(context: context, endpoint: endpoint)
        let instances = try await nodeExporterInstances(session, node: node)
        return try await hostMetrics(
            session,
            plan: HostQueries.nodePlan(node: node, instances: instances, cluster: endpoint.cluster, range: range),
            range: range)
    }

    /// Firing alerts: `/api/v1/alerts`, else the `ALERTS` series. The rules
    /// are not fetched here (about 135 KB on kube-prometheus-stack, where
    /// Watchdog always fires): see `alertExpression`.
    func alerts(context: String, endpoint: PromEndpoint) async throws -> PromAlertsResult {
        let session = try await open(context: context, endpoint: endpoint)
        let cluster = endpoint.cluster
        do {
            let alerts: [PromAlert]
            let source: PromAlertsResult.Source
            do {
                let body = try await get(session, "/api/v1/alerts")
                alerts = try PromAlerts.parseAlertsAPI(Prometheus.unwrapData(body))
                source = .alertsAPI
            } catch let error as PromError where Self.isUnsupported(error) {
                let data = try await query(session, PromAlerts.metricQuery(cluster: cluster))
                alerts = try PromAlerts.parseAlertsMetric(data)
                source = .alertsMetric
            }
            return PromAlertsResult(alerts: PromAlerts.finish(alerts, cluster: cluster), source: source)
        } catch let error as PromError {
            await dropConnection(context: context, session: session, after: error)
            throw error
        }
    }

    /// The alert's rule expression for Open in Grafana, else its `ALERTS`
    /// series. The rules are fetched on the first click and kept for
    /// `PromAlerts.rulesTTL` per context and endpoint (a failed fetch keeps
    /// none, so a broken endpoint is not asked on every click either).
    func alertExpression(context: String, endpoint: PromEndpoint, alert: PromAlert) async -> String {
        let key = "\(context)|\(endpoint)"
        let rules: [PromAlertRule]
        if let cached = ruleCache[key], Date().timeIntervalSince(cached.at) < PromAlerts.rulesTTL {
            rules = cached.rules
        } else {
            var fetched: [PromAlertRule] = []
            if let session = try? await open(context: context, endpoint: endpoint),
                let body = try? await get(session, "/api/v1/rules?type=alert&exclude_alerts=true"),
                let data = try? Prometheus.unwrapData(body)
            {
                fetched = PromAlerts.parseRules(data)
            }
            ruleCache[key] = (Date(), fetched)
            rules = fetched
        }
        return PromAlerts.ruleExpression(alert, rules: rules, cluster: endpoint.cluster)
    }

    /// The alerts endpoint is missing here (not a reachability or
    /// credentials problem): try the `ALERTS` series.
    static func isUnsupported(_ error: PromError) -> Bool {
        switch error {
        case .http(let status, _): status != 401 && status != 403
        case .response: true
        case .connect, .config: false
        }
    }

    /// node-exporter targets of `node` (see `HostQueries`); empty without
    /// node-exporter. Only an unreachable endpoint is an error.
    func nodeExporterInstances(_ session: Session, node: String) async throws -> [String] {
        let cluster = session.endpoint.cluster
        do {
            let data = try await query(session, HostQueries.unameQuery(node: node, cluster: cluster))
            let byName = HostQueries.seriesLabels(data, label: "instance")
            if !byName.isEmpty { return byName }
        } catch let error as PromError where Self.isFatal(error) {
            await dropConnection(context: session.context, session: session, after: error)
            throw error
        } catch {
            // No node-exporter answer: try the internal IP.
        }
        guard
            let info = try? await query(session, HostQueries.nodeInfoQuery(node: node, cluster: cluster))
        else { return [] }
        let ips = HostQueries.seriesLabels(info, label: "internal_ip")
        guard !ips.isEmpty,
            let data = try? await query(session, HostQueries.unameByIPQuery(ips: ips, cluster: cluster))
        else { return [] }
        return HostQueries.seriesLabels(data, label: "instance")
    }

    /// Runs `plan` over the last `range`: charts concurrently, each trying
    /// its candidates in order until one has data, then the reference paired
    /// with the winner.
    func hostMetrics(_ session: Session, plan: [HostChartPlan], range: MetricsRange) async throws -> HostMetrics {
        let step = range.step
        let end = Int(Date().timeIntervalSince1970) / step * step
        let start = end - range.seconds
        typealias Outcome = (charts: [HostChartData], fatal: PromError?)
        let outcomes = await withTaskGroup(of: (Int, Outcome).self) { group in
            for (index, chart) in plan.enumerated() {
                group.addTask {
                    (index, await self.runPlan(session, chart, start: start, end: end, step: step))
                }
            }
            var out = [Outcome?](repeating: nil, count: plan.count)
            for await (index, outcome) in group { out[index] = outcome }
            return out.compactMap { $0 }
        }
        // Cancelled (the view moved on): nothing is wrong with the connection.
        try Task.checkCancellation()
        // Unreachable or rejected credentials are everyone's problem: report them once.
        if !outcomes.isEmpty, outcomes.allSatisfy({ $0.fatal != nil }), let first = outcomes.first?.fatal {
            await dropConnection(context: session.context, session: session, after: first)
            throw first
        }
        return HostMetrics(start: start, end: end, step: step, charts: outcomes.flatMap(\.charts))
    }

    /// A plan's usage chart, then its reference from the winner's pair
    /// (none when the winner has no pair: no line from another exporter).
    private func runPlan(_ session: Session, _ plan: HostChartPlan, start: Int, end: Int, step: Int) async
        -> (charts: [HostChartData], fatal: PromError?)
    {
        let usage = await runChart(session, plan.chart, plan.candidates, start: start, end: end, step: step)
        guard let reference = plan.reference else { return ([usage.data], usage.fatal) }
        let preferred = plan.referenceCandidates.lazy.compactMap { $0?.query }.first ?? ""
        let paired = usage.winner.flatMap { plan.referenceCandidates.indices.contains($0) ? plan.referenceCandidates[$0] : nil }
        guard let paired else {
            let none = HostChartData(
                chart: reference, source: nil, query: preferred, series: [],
                error: usage.fatal?.localizedDescription)
            return ([usage.data, none], usage.fatal)
        }
        let ref = await runChart(session, reference, [paired], start: start, end: end, step: step)
        return ([usage.data, ref.data], usage.fatal)
    }

    /// One chart: candidates in order until one has data; a fatal answer
    /// stops the fallbacks. `fatal` is set when every candidate was fatal.
    // swiftlint:disable:next function_parameter_count
    private func runChart(
        _ session: Session, _ chart: HostChart, _ candidates: [HostCandidate], start: Int, end: Int, step: Int
    ) async -> (data: HostChartData, winner: Int?, fatal: PromError?) {
        var attempts: [(HostCandidate, Result<[MetricSeries], Error>)] = []
        for candidate in candidates {
            let result: Result<[MetricSeries], Error>
            do {
                let data = try await queryRange(session, candidate.query, start: start, end: end, step: step)
                result = .success(try Prometheus.parseSeries(data, labels: []))
            } catch {
                result = .failure(error)
            }
            attempts.append((candidate, result))
            if case .success(let series) = result, HostQueries.hasData(series) { break }
            if case .failure(let error as PromError) = result, Self.isFatal(error) { break }
        }
        let fatal: [PromError] = attempts.compactMap {
            if case .failure(let e as PromError) = $0.1, Self.isFatal(e) { e } else { nil }
        }
        let preferred = candidates.first?.query ?? ""
        let settled = HostQueries.settle(chart, preferred: preferred, attempts: attempts)
        return (
            settled.data, settled.winner,
            !attempts.isEmpty && fatal.count == attempts.count ? fatal.first : nil
        )
    }
}
