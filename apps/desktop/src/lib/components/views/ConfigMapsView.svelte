<script lang="ts">
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('configmaps');
	});
</script>

<ResourceList
	list="configmaps"
	title="ConfigMaps"
	nouns={['config map', 'config maps']}
	rows={resources.configmaps}
	tracks={['3fr', '1fr', '0.6fr', '0.55fr']}
	accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp }}
	loaded={resources.kindLoaded('configmaps')}
	error={resources.kindError('configmaps')}
	busy={resources.extraLoading}
	onRetry={() => void resources.loadKind('configmaps')}
>
	{#snippet head()}
		<span class="truncate text-right">Data</span>
		<SortHeader list="configmaps" field="age" label="Age" />
	{/snippet}

	{#snippet cells(cm)}
		<span class="type-data-sm text-right text-text-muted">{cm.data_count}</span>
		<span class="type-data-sm text-text-muted">{formatAge(cm.creation_timestamp)}</span>
	{/snippet}
</ResourceList>
