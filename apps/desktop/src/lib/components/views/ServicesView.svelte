<script lang="ts">
	import { formatAge } from '$lib/age';
	import { app } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';

	$effect(() => {
		void [app.namespace, app.activeCluster];
		void resources.loadKind('services');
	});

	const grid = 'grid-template-columns: 2fr 0.9fr 1fr 1fr 1.4fr 0.55fr;';
</script>

<div class="flex flex-col gap-3 p-4">
	<h1 class="type-title">Services</h1>

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<span class="type-colhead">Name</span>
				<span class="type-colhead">Type</span>
				<span class="type-colhead">Cluster-IP</span>
				<span class="type-colhead">External-IP</span>
				<span class="type-colhead">Ports</span>
				<span class="type-colhead">Age</span>
			</div>
			<div class="bg-surface-panel">
				{#if resources.services.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No services found.</p>
				{:else}
					{#each resources.services as svc (svc.namespace + '/' + svc.name)}
						<div
							class="grid items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
							style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
						>
							<span class="type-data truncate text-text-data-bright">{svc.name}</span>
							<span class="type-data-sm text-text-secondary">{svc.service_type ?? '—'}</span>
							<span class="type-data-sm truncate text-text-secondary">{svc.cluster_ip ?? '—'}</span>
							<span class="type-data-sm truncate {svc.external_ips.length ? 'text-text-secondary' : 'text-text-disabled'}">
								{svc.external_ips.length ? svc.external_ips.join(', ') : '—'}
							</span>
							<span class="type-data-sm truncate text-text-secondary">{svc.ports.join(', ') || '—'}</span>
							<span class="type-data-sm text-text-secondary">{formatAge(svc.creation_timestamp)}</span>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>
