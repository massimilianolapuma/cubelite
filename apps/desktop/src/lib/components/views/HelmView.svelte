<script lang="ts">
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import StatusBadge from '#lib/components/ui/StatusBadge.svelte';
	import { helmTone, STATUS_CHIPS, toneGlyph } from '#lib/status.ts';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('helm');
	});
</script>

<ResourceList
	list="helm"
	title="Helm Releases"
	nouns={['Helm release', 'Helm releases']}
	rows={resources.helmReleases}
	tracks={['1.6fr', '1fr', '0.4fr', '1.1fr', '1.4fr', '0.6fr']}
	accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.updated, status: (x) => helmTone(x.status) }}
	chipDefs={STATUS_CHIPS.helm}
	chipOf={(x) => helmTone(x.status)}
	loaded={resources.kindLoaded('helm')}
	error={resources.kindError('helm')}
	busy={resources.extraLoading}
	onRetry={() => void resources.loadKind('helm')}
>
	{#snippet head()}
		<span class="truncate text-right">Rev</span>
		<SortHeader list="helm" field="status" label="Status" />
		<span class="truncate">Chart</span>
		<SortHeader list="helm" field="age" label="Updated" />
	{/snippet}

	{#snippet cells(release)}
		<span class="type-data-sm text-right text-text-muted">{release.revision}</span>
		<span class="flex min-w-0 items-center">
			<StatusBadge state={toneGlyph(helmTone(release.status))} label={release.status ?? '–'} />
		</span>
		<span class="type-data-sm truncate {release.chart ? 'text-text-muted' : 'text-text-subtle'}">
			{release.chart ?? '–'}
		</span>
		<span class="type-data-sm text-text-muted">{formatAge(release.updated)}</span>
	{/snippet}
</ResourceList>
