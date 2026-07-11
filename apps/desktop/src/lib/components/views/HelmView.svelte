<script lang="ts">
	import { formatAge } from '$lib/age';
	import StatusPill from '$lib/components/ui/StatusPill.svelte';
	import type { PillTone } from '$lib/components/ui/StatusPill.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';

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

	const grid = 'grid-template-columns: 1.6fr 1fr 0.4fr 1fr 1.4fr 0.6fr;';
</script>

<div class="flex flex-col gap-3 p-4">
	<h1 class="type-title">Helm Releases</h1>

	{#if resources.extraError}
		<p class="py-8 text-center text-xs text-status-err">{resources.extraError}</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border-default">
			<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
				<span class="type-colhead">Name</span>
				<span class="type-colhead">Namespace</span>
				<span class="type-colhead">Rev</span>
				<span class="type-colhead">Status</span>
				<span class="type-colhead">Chart</span>
				<span class="type-colhead">Updated</span>
			</div>
			<div class="bg-surface-panel">
				{#if resources.helmReleases.length === 0}
					<p class="py-8 text-center text-xs text-text-disabled">No Helm releases found.</p>
				{:else}
					{#each resources.helmReleases as release (release.namespace + '/' + release.name)}
						<div
							class="grid items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
							style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
						>
							<span class="type-data truncate text-text-data-bright">{release.name}</span>
							<span class="type-data-sm truncate text-text-secondary">{release.namespace}</span>
							<span class="type-data-sm text-text-secondary">{release.revision}</span>
							<span>
								<StatusPill label={release.status ?? '—'} tone={toneOf(release.status)} />
							</span>
							<span class="type-data-sm truncate {release.chart ? 'text-text-secondary' : 'text-text-disabled'}">
								{release.chart ?? '—'}
							</span>
							<span class="type-data-sm text-text-secondary">{formatAge(release.updated)}</span>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>
