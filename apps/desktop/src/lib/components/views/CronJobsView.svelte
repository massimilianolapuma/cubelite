<script lang="ts">
	import ResourceList from '#lib/components/ui/ResourceList.svelte';
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('cronjobs');
	});
</script>

<ResourceList
	list="cronjobs"
	title="CronJobs"
	nouns={['cron job', 'cron jobs']}
	rows={resources.cronjobs}
	tracks={['2fr', '1fr', '1fr', '0.7fr', '0.5fr', '0.8fr', '0.55fr']}
	accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp }}
	loaded={resources.kindLoaded('cronjobs')}
	error={resources.kindError('cronjobs')}
	busy={resources.extraLoading}
	onRetry={() => void resources.loadKind('cronjobs')}
>
	{#snippet head()}
		<span class="truncate">Schedule</span>
		<span class="truncate">Suspend</span>
		<span class="truncate text-right">Active</span>
		<span class="truncate">Last schedule</span>
		<SortHeader list="cronjobs" field="age" label="Age" />
	{/snippet}

	{#snippet cells(item)}
		<span class="type-data-sm truncate text-text-muted">{item.schedule}</span>
		<!-- A suspended cron job is bold, not coloured (Tonal §7). -->
		<span class="type-data-sm {item.suspend ? 'font-semibold text-text' : 'text-text-muted'}" data-attention={item.suspend}>
			{item.suspend ? 'True' : 'False'}
		</span>
		<span class="type-data-sm text-right text-text-muted">{item.active}</span>
		<span class="type-data-sm text-text-muted">{formatAge(item.last_schedule)}</span>
		<span class="type-data-sm text-text-muted">{formatAge(item.creation_timestamp)}</span>
	{/snippet}
</ResourceList>
