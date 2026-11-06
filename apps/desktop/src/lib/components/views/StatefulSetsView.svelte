<script lang="ts">
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import GroupedRows from '#lib/components/ui/GroupedRows.svelte';
	import ListTitle from '#lib/components/ui/ListTitle.svelte';
	import { gridColumns } from '#lib/list-group.ts';
	import { replicaTone } from '#lib/status.ts';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('statefulsets');
	});

	const grid = $derived(gridColumns(['2.6fr', '1fr', '0.7fr', '0.9fr', '0.55fr'], app.groupedLists));
</script>

<div class="flex flex-col gap-3 p-4">
	<ListTitle title="StatefulSets" />

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<SortHeader list="statefulsets" field="name" label="Name" />
				{#if !app.groupedLists}<SortHeader list="statefulsets" field="namespace" label="Namespace" />{/if}
				<span class="type-colhead">Ready</span>
				<SortHeader list="statefulsets" field="status" label="Status" />
				<SortHeader list="statefulsets" field="age" label="Age" />
			</div>
			<div class="bg-surface-panel">
				{#if resources.statefulsets.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No stateful sets found.</p>
				{:else}
					<GroupedRows list="statefulsets" rows={resources.statefulsets} accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp, status: (x) => replicaTone(x.replicas, x.ready_replicas) }} nouns={['stateful set', 'stateful sets']}>
						{#snippet row(item, grouped)}
							<div
								class="grid items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
								style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
							>
							<span class="type-data truncate text-text-data-bright {grouped ? 'pl-4.5' : ''}">{item.name}</span>
							{#if !grouped}<span class="type-data-sm truncate text-text-secondary">{item.namespace}</span>{/if}
							<span class="type-data-sm text-text-secondary">{item.ready_replicas}/{item.replicas}</span>
							<span class="type-data-sm" style="color: {item.replicas > 0 && item.ready_replicas >= item.replicas ? 'var(--color-status-ok)' : 'var(--color-status-warn)'};">{item.replicas > 0 && item.ready_replicas >= item.replicas ? 'Available' : 'Progressing'}</span>
							<span class="type-data-sm text-text-secondary">{formatAge(item.creation_timestamp)}</span>
							</div>
						{/snippet}
					</GroupedRows>
				{/if}
			</div>
		</div>
	{/if}
</div>
