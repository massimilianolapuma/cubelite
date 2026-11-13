<script lang="ts">
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('jobs');
	});
</script>

<ResourceList
	list="jobs"
	title="Jobs"
	nouns={['job', 'jobs']}
	rows={resources.jobs}
	tracks={['2.4fr', '1fr', '0.9fr', '0.6fr', '0.6fr', '0.55fr']}
	accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp }}
	loaded={resources.kindLoaded('jobs')}
	error={resources.kindError('jobs')}
	busy={resources.extraLoading}
	onRetry={() => void resources.loadKind('jobs')}
>
	{#snippet head()}
		<span class="truncate">Completions</span>
		<span class="truncate text-right">Active</span>
		<span class="truncate text-right">Failed</span>
		<SortHeader list="jobs" field="age" label="Age" />
	{/snippet}

	{#snippet cells(item)}
		<span class="type-data-sm text-text-muted">{item.succeeded}/{item.completions}</span>
		<span class="type-data-sm text-right text-text-muted">{item.active}</span>
		<!-- A failure count above zero is bold, not coloured (Tonal §7). -->
		<span
			class="type-data-sm text-right {item.failed > 0 ? 'font-semibold text-text' : 'text-text-muted'}"
			data-attention={item.failed > 0}
		>
			{item.failed}
		</span>
		<span class="type-data-sm text-text-muted">{formatAge(item.creation_timestamp)}</span>
	{/snippet}
</ResourceList>
