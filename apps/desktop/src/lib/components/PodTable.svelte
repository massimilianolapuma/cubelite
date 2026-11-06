<script lang="ts">
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { sortRows } from '#lib/list-sort.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';
	import CornerDownLeft from '@lucide/svelte/icons/corner-down-left';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { formatAge } from '#lib/age.ts';
	import type { PodInfo } from '#lib/tauri.ts';
	import { podStatusLabel, podTone, toneColor } from '#lib/status.ts';
	import { mutations } from '#lib/stores/mutations.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import Sparkline from '#lib/components/metrics/Sparkline.svelte';
	import { app } from '#lib/stores/app.svelte.ts';
	import { prometheus } from '#lib/stores/prometheus.svelte.ts';
	import { formatBytes, formatCpu } from '#lib/units.ts';

	let {
		pods,
		selected = null,
		onRowClick,
		onLogs
	}: {
		pods: PodInfo[];
		selected?: PodInfo | null;
		onRowClick?: (pod: PodInfo) => void;
		onLogs?: (pod: PodInfo) => void;
	} = $props();

	// Spec grid: NAME / STATUS / READY / AGE / CPU / MEMORY / RESTARTS
	const grid = 'grid-template-columns: 2.4fr 1fr 0.9fr 0.7fr 0.55fr 0.6fr 0.7fr 0.5fr;';

	// Last hour of CPU and memory from Prometheus, after the rows (#510).
	$effect(() => {
		void pods;
		void prometheus.loadSparklines(app.namespace);
	});
	const sparkTitle = $derived(
		prometheus.sparklineError ? `sparklines unavailable: ${prometheus.sparklineError}` : 'sparkline: last hour, from Prometheus'
	);

	// Default sort from Preferences, header click overrides for the session (#496).
	const sorted = $derived(sortRows(pods, lists.specFor('pods'), { name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp, status: (x) => podTone(x), restarts: (x) => x.restarts }));
</script>

<div class="overflow-hidden rounded-lg border border-border-default">
	<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
		<SortHeader list="pods" field="name" label="Name" />
		<SortHeader list="pods" field="namespace" label="Namespace" />
		<SortHeader list="pods" field="status" label="Status" />
		<span class="type-colhead">Ready</span>
		<SortHeader list="pods" field="age" label="Age" />
		<span class="type-colhead" title={prometheus.active ? sparkTitle : undefined}>CPU</span>
		<span class="type-colhead" title={prometheus.active ? sparkTitle : undefined}>Memory</span>
		<SortHeader list="pods" field="restarts" label="Restarts" />
	</div>
	<div class="bg-surface-panel">
		{#if pods.length === 0}
			<p class="py-8 text-center text-xs text-text-disabled">No pods found.</p>
		{:else}
			{#each sorted as pod (pod.namespace + '/' + pod.name)}
				{@const tone = podTone(pod)}
				{@const isSelected = selected?.name === pod.name && selected?.namespace === pod.namespace}
				{@const usage = resources.metricsFor(pod.namespace, pod.name)}
				<!-- Resource names are never links; the row is the interactive target (HIG §4.8.1). -->
				<button
					type="button"
					class="focus-ring grid w-full items-center gap-x-3 border-b border-border-faint px-3 text-left last:border-b-0 hover:bg-surface-row-hover"
					style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default); {isSelected
						? 'background: var(--alpha-selection-bg);'
						: ''}"
					onclick={() => onRowClick?.(pod)}
					onkeydown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							if (isSelected) onLogs?.(pod);
							else onRowClick?.(pod);
						}
					}}
				>
					<span class="type-data truncate text-text-data-bright">{pod.name}</span>
					<span class="type-data-sm truncate text-text-secondary">{pod.namespace}</span>
					<span class="flex items-center gap-1.5">
						{#if mutations.isDeleting(pod.namespace, pod.name)}
							<LoaderCircle size={10} class="shrink-0 animate-spin text-text-tertiary" aria-hidden="true" />
							<span class="type-data-sm text-text-tertiary">Terminating…</span>
						{:else}
							<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {toneColor[tone]};"></span>
							<span class="type-data-sm" style="color: {toneColor[tone]};">{podStatusLabel(pod)}</span>
						{/if}
					</span>
					<span class="type-data-sm text-text-secondary">
						{pod.ready_containers}/{pod.total_containers}
					</span>
					<span class="type-data-sm text-text-secondary">{formatAge(pod.creation_timestamp)}</span>
					<span class="flex items-center gap-1.5">
						<span class="type-data-sm {usage ? 'text-text-secondary' : 'text-text-disabled'}">
							{usage ? formatCpu(usage.cpu_millis) : '—'}
						</span>
						{#if prometheus.active}
							<Sparkline points={prometheus.cpuFor(pod.namespace, pod.name)} label="CPU, last hour" />
						{/if}
					</span>
					<span class="flex items-center gap-1.5">
						<span class="type-data-sm {usage ? 'text-text-secondary' : 'text-text-disabled'}">
							{usage ? formatBytes(usage.memory_bytes) : '—'}
						</span>
						{#if prometheus.active}
							<Sparkline points={prometheus.memoryFor(pod.namespace, pod.name)} label="Memory, last hour" />
						{/if}
					</span>
					<span class="flex items-center justify-between gap-1.5">
						<span
							class="type-data-sm"
							style="color: {pod.restarts > 3 ? 'var(--color-status-err)' : 'var(--color-text-secondary)'};"
						>
							{pod.restarts}
						</span>
						{#if isSelected}
							<span
								role="button"
								tabindex="-1"
								class="hit-target type-caption flex h-5 shrink-0 items-center gap-1 rounded-md border border-border-default bg-surface-raised px-1.5 text-text-tertiary"
								onclick={(e) => {
									e.stopPropagation();
									onLogs?.(pod);
								}}
								onkeydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.stopPropagation();
										onLogs?.(pod);
									}
								}}
							>
								logs
								<CornerDownLeft size={10} strokeWidth={1.5} aria-hidden="true" />
							</span>
						{/if}
					</span>
				</button>
			{/each}
		{/if}
	</div>
</div>
