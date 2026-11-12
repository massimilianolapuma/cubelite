<script lang="ts">
	import Loading from '#lib/components/ui/Loading.svelte';
	import HostCharts from '#lib/components/metrics/HostCharts.svelte';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { CLUSTER_PANELS } from '#lib/host-metrics.ts';
	import { canOpenGrafana, openGrafanaQueries } from '#lib/integration-links.ts';
	import { METRICS_RANGES } from '#lib/metrics.ts';
	import { prometheus } from '#lib/stores/prometheus.svelte.ts';
	import { promOverview } from '#lib/stores/promOverview.svelte.ts';

	// Cluster CPU and memory history next to the metrics-server meters
	// (#530); only with a Prometheus endpoint. The Overview loads it.
	const endpoint = $derived(prometheus.active);
	const grafana = $derived.by(() => {
		const ep = endpoint;
		if (!canOpenGrafana(ep)) return undefined;
		return (queries: string[]) => void openGrafanaQueries(ep, queries, promOverview.usageRange);
	});
</script>

{#if endpoint}
	<div class="mt-1 flex flex-col gap-2" data-testid="cluster-history">
		<div class="flex items-center gap-2">
			<span class="type-label text-text-muted">History</span>
			{#if promOverview.usageLoading}
				<Loading label="Loading cluster history" />
			{/if}
			<span class="ml-auto"></span>
			<SegmentedControl segments={METRICS_RANGES} bind:value={promOverview.range} label="History range" />
		</div>
		{#if promOverview.usageError}
			<p class="type-body-sm flex items-start gap-1.5 text-text" role="alert">
				<StatusGlyph state="err" class="mt-1 text-error" />
				{promOverview.usageError}
			</p>
		{:else if promOverview.usage}
			<div class="grid gap-2 2xl:grid-cols-2">
				<HostCharts
					result={promOverview.usage}
					range={promOverview.usageRange}
					panels={CLUSTER_PANELS}
					onGrafana={grafana}
				/>
			</div>
		{:else}
			<p class="type-body-sm text-text-muted" role="status">loading history…</p>
		{/if}
	</div>
{/if}
