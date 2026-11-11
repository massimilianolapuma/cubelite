<script lang="ts">
	import NodeDrawer from '#lib/components/nodes/NodeDrawer.svelte';
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import StatusBadge from '#lib/components/ui/StatusBadge.svelte';
	import { nodeTone, STATUS_CHIPS, toneGlyph } from '#lib/status.ts';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('nodes');
	});
</script>

<!-- Default sort from Preferences, header click overrides for the session (#496). -->
<ResourceList
	list="nodes"
	title="Nodes"
	nouns={['node', 'nodes']}
	rows={resources.nodeInventory}
	tracks={['2.2fr', '1fr', '1.4fr', '0.9fr', '0.55fr']}
	accessors={{
		name: (x) => x.name,
		namespace: () => '',
		created: (x) => x.creation_timestamp,
		status: (x) => nodeTone(x.status)
	}}
	namespaced={false}
	chipDefs={STATUS_CHIPS.nodes}
	chipOf={(x) => nodeTone(x.status)}
	loaded={resources.kindLoaded('nodes')}
	error={resources.kindError('nodes')}
	busy={resources.extraLoading}
	onRetry={() => void resources.loadKind('nodes')}
	selected={(node) => app.selectedNode === node.name}
	onSelect={(node) => (app.selectedNode = node.name)}
>
	{#snippet head()}
		<SortHeader list="nodes" field="status" label="Status" />
		<span class="truncate">Roles</span>
		<span class="truncate">Version</span>
		<SortHeader list="nodes" field="age" label="Age" />
	{/snippet}

	{#snippet cells(item)}
		<span class="flex min-w-0 items-center">
			<StatusBadge state={toneGlyph(nodeTone(item.status))} label={item.status} />
		</span>
		<span class="type-data-sm truncate text-text-muted">{item.roles.join(', ') || '–'}</span>
		<span class="type-data-sm text-text-muted">{item.version ?? '–'}</span>
		<span class="type-data-sm text-text-muted">{formatAge(item.creation_timestamp)}</span>
	{/snippet}
</ResourceList>

{#if app.selectedNode}
	<NodeDrawer
		name={app.selectedNode}
		info={resources.nodeInventory.find((n) => n.name === app.selectedNode) ?? null}
		onClose={() => (app.selectedNode = null)}
	/>
{/if}
