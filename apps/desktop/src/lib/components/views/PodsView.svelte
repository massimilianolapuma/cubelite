<script lang="ts">
	import PodTable from '$lib/components/PodTable.svelte';
	import PodDrawer from '$lib/components/pods/PodDrawer.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';

	const filtered = $derived(
		app.podFilter
			? resources.pods.filter((p) =>
					`${p.namespace}/${p.name}`.toLowerCase().includes(app.podFilter.toLowerCase())
				)
			: resources.pods
	);
</script>

<div class="flex flex-col gap-3 p-4">
	<div class="flex items-center gap-3">
		<h1 class="type-title flex-1">Pods</h1>
		<input
			type="text"
			placeholder="Filter pods…"
			bind:value={app.podFilter}
			class="focus-ring h-7 w-52 rounded-md border border-border-default bg-surface-window px-2.5 text-[11.5px] text-text-primary placeholder:text-text-disabled"
		/>
	</div>
	<PodTable
		pods={filtered}
		selected={app.selectedPod}
		onRowClick={(pod) => (app.selectedPod = pod)}
	/>
</div>

{#if app.selectedPod}
	<PodDrawer pod={app.selectedPod} onClose={() => (app.selectedPod = null)} />
{/if}
