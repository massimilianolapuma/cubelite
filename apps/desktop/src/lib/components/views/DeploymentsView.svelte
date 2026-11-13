<script lang="ts">
	import DeploymentTable from '#lib/components/DeploymentTable.svelte';
	import DeploymentDrawer from '#lib/components/deployments/DeploymentDrawer.svelte';
	import ResourceEditor from '#lib/components/deployments/ResourceEditor.svelte';
	import { resourceEditor } from '#lib/stores/resourceEditor.svelte.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { SEARCH_FIELD } from '#lib/ui-classes.ts';

	// The panel shows the deployment as it is now, not as it was when clicked:
	// scaling from a stale replica count would send the wrong number.
	const current = $derived.by(() => {
		const sel = app.selectedDeployment;
		if (!sel) return null;
		return resources.deployments.find((d) => d.namespace === sel.namespace && d.name === sel.name) ?? sel;
	});
	// A deployment that is gone has no panel; only a list that answered can tell.
	$effect(() => {
		const sel = app.selectedDeployment;
		if (!sel || !resources.mainLoaded || resources.listError('deployments') !== null) return;
		if (!resources.deployments.some((d) => d.namespace === sel.namespace && d.name === sel.name)) {
			app.selectedDeployment = null;
		}
	});

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
	selected={current}
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

{#if current}
	<DeploymentDrawer
		deployment={current}
		onClose={() => (app.selectedDeployment = null)}
	/>
{/if}

{#if resourceEditor.target}
	<ResourceEditor />
{/if}
