<script lang="ts">
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { app } from '$lib/stores/app.svelte';
	import { clusters } from '$lib/stores/clusters.svelte';

	const server = $derived(
		clusters.contexts.find((c) => c.name === app.activeCluster)?.cluster_server ?? null
	);
</script>

<div class="flex flex-1 flex-col items-center justify-center gap-3 p-6">
	<div
		class="flex h-12 w-12 items-center justify-center rounded-xl"
		style="background: var(--alpha-pill-err);"
	>
		<TriangleAlert class="h-5 w-5 text-status-err" />
	</div>
	<h1 class="type-title">Cluster unreachable</h1>
	<div class="text-center">
		{#if server}
			<p class="font-mono text-[11.5px] text-text-tertiary">{server}</p>
		{/if}
		{#if clusters.unreachableReason}
			<p class="type-caption mt-1 max-w-md text-text-disabled">{clusters.unreachableReason}</p>
		{/if}
	</div>
	<div class="mt-2 flex gap-2">
		<button
			type="button"
			class="focus-ring type-body flex h-7 items-center rounded-md bg-accent px-3 text-surface-window hover:brightness-110"
			onclick={() => void clusters.retry()}
		>
			Retry
		</button>
		<button
			type="button"
			class="focus-ring type-body flex h-7 items-center rounded-md border border-border-default bg-surface-raised px-3 text-text-secondary hover:brightness-110"
			onclick={() => app.navigate('dashboard')}
		>
			All Clusters
		</button>
	</div>
</div>
