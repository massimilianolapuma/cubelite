<script lang="ts">
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { sortRows } from '#lib/list-sort.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('jobs');
	});

	const grid = 'grid-template-columns: 2.4fr 1fr 0.9fr 0.6fr 0.6fr 0.55fr;';

	// Default sort from Preferences, header click overrides for the session (#496).
	const sorted = $derived(sortRows(resources.jobs, lists.specFor('jobs'), { name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp }));
</script>

<div class="flex flex-col gap-3 p-4">
	<h1 class="type-title">Jobs</h1>

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<SortHeader list="jobs" field="name" label="Name" />
				<SortHeader list="jobs" field="namespace" label="Namespace" />
				<span class="type-colhead">Completions</span>
				<span class="type-colhead">Active</span>
				<span class="type-colhead">Failed</span>
				<SortHeader list="jobs" field="age" label="Age" />
			</div>
			<div class="bg-surface-panel">
				{#if resources.jobs.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No jobs found.</p>
				{:else}
					{#each sorted as item (item.namespace + '/' + item.name)}
						<div
							class="grid items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
							style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
						>
						<span class="type-data truncate text-text-data-bright">{item.name}</span>
						<span class="type-data-sm truncate text-text-secondary">{item.namespace}</span>
						<span class="type-data-sm text-text-secondary">{item.succeeded}/{item.completions}</span>
						<span class="type-data-sm text-text-secondary">{item.active}</span>
						<span class="type-data-sm" style="color: {item.failed > 0 ? 'var(--color-status-err)' : 'var(--color-text-secondary)'};">{item.failed}</span>
						<span class="type-data-sm text-text-secondary">{formatAge(item.creation_timestamp)}</span>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>
