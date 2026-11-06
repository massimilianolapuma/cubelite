<script lang="ts">
	import ListTitle from '#lib/components/ui/ListTitle.svelte';
	import DeploymentTable from '#lib/components/DeploymentTable.svelte';
	import DeploymentDrawer from '#lib/components/deployments/DeploymentDrawer.svelte';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	const filtered = $derived(
		app.deploymentFilter
			? resources.deployments.filter((d) =>
					`${d.namespace}/${d.name}`.toLowerCase().includes(app.deploymentFilter.toLowerCase())
				)
			: resources.deployments
	);
</script>

<div class="flex flex-col gap-3 p-4">
	<ListTitle title="Deployments">
		<input
			type="text"
			placeholder="Filter deployments…"
			bind:value={app.deploymentFilter}
			class="focus-ring h-7 w-52 rounded-md border border-border-default bg-surface-window px-2.5 type-caption text-text-primary placeholder:text-text-disabled"
		/>
	</ListTitle>
	<DeploymentTable
		filter={app.deploymentFilter}
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
