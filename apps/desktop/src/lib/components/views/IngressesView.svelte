<script lang="ts">
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { sortRows } from '#lib/list-sort.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('ingresses');
	});

	const grid = 'grid-template-columns: 1.8fr 1fr 0.7fr 1.6fr 1.1fr 0.7fr 0.55fr;';

	// Default sort from Preferences, header click overrides for the session (#496).
	const sorted = $derived(sortRows(resources.ingresses, lists.specFor('ingresses'), { name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp }));
</script>

<div class="flex flex-col gap-3 p-4">
	<h1 class="type-title">Ingresses</h1>

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<SortHeader list="ingresses" field="name" label="Name" />
				<SortHeader list="ingresses" field="namespace" label="Namespace" />
				<span class="type-colhead">Class</span>
				<span class="type-colhead">Hosts</span>
				<span class="type-colhead">Address</span>
				<span class="type-colhead">Ports</span>
				<SortHeader list="ingresses" field="age" label="Age" />
			</div>
			<div class="bg-surface-panel">
				{#if resources.ingresses.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No ingresses found.</p>
				{:else}
					{#each sorted as ing (ing.namespace + '/' + ing.name)}
						<div
							class="grid items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
							style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
						>
							<span class="type-data truncate text-text-data-bright">{ing.name}</span>
							<span class="type-data-sm truncate text-text-secondary">{ing.namespace}</span>
							<span class="type-data-sm text-text-secondary">{ing.class ?? '—'}</span>
							<span class="type-data-sm truncate {ing.hosts.length ? 'text-text-secondary' : 'text-text-disabled'}">
								{ing.hosts.length ? ing.hosts.join(', ') : '*'}
							</span>
							<span class="type-data-sm truncate {ing.addresses.length ? 'text-text-secondary' : 'text-text-disabled'}">
								{ing.addresses.length ? ing.addresses.join(', ') : '—'}
							</span>
							<span class="type-data-sm text-text-secondary">{ing.tls ? '80, 443' : '80'}</span>
							<span class="type-data-sm text-text-secondary">{formatAge(ing.creation_timestamp)}</span>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>
