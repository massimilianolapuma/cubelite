<script lang="ts">
	import SortHeader from '#lib/components/ui/SortHeader.svelte';
	import GroupedRows from '#lib/components/ui/GroupedRows.svelte';
	import ListTitle from '#lib/components/ui/ListTitle.svelte';
	import { gridColumns } from '#lib/list-group.ts';
	import { helmTone } from '#lib/status.ts';
	import { formatAge } from '#lib/age.ts';
	import StatusPill from '#lib/components/ui/StatusPill.svelte';
	import type { PillTone } from '#lib/components/ui/StatusPill.svelte';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('helm');
	});

	// Spec: deployed → ok, pending-* → warn, failed → err.
	function toneOf(status: string | null): PillTone {
		if (status === 'deployed' || status === 'superseded') return 'ok';
		if (status?.startsWith('pending')) return 'warn';
		if (status === 'failed' || status === 'unknown') return 'err';
		return 'neutral';
	}

	const grid = $derived(gridColumns(['1.6fr', '1fr', '0.4fr', '1fr', '1.4fr', '0.6fr'], app.groupedLists));
</script>

<div class="flex flex-col gap-3 p-4">
	<ListTitle title="Helm Releases" />

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<SortHeader list="helm" field="name" label="Name" />
				{#if !app.groupedLists}<SortHeader list="helm" field="namespace" label="Namespace" />{/if}
				<span class="type-colhead">Rev</span>
				<SortHeader list="helm" field="status" label="Status" />
				<span class="type-colhead">Chart</span>
				<SortHeader list="helm" field="age" label="Updated" />
			</div>
			<div class="bg-surface-panel">
				{#if resources.helmReleases.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No Helm releases found.</p>
				{:else}
					<GroupedRows list="helm" rows={resources.helmReleases} accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.updated, status: (x) => helmTone(x.status) }} nouns={['Helm release', 'Helm releases']}>
						{#snippet row(release, grouped)}
							<div
								class="grid items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
								style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
							>
								<span class="type-data truncate text-text-data-bright {grouped ? 'pl-4.5' : ''}">{release.name}</span>
								{#if !grouped}<span class="type-data-sm truncate text-text-secondary">{release.namespace}</span>{/if}
								<span class="type-data-sm text-text-secondary">{release.revision}</span>
								<span>
									<StatusPill label={release.status ?? '—'} tone={toneOf(release.status)} />
								</span>
								<span class="type-data-sm truncate {release.chart ? 'text-text-secondary' : 'text-text-disabled'}">
									{release.chart ?? '—'}
								</span>
								<span class="type-data-sm text-text-secondary">{formatAge(release.updated)}</span>
							</div>
						{/snippet}
					</GroupedRows>
				{/if}
			</div>
		</div>
	{/if}
</div>
