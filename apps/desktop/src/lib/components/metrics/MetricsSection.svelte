<script lang="ts">
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import LineChart from '#lib/components/metrics/LineChart.svelte';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import { errorMessage } from '#lib/errors.ts';
	import { webUiBase } from '#lib/integration.ts';
	import {
		METRICS_RANGES,
		chartData,
		formatValue,
		latest,
		latestTotal,
		seriesColor,
		sumPoints,
		type ChartLine,
		type Unit
	} from '#lib/metrics.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { prometheus } from '#lib/stores/prometheus.svelte.ts';
	import {
		grafanaPortForward,
		openGrafanaExplore,
		prometheusMetrics,
		type Chart,
		type MetricsRange,
		type MetricsResult,
		type Series,
		type Workload
	} from '#lib/tauri.ts';
	import { toasts } from '#lib/stores/toasts.svelte.ts';

	// Metrics section of a pod or deployment drawer (#510, spec §5.1): the
	// recent history from Prometheus; only rendered when the context has a
	// Prometheus endpoint. Loads when it scrolls into view.
	let { namespace, workload }: { namespace: string; workload: Workload } = $props();

	const endpoint = $derived(prometheus.active);
	let range = $state<MetricsRange>('1h');
	let split = $state<'container' | 'total'>('container');
	const perContainer = $derived(split === 'container');
	let visible = $state(false);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let result = $state<MetricsResult | null>(null);
	/** Range of `result` (the selection may already be another one). */
	let resultRange = $state<MetricsRange>('1h');
	/** Pod or deployment the result belongs to. */
	let resultKey = '';
	let root = $state<HTMLElement | null>(null);
	let generation = 0;

	$effect(() => {
		if (!root) return;
		if (typeof IntersectionObserver === 'undefined') {
			visible = true;
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) {
				visible = true;
				observer.disconnect();
			}
		});
		observer.observe(root);
		return () => observer.disconnect();
	});

	$effect(() => {
		const context = app.activeCluster;
		const ep = endpoint;
		const request = { namespace, workload, range, perContainer };
		const key = `${context}|${namespace}|${workload.kind}/${workload.name}`;
		if (key !== resultKey) {
			// Another pod in the same drawer: never show the previous one's charts.
			resultKey = key;
			result = null;
			error = null;
		}
		if (!visible || !context || !ep) return;
		void load(context, ep, request);
	});

	async function load(
		context: string,
		ep: NonNullable<typeof endpoint>,
		request: Parameters<typeof prometheusMetrics>[3]
	) {
		const mine = ++generation;
		loading = true;
		error = null;
		try {
			const data = await prometheusMetrics(app.kubeconfigPath, context, ep, request);
			if (mine === generation) {
				result = data;
				resultRange = request.range;
			}
		} catch (e) {
			if (mine === generation) {
				error = errorMessage(e);
				result = null;
			}
		} finally {
			if (mine === generation) loading = false;
		}
	}

	const series = (chart: Chart): Series[] => (result ? (chartData(result.charts, chart)?.series ?? []) : []);
	const chartError = (...charts: Chart[]): string | null =>
		result ? (charts.map((c) => chartData(result!.charts, c)?.error).find((e) => e) ?? null) : null;

	/** Usage lines per container plus dashed request and limit totals. */
	function usageLines(usage: Chart, request: Chart, limit: Chart): ChartLine[] {
		const lines: ChartLine[] = series(usage).map((s, i) => ({
			label: s.label,
			color: seriesColor(i),
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
					color: 'var(--color-text-tertiary)',
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
		parts.push(now === null ? '—' : formatValue(now, unit));
		const req = latestTotal(series(request));
		if (req !== null) parts.push(`req ${formatValue(req, unit)}`);
		const lim = latestTotal(series(limit));
		if (lim !== null) parts.push(`lim ${formatValue(lim, unit)}`);
		return parts.join(' / ');
	}

	const cpuLines = $derived(result ? usageLines('cpu', 'cpu-request', 'cpu-limit') : []);
	const memoryLines = $derived(result ? usageLines('memory', 'memory-request', 'memory-limit') : []);
	const restartLines = $derived(
		series('restarts').map((s, i) => ({ label: s.label, color: seriesColor(i), points: s.points }))
	);
	const networkLines = $derived<ChartLine[]>([
		...series('network-rx').map((s) => ({ label: 'rx', color: seriesColor(0), points: s.points })),
		...series('network-tx').map((s) => ({ label: 'tx', color: seriesColor(1), points: s.points }))
	]);
	const networkSummary = $derived.by(() => {
		const rx = series('network-rx')[0];
		const tx = series('network-tx')[0];
		const fmt = (s: Series | undefined) => {
			const v = s ? latest(s.points) : null;
			return v === null ? '—' : formatValue(v, 'bytes-per-second');
		};
		return `↓ ${fmt(rx)} ↑ ${fmt(tx)}`;
	});

	// A configured URL wins; else an in-cluster Grafana through a port-forward (#525).
	const canOpenGrafana = $derived(
		!!endpoint?.grafanaUrl?.trim() || (endpoint?.target.kind === 'in-cluster' && !!endpoint.grafanaService)
	);

	async function grafana(...charts: Chart[]) {
		const ep = endpoint;
		const context = app.activeCluster;
		const data = result;
		if (!ep || !context || !data) return;
		const queries = charts.map((c) => chartData(data.charts, c)?.query).filter((q): q is string => !!q);
		const range = resultRange;
		try {
			const service = ep.target.kind === 'in-cluster' ? ep.grafanaService : null;
			const grafanaUrl = await webUiBase(ep.grafanaUrl, service, (s) =>
				grafanaPortForward(app.kubeconfigPath, context, s)
			);
			if (!grafanaUrl) return;
			await openGrafanaExplore({ grafanaUrl, datasource: ep.grafanaDatasource, queries, range });
		} catch (e) {
			toasts.push(errorMessage(e), 'err');
		}
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
		return value === null ? '—' : `${Math.round(value)} in range`;
	});
	const emptyCadvisor = 'no data — needs cAdvisor metrics in Prometheus';
	const emptyKsm = 'no data — needs kube-state-metrics in Prometheus';
</script>

{#if endpoint}
	<div bind:this={root} data-testid="metrics-section">
		<div class="mb-1.5 flex flex-wrap items-center gap-2">
			<span class="type-section text-text-tertiary">Metrics</span>
			{#if loading}
				<LoaderCircle class="h-3 w-3 animate-spin text-text-tertiary" aria-label="Loading metrics" />
			{/if}
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
				<button
					type="button"
					class="focus-ring type-caption flex items-center gap-1 rounded-sm text-text-tertiary hover:text-text-secondary"
					onclick={() => void grafana(...ALL)}
				>
					<ExternalLink class="h-3 w-3" /> Grafana
				</button>
			{/if}
		</div>
		{#if error}
			<p class="type-caption text-status-err" role="alert">{error}</p>
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
			<p class="type-caption text-text-disabled">loading metrics…</p>
		{/if}
	</div>
{/if}
