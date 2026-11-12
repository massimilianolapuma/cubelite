<script lang="ts">
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import HostCharts from '#lib/components/metrics/HostCharts.svelte';
	import PrometheusHint from '#lib/components/metrics/PrometheusHint.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { NODE_METRICS_HINT, NODE_PANELS, panelQueries } from '#lib/host-metrics.ts';
	import { observeOnce } from '#lib/in-view.ts';
	import { LatestLoad } from '#lib/latest-load.svelte.ts';
	import { canOpenGrafana, openGrafanaQueries, showsIntegrationHint } from '#lib/integration-links.ts';
	import { METRICS_RANGES } from '#lib/metrics.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { prometheus } from '#lib/stores/prometheus.svelte.ts';
	import { settings } from '#lib/stores/settings.svelte.ts';
	import { prometheusNodeMetrics, type HostMetrics, type MetricsRange } from '#lib/tauri.ts';

	// A node's Metrics section (#530): CPU, memory, pods, network and
	// filesystem from node-exporter where it scrapes the node, else cAdvisor;
	// each chart says when no exporter has it. Loads when scrolled into view.
	let { node }: { node: string } = $props();

	const endpoint = $derived(prometheus.active);
	const hint = $derived(showsIntegrationHint(endpoint, settings.integrationHints.value));
	let range = $state<MetricsRange>('1h');
	let visible = $state(false);
	const metrics = new LatestLoad<HostMetrics, MetricsRange>('1h');
	const loading = $derived(metrics.loading);
	const error = $derived(metrics.error);
	const result = $derived(metrics.result);
	const resultRange = $derived(metrics.args);
	let root = $state<HTMLElement | null>(null);

	$effect(() => (root ? observeOnce(root, () => (visible = true)) : undefined));

	$effect(() => {
		const context = app.activeCluster;
		const ep = endpoint;
		const r = range;
		// Another node in the same drawer: never show the previous one's charts.
		metrics.subject(`${context}|${node}`);
		if (!visible || !context || !ep) return;
		const name = node;
		void metrics.run(r, () => prometheusNodeMetrics(app.kubeconfigPath, context, ep, name, r));
	});

	const grafana = $derived.by(() => {
		const ep = endpoint;
		if (!canOpenGrafana(ep)) return undefined;
		return (queries: string[]) => void openGrafanaQueries(ep, queries, resultRange);
	});
</script>

{#if endpoint}
	<div bind:this={root} data-testid="node-metrics-section">
		<div class="mb-2 flex flex-wrap items-center gap-2">
			<span class="type-label text-text-muted">Metrics</span>
			{#if loading}
				<LoaderCircle class="h-3 w-3 animate-spin text-text-muted" aria-label="Loading metrics" />
			{/if}
			<span class="ml-auto"></span>
			<SegmentedControl segments={METRICS_RANGES} bind:value={range} label="Metrics range" />
			{#if grafana && result}
				{@const all = result}
				<Button variant="text" size="inline" onclick={() => grafana(NODE_PANELS.flatMap((p) => panelQueries(all, p)))}>
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
				<HostCharts {result} range={resultRange} panels={NODE_PANELS} onGrafana={grafana} />
			</div>
		{:else}
			<p class="type-body-sm text-text-muted" role="status">loading metrics…</p>
		{/if}
	</div>
{:else if hint}
	<PrometheusHint title="Metrics" text={NODE_METRICS_HINT} testid="node-metrics-hint" />
{/if}
