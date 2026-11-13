<script lang="ts">
	import { EMPTY } from '#lib/empty.ts';
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('services');
	});
</script>

<ResourceList
	list="services"
	title="Services"
	nouns={['service', 'services']}
	rows={resources.services}
	tracks={['2fr', '1fr', '0.9fr', '1fr', '1fr', '1.4fr', '0.55fr']}
	accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp }}
	loaded={resources.kindLoaded('services')}
	error={resources.kindError('services')}
	busy={resources.extraLoading}
	onRetry={() => void resources.loadKind('services')}
>
	{#snippet head()}
		<span class="truncate">Type</span>
		<span class="truncate">Cluster-IP</span>
		<span class="truncate">External-IP</span>
		<span class="truncate">Ports</span>
		<SortHeader list="services" field="age" label="Age" />
	{/snippet}

	{#snippet cells(svc)}
		<span class="type-data-sm truncate text-text-muted">{svc.service_type ?? EMPTY}</span>
		<span class="type-data-sm truncate text-text-muted">{svc.cluster_ip ?? EMPTY}</span>
		<span class="type-data-sm truncate {svc.external_ips.length ? 'text-text-muted' : 'text-text-subtle'}">
			{svc.external_ips.join(', ') || EMPTY}
		</span>
		<span class="type-data-sm truncate text-text-muted">{svc.ports.join(', ') || EMPTY}</span>
		<span class="type-data-sm text-text-muted">{formatAge(svc.creation_timestamp)}</span>
	{/snippet}
</ResourceList>
