<script lang="ts">
	import { EMPTY } from '#lib/empty.ts';
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import StatusBadge from '#lib/components/ui/StatusBadge.svelte';
	import { pvcTone, STATUS_CHIPS, toneGlyph } from '#lib/status.ts';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('pvcs');
	});
</script>

<ResourceList
	list="pvcs"
	title="PersistentVolumeClaims"
	nouns={['persistent volume claim', 'persistent volume claims']}
	rows={resources.pvcs}
	tracks={['2fr', '1fr', '0.9fr', '1.4fr', '0.7fr', '0.9fr', '0.9fr', '0.55fr']}
	accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp, status: (x) => pvcTone(x.status) }}
	chipDefs={STATUS_CHIPS.pvcs}
	chipOf={(x) => pvcTone(x.status)}
	loaded={resources.kindLoaded('pvcs')}
	error={resources.kindError('pvcs')}
	busy={resources.extraLoading}
	onRetry={() => void resources.loadKind('pvcs')}
>
	{#snippet head()}
		<SortHeader list="pvcs" field="status" label="Status" />
		<span class="truncate">Volume</span>
		<span class="truncate">Capacity</span>
		<span class="truncate">Access modes</span>
		<span class="truncate">StorageClass</span>
		<SortHeader list="pvcs" field="age" label="Age" />
	{/snippet}

	{#snippet cells(item)}
		<span class="flex min-w-0 items-center">
			<StatusBadge state={toneGlyph(pvcTone(item.status))} label={item.status ?? EMPTY} />
		</span>
		<span class="type-data-sm truncate text-text-muted">{item.volume ?? EMPTY}</span>
		<span class="type-data-sm text-text-muted">{item.capacity ?? EMPTY}</span>
		<span class="type-data-sm truncate text-text-muted">{item.access_modes.join(', ') || EMPTY}</span>
		<span class="type-data-sm truncate text-text-muted">{item.storage_class ?? EMPTY}</span>
		<span class="type-data-sm text-text-muted">{formatAge(item.creation_timestamp)}</span>
	{/snippet}
</ResourceList>
