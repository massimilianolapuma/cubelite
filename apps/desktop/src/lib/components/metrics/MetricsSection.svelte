<script lang="ts">
	import { EMPTY } from '#lib/empty.ts';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Loading from '#lib/components/ui/Loading.svelte';
	import LineChart from '#lib/components/metrics/LineChart.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import PrometheusHint from '#lib/components/metrics/PrometheusHint.svelte';
	import { observeOnce } from '#lib/in-view.ts';
	import { LatestLoad } from '#lib/latest-load.svelte.ts';
	import {
		METRICS_HINT,
		canOpenGrafana as canOpenGrafanaUi,
		openGrafanaQueries,
		showsIntegrationHint
	} from '#lib/integration-links.ts';
	import { settings } from '#lib/stores/settings.svelte.ts';
	import {
		METRICS_RANGES,
		chartData,
		formatValue,
		latest,
		latestTotal,
		REFERENCE_COLOR,
		seriesStyle,
		sumPoints,
		type ChartLine,
		type Unit
	} from '#lib/metrics.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { prometheus } from '#lib/stores/prometheus.svelte.ts';
	import {
		prometheusMetrics,
		type Chart,
		type MetricsRange,
		type MetricsResult,
		type Series,
		type Workload
	} from '#lib/tauri.ts';

	// Metrics section of a pod or deployment drawer (#510, spec §5.1): the
	// recent history from Prometheus; only rendered when the context has a
	// Prometheus endpoint. Loads when it scrolls into view.
	let { namespace, workload }: { namespace: string; workload: Workload } = $props();

	const endpoint = $derived(prometheus.active);
	let range = $state<MetricsRange>('1h');
	let split = $state<'container' | 'total'>('container');
	const perContainer = $derived(split === 'container');
	let visible = $state(false);
	const metrics = new LatestLoad<MetricsResult, MetricsRange>('1h');
	const loading = $derived(metrics.loading);
	const error = $derived(metrics.error);
	const result = $derived(metrics.result);
	/** Range of `result` (the selection may already be another one). */
	const resultRange = $derived(metrics.args);
	let root = $state<HTMLElement | null>(null);

	$effect(() => (root ? observeOnce(root, () => (visible = true)) : undefined));

	$effect(() => {
		const context = app.activeCluster;
		const ep = endpoint;
		const request = { namespace, workload, range, perContainer };
		// Another pod in the same drawer: never show the previous one's charts.
		metrics.subject(`${context}|${namespace}|${workload.kind}/${workload.name}`);
		if (!visible || !context || !ep) return;
		void metrics.run(request.range, () => prometheusMetrics(app.kubeconfigPath, context, ep, request));
	});

	const series = (chart: Chart): Series[] => (result ? (chartData(result.charts, chart)?.series ?? []) : []);
	const chartError = (...charts: Chart[]): string | null =>
		result ? (charts.map((c) => chartData(result!.charts, c)?.error).find((e) => e) ?? null) : null;

	/** Usage lines per container plus dashed request and limit totals. */
	function usageLines(usage: Chart, request: Chart, limit: Chart): ChartLine[] {
		const lines: ChartLine[] = series(usage).map((s, i) => ({
			label: s.label,
			...seriesStyle(i),
			points: s.points
		}));
		for (const [chart, label] of [
			[request, 'request'],
			[limit, 'limit']
		] as const) {
			const ref = series(chart);
			if (ref.length > 0) {
				lines.push({
					label,
					color: REFERENCE_COLOR,
					points: sumPoints(ref.map((s) => s.points)),
					dashed: true
				});
			}
		}
		return lines;
	}

	function usageSummary(usage: Chart, request: Chart, limit: Chart, unit: Unit): string {
		const parts: string[] = [];
		const now = latestTotal(series(usage));
		parts.push(now === null ? EMPTY : formatValue(now, unit));
		const req = latestTotal(series(request));
		if (req !== null) parts.push(`req ${formatValue(req, unit)}`);
		const lim = latestTotal(series(limit));
		if (lim !== null) parts.push(`lim ${formatValue(lim, unit)}`);
		return parts.join(' / ');
	}

	const cpuLines = $derived(result ? usageLines('cpu', 'cpu-request', 'cpu-limit') : []);
	const memoryLines = $derived(result ? usageLines('memory', 'memory-request', 'memory-limit') : []);
	const restartLines = $derived(
		series('restarts').map((s, i) => ({ label: s.label, ...seriesStyle(i), points: s.points }))
	);
	const networkLines = $derived<ChartLine[]>([
		...series('network-rx').map((s) => ({ label: 'rx', ...seriesStyle(0), points: s.points })),
		...series('network-tx').map((s) => ({ label: 'tx', ...seriesStyle(1), points: s.points }))
	]);
	const networkSummary = $derived.by(() => {
		const rx = series('network-rx')[0];
		const tx = series('network-tx')[0];
		const fmt = (s: Series | undefined) => {
			const v = s ? latest(s.points) : null;
			return v === null ? EMPTY : formatValue(v, 'bytes-per-second');
		};
		return `↓ ${fmt(rx)} ↑ ${fmt(tx)}`;
	});

	// A configured URL wins; else an in-cluster Grafana through a port-forward (#525).
	const canOpenGrafana = $derived(canOpenGrafanaUi(endpoint));
	// Without Prometheus, a compact placeholder tells what the section would show (#526).
	const hint = $derived(showsIntegrationHint(endpoint, settings.integrationHints.value));

	async function grafana(...charts: Chart[]) {
		const ep = endpoint;
		const data = result;
		if (!ep || !data) return;
		const queries = charts.map((c) => chartData(data.charts, c)?.query).filter((q): q is string => !!q);
		await openGrafanaQueries(ep, queries, resultRange);
	}

	const onGrafana = (...charts: Chart[]) => (canOpenGrafana && result ? () => void grafana(...charts) : undefined);
	const ALL: Chart[] = [
		'cpu',
		'cpu-request',
		'cpu-limit',
		'memory',
		'memory-request',
		'memory-limit',
		'restarts',
		'restarts-total',
		'network-rx',
		'network-tx'
	];
	const restartsTotal = $derived.by(() => {
		const total = series('restarts-total')[0];
		const value = total ? latest(total.points) : null;
		return value === null ? EMPTY : `${Math.round(value)} in range`;
	});
	const emptyCadvisor = 'no data: needs cAdvisor metrics in Prometheus';
	const emptyKsm = 'no data: needs kube-state-metrics in Prometheus';
