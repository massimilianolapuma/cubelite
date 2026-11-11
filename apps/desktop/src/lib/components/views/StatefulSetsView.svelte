<script lang="ts">
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import StatusBadge from '#lib/components/ui/StatusBadge.svelte';
	import { replicaTone, STATUS_CHIPS, toneGlyph } from '#lib/status.ts';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('statefulsets');
	});
</script>

<ResourceList
	list="statefulsets"
	title="StatefulSets"
	nouns={['stateful set', 'stateful sets']}
	rows={resources.statefulsets}
	tracks={['2.6fr', '1fr', '0.7fr', '1.1fr', '0.55fr']}
	accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp, status: (x) => replicaTone(x.replicas, x.ready_replicas) }}
	chipDefs={STATUS_CHIPS.replicas}
	chipOf={(x) => replicaTone(x.replicas, x.ready_replicas)}
	loaded={resources.kindLoaded('statefulsets')}
	error={resources.kindError('statefulsets')}
	busy={resources.extraLoading}
	onRetry={() => void resources.loadKind('statefulsets')}
>
	{#snippet head()}
		<span class="truncate">Ready</span>
		<SortHeader list="statefulsets" field="status" label="Status" />
		<SortHeader list="statefulsets" field="age" label="Age" />
	{/snippet}

	{#snippet cells(item)}
		{@const tone = replicaTone(item.replicas, item.ready_replicas)}
		<span class="type-data-sm text-text-muted">{item.ready_replicas}/{item.replicas}</span>
		<span class="flex min-w-0 items-center">
			<StatusBadge state={toneGlyph(tone)} label={tone === 'ok' ? 'Available' : 'Progressing'} />
		</span>
		<span class="type-data-sm text-text-muted">{formatAge(item.creation_timestamp)}</span>
	{/snippet}
</ResourceList>
