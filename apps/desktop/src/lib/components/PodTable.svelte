<script lang="ts">
	import { formatAge } from '$lib/age';
	import type { PodInfo } from '$lib/tauri';
	import { podStatusLabel, podTone, toneColor } from '$lib/status';

	let {
		pods,
		selected = null,
		onRowClick
	}: {
		pods: PodInfo[];
		selected?: PodInfo | null;
		onRowClick?: (pod: PodInfo) => void;
	} = $props();

	// Spec grid: NAME / STATUS / READY / AGE / CPU / MEMORY / RESTARTS
	const grid = 'grid-template-columns: 2.4fr 0.9fr 0.7fr 0.55fr 0.6fr 0.7fr 0.5fr;';
</script>

<div class="overflow-hidden rounded-lg border border-border-default">
	<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
		<span class="type-colhead">Name</span>
		<span class="type-colhead">Status</span>
		<span class="type-colhead">Ready</span>
		<span class="type-colhead">Age</span>
		<span class="type-colhead">CPU</span>
		<span class="type-colhead">Memory</span>
		<span class="type-colhead">Restarts</span>
	</div>
	<div class="bg-surface-panel">
		{#if pods.length === 0}
			<p class="py-8 text-center text-xs text-text-disabled">No pods found.</p>
		{:else}
			{#each pods as pod (pod.namespace + '/' + pod.name)}
				{@const tone = podTone(pod)}
				{@const isSelected = selected?.name === pod.name && selected?.namespace === pod.namespace}
				<!-- Resource names are never links; the row is the interactive target (HIG §4.8.1). -->
				<button
					type="button"
					class="grid w-full items-center gap-x-3 border-b border-border-faint px-3 text-left last:border-b-0 hover:bg-surface-row-hover"
					style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default); {isSelected
						? 'background: var(--alpha-selection-bg);'
						: ''}"
					onclick={() => onRowClick?.(pod)}
				>
					<span class="type-data truncate text-text-data-bright">{pod.name}</span>
					<span class="flex items-center gap-1.5">
						<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {toneColor[tone]};"></span>
						<span class="text-[11.5px]" style="color: {toneColor[tone]};">{podStatusLabel(pod)}</span>
					</span>
					<span class="type-data-sm text-text-secondary">
						{pod.ready_containers}/{pod.total_containers}
					</span>
					<span class="type-data-sm text-text-secondary">{formatAge(pod.creation_timestamp)}</span>
					<span class="type-data-sm text-text-disabled">—</span>
					<span class="type-data-sm text-text-disabled">—</span>
					<span
						class="type-data-sm"
						style="color: {pod.restarts > 3 ? 'var(--color-status-err)' : 'var(--color-text-secondary)'};"
					>
						{pod.restarts}
					</span>
				</button>
			{/each}
		{/if}
	</div>
</div>
