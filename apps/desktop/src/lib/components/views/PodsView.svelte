<script lang="ts">
	import PodTable from '#lib/components/PodTable.svelte';
	import DeletePodDialog from '#lib/components/DeletePodDialog.svelte';
	import PodDrawer from '#lib/components/pods/PodDrawer.svelte';
	import { app } from '#lib/stores/app.svelte.ts';
	import { logPanel } from '#lib/stores/logPanel.svelte.ts';
	import { mutations } from '#lib/stores/mutations.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import type { PodInfo } from '#lib/tauri.ts';
	import { SEARCH_FIELD } from '#lib/ui-classes.ts';

	let deleteTarget = $state<PodInfo | null>(null);

	async function confirmDelete() {
		if (!deleteTarget) return;
		const ok = await mutations.deletePod(deleteTarget.namespace, deleteTarget.name);
		if (ok) {
			deleteTarget = null;
			app.selectedPod = null;
		}
	}

	// The panel and the selected row show the pod as it is now, not as it was
	// when it was clicked: its state, its restarts and its containers move on.
	const current = $derived.by(() => {
		const sel = app.selectedPod;
		if (!sel) return null;
		return resources.pods.find((p) => p.namespace === sel.namespace && p.name === sel.name) ?? sel;
	});
	// A pod that is gone has no panel. Only a list that answered can tell: while
	// it loads or fails, the pod may still be there.
	$effect(() => {
		const sel = app.selectedPod;
		if (!sel || !resources.mainLoaded || resources.listError('pods') !== null) return;
		if (!resources.pods.some((p) => p.namespace === sel.namespace && p.name === sel.name)) app.selectedPod = null;
	});

	const filtered = $derived.by(() => {
		const text = app.podFilter.trim().toLowerCase();
		return text ? resources.pods.filter((p) => `${p.namespace}/${p.name}`.toLowerCase().includes(text)) : resources.pods;
	});
</script>

<PodTable
	pods={filtered}
	total={resources.pods.length}
	filter={app.podFilter}
	selected={current}
	onRowClick={(pod) => (app.selectedPod = pod)}
	onLogs={(pod) => void logPanel.openFor({ namespace: pod.namespace, name: pod.name })}
	loaded={resources.mainLoaded}
	error={resources.listError('pods')}
	busy={resources.loading}
	onRetry={() => void resources.load()}
	onClearFilter={() => (app.podFilter = '')}
>
	{#snippet tools()}
		<input
			type="text"
			placeholder="Filter pods…"
			aria-label="Filter pods"
			bind:value={app.podFilter}
			class={SEARCH_FIELD}
		/>
	{/snippet}
</PodTable>

{#if current}
	<PodDrawer
		pod={current}
		onClose={() => (app.selectedPod = null)}
		onDelete={(pod) => (deleteTarget = pod)}
	/>
{/if}

{#if deleteTarget}
	<DeletePodDialog
		pod={deleteTarget}
		confirmDisabled={false}
		onCancel={() => (deleteTarget = null)}
		onConfirm={() => void confirmDelete()}
	/>
{/if}
