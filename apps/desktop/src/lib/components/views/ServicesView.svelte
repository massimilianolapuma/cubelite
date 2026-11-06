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
		void resources.loadKind('services');
	});

	const grid = $derived(gridColumns(['2fr', '1fr', '0.9fr', '1fr', '1fr', '1.4fr', '0.55fr'], app.groupedLists));
</script>

<div class="flex flex-col gap-3 p-4">
	<ListTitle title="Services" />

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<SortHeader list="services" field="name" label="Name" />
				{#if !app.groupedLists}<SortHeader list="services" field="namespace" label="Namespace" />{/if}
				<span class="type-colhead">Type</span>
				<span class="type-colhead">Cluster-IP</span>
				<span class="type-colhead">External-IP</span>
				<span class="type-colhead">Ports</span>
				<SortHeader list="services" field="age" label="Age" />
			</div>
			<div class="bg-surface-panel">
				{#if resources.services.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No services found.</p>
				{:else}
					<GroupedRows list="services" rows={resources.services} accessors={{ name: (x) => x.name, namespace: (x) => x.namespace, created: (x) => x.creation_timestamp }} nouns={['service', 'services']}>
						{#snippet row(svc, grouped)}
							<div
								class="grid items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
								style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
							>
								<span class="type-data truncate text-text-data-bright {grouped ? 'pl-4.5' : ''}">{svc.name}</span>
								{#if !grouped}<span class="type-data-sm truncate text-text-secondary">{svc.namespace}</span>{/if}
								<span class="type-data-sm text-text-secondary">{svc.service_type ?? '—'}</span>
								<span class="type-data-sm truncate text-text-secondary">{svc.cluster_ip ?? '—'}</span>
								<span class="type-data-sm truncate {svc.external_ips.length ? 'text-text-secondary' : 'text-text-disabled'}">
									{svc.external_ips.length ? svc.external_ips.join(', ') : '—'}
								</span>
								<span class="type-data-sm truncate text-text-secondary">{svc.ports.join(', ') || '—'}</span>
								<span class="type-data-sm text-text-secondary">{formatAge(svc.creation_timestamp)}</span>
							</div>
						{/snippet}
					</GroupedRows>
				{/if}
			</div>
		</div>
	{/if}
</div>
