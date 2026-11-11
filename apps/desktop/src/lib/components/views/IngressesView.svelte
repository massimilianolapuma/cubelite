<script lang="ts">
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('ingresses');
	});
</script>

<ResourceList
	list="ingresses"
	title="Ingresses"
	nouns={['ingress', 'ingresses']}
	rows={resources.ingresses}
	tracks={['1.8fr', '1fr', '0.7fr', '1.6fr', '1.1fr', '0.7fr', '0.55fr']}
	accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp }}
	loaded={resources.kindLoaded('ingresses')}
	error={resources.kindError('ingresses')}
	busy={resources.extraLoading}
	onRetry={() => void resources.loadKind('ingresses')}
>
	{#snippet head()}
		<span class="truncate">Class</span>
		<span class="truncate">Hosts</span>
		<span class="truncate">Address</span>
		<span class="truncate">Ports</span>
		<SortHeader list="ingresses" field="age" label="Age" />
	{/snippet}

	{#snippet cells(ing)}
		<span class="type-data-sm truncate text-text-muted">{ing.class ?? '–'}</span>
		<span class="type-data-sm truncate {ing.hosts.length ? 'text-text-muted' : 'text-text-subtle'}">
			{ing.hosts.join(', ') || '*'}
		</span>
		<span class="type-data-sm truncate {ing.addresses.length ? 'text-text-muted' : 'text-text-subtle'}">
			{ing.addresses.join(', ') || '–'}
		</span>
		<span class="type-data-sm text-text-muted">{ing.tls ? '80, 443' : '80'}</span>
		<span class="type-data-sm text-text-muted">{formatAge(ing.creation_timestamp)}</span>
	{/snippet}
</ResourceList>
