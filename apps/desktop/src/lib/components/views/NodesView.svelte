<script lang="ts">
	import { formatAge } from '$lib/age';
	import { app } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('nodes');
	});

	const grid = 'grid-template-columns: 2.2fr 0.8fr 1.4fr 0.9fr 0.55fr;';
</script>

<div class="flex flex-col gap-3 p-4">
	<h1 class="type-title">Nodes</h1>

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<span class="type-colhead">Name</span>
				<span class="type-colhead">Status</span>
				<span class="type-colhead">Roles</span>
				<span class="type-colhead">Version</span>
				<span class="type-colhead">Age</span>
			</div>
			<div class="bg-surface-panel">
				{#if resources.nodeInventory.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No nodes found.</p>
				{:else}
					{#each resources.nodeInventory as item (item.name)}
						<div
							class="grid items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
							style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
						>
						<span class="type-data truncate text-text-data-bright">{item.name}</span>
						<span class="type-data-sm" style="color: {item.status === 'Ready' ? 'var(--color-status-ok)' : 'var(--color-status-err)'};">{item.status}</span>
						<span class="type-data-sm truncate text-text-secondary">{item.roles.join(', ') || '—'}</span>
						<span class="type-data-sm text-text-secondary">{item.version ?? '—'}</span>
						<span class="type-data-sm text-text-secondary">{formatAge(item.creation_timestamp)}</span>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>
