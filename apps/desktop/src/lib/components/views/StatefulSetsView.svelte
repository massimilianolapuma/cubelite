<script lang="ts">
	import { formatAge } from '$lib/age';
	import { app } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('statefulsets');
	});

	const grid = 'grid-template-columns: 2.6fr 0.7fr 0.9fr 0.55fr;';
</script>

<div class="flex flex-col gap-3 p-4">
	<h1 class="type-title">StatefulSets</h1>

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<span class="type-colhead">Name</span>
				<span class="type-colhead">Ready</span>
				<span class="type-colhead">Status</span>
				<span class="type-colhead">Age</span>
			</div>
			<div class="bg-surface-panel">
				{#if resources.statefulsets.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No stateful sets found.</p>
				{:else}
					{#each resources.statefulsets as item (item.namespace + '/' + item.name)}
						<div
							class="grid items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
							style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
						>
						<span class="type-data truncate text-text-data-bright">{item.name}</span>
						<span class="type-data-sm text-text-secondary">{item.ready_replicas}/{item.replicas}</span>
						<span class="type-data-sm" style="color: {item.replicas > 0 && item.ready_replicas >= item.replicas ? 'var(--color-status-ok)' : 'var(--color-status-warn)'};">{item.replicas > 0 && item.ready_replicas >= item.replicas ? 'Available' : 'Progressing'}</span>
						<span class="type-data-sm text-text-secondary">{formatAge(item.creation_timestamp)}</span>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>
