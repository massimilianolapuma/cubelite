<script lang="ts">
	import { formatAge } from '$lib/age';
	import { app } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('cronjobs');
	});

	const grid = 'grid-template-columns: 2fr 1fr 0.7fr 0.5fr 0.8fr 0.55fr;';
</script>

<div class="flex flex-col gap-3 p-4">
	<h1 class="type-title">CronJobs</h1>

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<span class="type-colhead">Name</span>
				<span class="type-colhead">Schedule</span>
				<span class="type-colhead">Suspend</span>
				<span class="type-colhead">Active</span>
				<span class="type-colhead">Last schedule</span>
				<span class="type-colhead">Age</span>
			</div>
			<div class="bg-surface-panel">
				{#if resources.cronjobs.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No cron jobs found.</p>
				{:else}
					{#each resources.cronjobs as item (item.namespace + '/' + item.name)}
						<div
							class="grid items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
							style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
						>
						<span class="type-data truncate text-text-data-bright">{item.name}</span>
						<span class="type-data-sm text-text-secondary">{item.schedule}</span>
						<span class="type-data-sm" style="color: {item.suspend ? 'var(--color-status-warn)' : 'var(--color-text-secondary)'};">{item.suspend ? 'True' : 'False'}</span>
						<span class="type-data-sm text-text-secondary">{item.active}</span>
						<span class="type-data-sm text-text-secondary">{formatAge(item.last_schedule)}</span>
						<span class="type-data-sm text-text-secondary">{formatAge(item.creation_timestamp)}</span>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>
