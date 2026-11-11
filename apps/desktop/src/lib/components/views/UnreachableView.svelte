<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';
	import StatusHero from '#lib/components/ui/StatusHero.svelte';
	import { app } from '#lib/stores/app.svelte.ts';
	import { clusters } from '#lib/stores/clusters.svelte.ts';

	// The active cluster did not answer (Tonal §8.4): a failure hero with what
	// was tried and why it failed, Retry as the one primary action.
	const server = $derived(
		clusters.contexts.find((c) => c.name === app.activeCluster)?.cluster_server ?? null
	);
</script>

<div class="flex flex-1 flex-col items-center justify-center gap-4 p-6">
	<div class="flex w-full max-w-lg flex-col gap-3">
		<StatusHero state="err" label="Cluster unreachable" reason={clusters.unreachableReason ?? undefined} heading={1} />
		{#if server}
			<p class="type-data-sm break-all text-text-muted">{server}</p>
		{/if}
		<div class="mt-1 flex items-center gap-2">
			<Button variant="primary" size="primary" onclick={() => void clusters.retry()}>Retry</Button>
			<Button variant="text" onclick={() => app.navigate('dashboard')}>All Clusters</Button>
		</div>
	</div>
</div>
