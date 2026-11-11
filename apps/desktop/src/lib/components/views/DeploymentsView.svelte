<script lang="ts">
	import DeploymentTable from '#lib/components/DeploymentTable.svelte';
	import DeploymentDrawer from '#lib/components/deployments/DeploymentDrawer.svelte';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { SEARCH_FIELD } from '#lib/ui-classes.ts';

	const filtered = $derived.by(() => {
		const text = app.deploymentFilter.trim().toLowerCase();
		return text
			? resources.deployments.filter((d) => `${d.namespace}/${d.name}`.toLowerCase().includes(text))
			: resources.deployments;
	});
</script>

<DeploymentTable
	deployments={filtered}
	total={resources.deployments.length}
	filter={app.deploymentFilter}
	selected={app.selectedDeployment}
	onRowClick={(dep) => (app.selectedDeployment = dep)}
	loaded={resources.mainLoaded}
	error={resources.listError('deployments')}
	busy={resources.loading}
	onRetry={() => void resources.load()}
	onClearFilter={() => (app.deploymentFilter = '')}
>
	{#snippet tools()}
		<input
			type="text"
			placeholder="Filter deployments…"
			aria-label="Filter deployments"
			bind:value={app.deploymentFilter}
			class={SEARCH_FIELD}
		/>
	{/snippet}
</DeploymentTable>

{#if app.selectedDeployment}
	<DeploymentDrawer
		deployment={app.selectedDeployment}
		onClose={() => (app.selectedDeployment = null)}
	/>
{/if}
