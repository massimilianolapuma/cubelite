<script lang="ts">
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { sortRows } from '#lib/list-sort.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';
	import { pvcTone } from '#lib/status.ts';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('pvcs');
	});

	const grid = 'grid-template-columns: 2fr 0.7fr 1.4fr 0.7fr 0.9fr 0.9fr 0.55fr;';

	// Default sort from Preferences, header click overrides for the session (#496).
	const sorted = $derived(sortRows(resources.pvcs, lists.specFor('pvcs'), { name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp, status: (x) => pvcTone(x.status) }));
</script>

<div class="flex flex-col gap-3 p-4">
	<h1 class="type-title">PersistentVolumeClaims</h1>

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<SortHeader list="pvcs" field="name" label="Name" />
				<SortHeader list="pvcs" field="status" label="Status" />
				<span class="type-colhead">Volume</span>
				<span class="type-colhead">Capacity</span>
				<span class="type-colhead">Access modes</span>
				<span class="type-colhead">StorageClass</span>
				<SortHeader list="pvcs" field="age" label="Age" />
			</div>
			<div class="bg-surface-panel">
				{#if resources.pvcs.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No persistent volume claims found.</p>
				{:else}
					{#each sorted as item (item.namespace + '/' + item.name)}
						<div
							class="grid items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
							style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
						>
						<span class="type-data truncate text-text-data-bright">{item.name}</span>
						<span class="type-data-sm" style="color: {item.status === 'Bound' ? 'var(--color-status-ok)' : item.status === 'Lost' ? 'var(--color-status-err)' : 'var(--color-status-warn)'};">{item.status ?? '—'}</span>
						<span class="type-data-sm truncate text-text-secondary">{item.volume ?? '—'}</span>
						<span class="type-data-sm text-text-secondary">{item.capacity ?? '—'}</span>
						<span class="type-data-sm truncate text-text-secondary">{item.access_modes.join(', ') || '—'}</span>
						<span class="type-data-sm truncate text-text-secondary">{item.storage_class ?? '—'}</span>
						<span class="type-data-sm text-text-secondary">{formatAge(item.creation_timestamp)}</span>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>
