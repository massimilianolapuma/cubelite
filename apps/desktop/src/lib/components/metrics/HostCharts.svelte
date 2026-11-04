<script lang="ts">
	import LineChart from '#lib/components/metrics/LineChart.svelte';
	import {
		panelError,
		panelLines,
		panelQueries,
		panelSource,
		panelSummary,
		type HostPanel
	} from '#lib/host-metrics.ts';
	import type { HostMetrics, MetricsRange } from '#lib/tauri.ts';

	// The charts of the cluster history or of a node (#530): one LineChart
	// per panel, its exporter in the title, "not available" when no
	// exporter has the series.
	let {
		result,
		range,
		panels,
		onGrafana
	}: {
		result: HostMetrics;
		range: MetricsRange;
		panels: HostPanel[];
		onGrafana?: (queries: string[]) => void;
	} = $props();
</script>

{#each panels as panel (panel.title)}
	<LineChart
		title={panel.title}
		note={panelSource(result, panel)}
		unit={panel.unit}
		summary={panelSummary(result, panel)}
		lines={panelLines(result, panel)}
		start={result.start}
		end={result.end}
		{range}
		error={panelError(result, panel)}
		emptyText={panel.emptyText}
		onGrafana={onGrafana ? () => onGrafana(panelQueries(result, panel)) : undefined}
	/>
{/each}