</script>

{#if endpoint}
	<div bind:this={root} data-testid="metrics-section">
		<div class="mb-2 flex flex-wrap items-center gap-2">
			<span class="type-label text-text-muted">Metrics</span>
			<!-- Always in place, so the controls never move; the body says it on a first load. -->
			<Loading label="Loading metrics" active={loading} words={!!result} />
			<span class="ml-auto"></span>
			<SegmentedControl segments={METRICS_RANGES} bind:value={range} label="Metrics range" />
			<SegmentedControl
				segments={[
					{ value: 'container', label: 'per container' },
					{ value: 'total', label: 'total' }
				]}
				bind:value={split}
				label="Per container or total"
			/>
			{#if canOpenGrafana && result}
				<Button variant="text" size="inline" onclick={() => void grafana(...ALL)}>
					{#snippet icon()}<ExternalLink class="h-3.5 w-3.5" aria-hidden="true" />{/snippet}
					Grafana
				</Button>
			{/if}
		</div>
		{#if error}
			<p class="type-body-sm flex items-start gap-1.5 text-text" role="alert">
				<StatusGlyph state="err" class="mt-1 text-error" />
				{error}
			</p>
		{:else if result}
			<div class="flex flex-col gap-2">
				<LineChart
					title="CPU"
					unit="cores"
					summary={usageSummary('cpu', 'cpu-request', 'cpu-limit', 'cores')}
					lines={cpuLines}
					start={result.start}
					end={result.end}
					range={resultRange}
					error={chartError('cpu')}
					emptyText={emptyCadvisor}
					onGrafana={onGrafana('cpu', 'cpu-request', 'cpu-limit')}
				/>
				<LineChart
					title="Memory"
					unit="bytes"
					summary={usageSummary('memory', 'memory-request', 'memory-limit', 'bytes')}
					lines={memoryLines}
					start={result.start}
					end={result.end}
					range={resultRange}
					error={chartError('memory')}
					emptyText={emptyCadvisor}
					onGrafana={onGrafana('memory', 'memory-request', 'memory-limit')}
				/>
				<LineChart
					title="Restarts"
					unit="count"
					summary={restartsTotal}
					lines={restartLines}
					start={result.start}
					end={result.end}
					range={resultRange}
					error={chartError('restarts', 'restarts-total')}
					emptyText={emptyKsm}
					onGrafana={onGrafana('restarts', 'restarts-total')}
				/>
				<LineChart
					title="Network"
					unit="bytes-per-second"
					summary={networkSummary}
					lines={networkLines}
					start={result.start}
					end={result.end}
					range={resultRange}
					error={chartError('network-rx', 'network-tx')}
					emptyText={emptyCadvisor}
					onGrafana={onGrafana('network-rx', 'network-tx')}
				/>
			</div>
		{:else}
			<p class="type-body-sm text-text-muted" role="status">loading metrics…</p>
		{/if}
	</div>
{:else if hint}
	<PrometheusHint title="Metrics" text={METRICS_HINT} testid="metrics-hint" />
{/if}
