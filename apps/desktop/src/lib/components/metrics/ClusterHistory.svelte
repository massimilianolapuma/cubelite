<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import HostCharts from '#lib/components/metrics/HostCharts.svelte';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
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
	<div class="flex flex-col gap-2 border-t border-border-faint pt-2.5" data-testid="cluster-history">
		<div class="flex items-center gap-2">
			<span class="type-section text-text-tertiary">History</span>
			{#if promOverview.usageLoading}
				<LoaderCircle class="h-3 w-3 animate-spin text-text-tertiary" aria-label="Loading cluster history" />
			{/if}
			<span class="ml-auto"></span>
			<SegmentedControl segments={METRICS_RANGES} bind:value={promOverview.range} label="History range" />
		</div>
		{#if promOverview.usageError}
			<p class="type-caption text-status-err" role="alert">{promOverview.usageError}</p>
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
			<p class="type-caption text-text-disabled">loading history…</p>
		{/if}
	</div>
{/if}
