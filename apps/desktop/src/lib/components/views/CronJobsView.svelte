<script lang="ts">
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import GroupedRows from '#lib/components/ui/GroupedRows.svelte';
	import ListTitle from '#lib/components/ui/ListTitle.svelte';
	import { gridColumns } from '#lib/list-group.ts';
	import { formatAge } from '#lib/age.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('cronjobs');
	});

	const grid = $derived(gridColumns(['2fr', '1fr', '1fr', '0.7fr', '0.5fr', '0.8fr', '0.55fr'], app.groupedLists));
</script>

<div class="flex flex-col gap-3 p-4">
	<ListTitle title="CronJobs" />

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<SortHeader list="cronjobs" field="name" label="Name" />
				{#if !app.groupedLists}<SortHeader list="cronjobs" field="namespace" label="Namespace" />{/if}
				<span class="type-colhead">Schedule</span>
				<span class="type-colhead">Suspend</span>
				<span class="type-colhead">Active</span>
				<span class="type-colhead">Last schedule</span>
				<SortHeader list="cronjobs" field="age" label="Age" />
			</div>
			<div class="bg-surface-panel">
				{#if resources.cronjobs.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No cron jobs found.</p>
				{:else}
					<GroupedRows list="cronjobs" rows={resources.cronjobs} accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp }} nouns={['cron job', 'cron jobs']}>
						{#snippet row(item, grouped)}
							<div
								class="grid items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
								style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
							>
							<span class="type-data truncate text-text-data-bright {grouped ? 'pl-4.5' : ''}">{item.name}</span>
							{#if !grouped}<span class="type-data-sm truncate text-text-secondary">{item.namespace}</span>{/if}
							<span class="type-data-sm text-text-secondary">{item.schedule}</span>
							<span class="type-data-sm" style="color: {item.suspend ? 'var(--color-status-warn)' : 'var(--color-text-secondary)'};">{item.suspend ? 'True' : 'False'}</span>
							<span class="type-data-sm text-text-secondary">{item.active}</span>
							<span class="type-data-sm text-text-secondary">{formatAge(item.last_schedule)}</span>
							<span class="type-data-sm text-text-secondary">{formatAge(item.creation_timestamp)}</span>
							</div>
						{/snippet}
					</GroupedRows>
				{/if}
			</div>
		</div>
	{/if}
</div>
