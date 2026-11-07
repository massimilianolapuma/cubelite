<script lang="ts">
	import PinToggle from '#lib/components/ui/PinToggle.svelte';
	import NodeDrawer from '#lib/components/nodes/NodeDrawer.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { sortRows } from '#lib/list-sort.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';
	import { nodeTone } from '#lib/status.ts';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('nodes');
	});

	const grid = 'grid-template-columns: 2.2fr 0.8fr 1.4fr 0.9fr 0.55fr;';

	// Default sort from Preferences, header click overrides for the session (#496).
	const sorted = $derived(sortRows(resources.nodeInventory, lists.specFor('nodes'), { name: (x) => x.name, created: (x) => x.creation_timestamp, status: (x) => nodeTone(x.status) }));
</script>

<div class="flex flex-col gap-3 p-4">
	<div class="flex min-h-7 items-center gap-3">
		<h1 class="type-title flex-1">Nodes</h1>
		<PinToggle />
	</div>

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<SortHeader list="nodes" field="name" label="Name" />
				<SortHeader list="nodes" field="status" label="Status" />
				<span class="type-colhead">Roles</span>
				<span class="type-colhead">Version</span>
				<SortHeader list="nodes" field="age" label="Age" />
			</div>
			<div class="bg-surface-panel">
				{#if resources.nodeInventory.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No nodes found.</p>
				{:else}
					{#each sorted as item (item.name)}
						<div
							role="button"
							tabindex="0"
							class="focus-ring grid cursor-default items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
							style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default); {app.selectedNode === item.name
								? 'background: var(--alpha-selection-bg);'
								: ''}"
							onclick={() => (app.selectedNode = item.name)}
							onkeydown={(e) => {
								if (e.key === 'Enter') app.selectedNode = item.name;
							}}
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

{#if app.selectedNode}
	<NodeDrawer
		name={app.selectedNode}
		info={resources.nodeInventory.find((n) => n.name === app.selectedNode) ?? null}
		onClose={() => (app.selectedNode = null)}
	/>
{/if}
