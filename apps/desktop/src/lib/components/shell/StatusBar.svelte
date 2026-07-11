<script lang="ts">
	import { app } from '$lib/stores/app.svelte';
	import { clusters } from '$lib/stores/clusters.svelte';
	import { health } from '$lib/stores/health.svelte';
	import { resources } from '$lib/stores/resources.svelte';
	import { settings } from '$lib/stores/settings.svelte';

	const server = $derived(
		clusters.contexts.find((c) => c.name === app.activeCluster)?.cluster_server ?? null
	);
	const warningCount = $derived(resources.warningEvents.length);
	const version = $derived(app.activeCluster ? health.for(app.activeCluster).version : null);
	const refreshLabel = $derived(
		settings.refreshInterval.value === 0
			? 'refresh off'
			: settings.refreshInterval.value === 60
				? 'refresh 1m'
				: `refresh ${settings.refreshInterval.value}s`
	);
</script>

<footer
	class="flex h-[27px] shrink-0 items-center gap-4 border-t border-border-faint bg-surface-panel px-3 font-mono text-[10.5px] text-text-tertiary"
>
	{#if server}
		<span class="truncate">{server}</span>
	{/if}
	{#if version}
		<span>k8s {version}</span>
	{/if}
	<span>{refreshLabel}</span>
	<span class="flex-1"></span>
	{#if warningCount > 0}
		<button
			type="button"
			class="focus-ring rounded-sm text-status-warn hover:brightness-110"
			onclick={() => app.navigate('events')}
		>
			{warningCount} warning{warningCount === 1 ? '' : 's'}
		</button>
	{/if}
</footer>
