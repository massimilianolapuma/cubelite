<script lang="ts">
	import DeploymentTable from '$lib/components/DeploymentTable.svelte';
	import DeploymentDrawer from '$lib/components/deployments/DeploymentDrawer.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';

	const filtered = $derived(
		app.deploymentFilter
			? resources.deployments.filter((d) =>
					`${d.namespace}/${d.name}`.toLowerCase().includes(app.deploymentFilter.toLowerCase())
				)
			: resources.deployments
	);
</script>

<div class="flex flex-col gap-3 p-4">
	<div class="flex items-center gap-3">
		<h1 class="type-title flex-1">Deployments</h1>
		<input
			type="text"
			placeholder="Filter deployments…"
			bind:value={app.deploymentFilter}
			class="focus-ring h-7 w-52 rounded-md border border-border-default bg-surface-window px-2.5 text-[11.5px] text-text-primary placeholder:text-text-disabled"
		/>
	</div>
	<DeploymentTable
		deployments={filtered}
		selected={app.selectedDeployment}
		onRowClick={(dep) => (app.selectedDeployment = dep)}
	/>
</div>

{#if app.selectedDeployment}
	<DeploymentDrawer
		deployment={app.selectedDeployment}
		onClose={() => (app.selectedDeployment = null)}
	/>
{/if}
