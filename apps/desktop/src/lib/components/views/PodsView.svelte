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

	const filtered = $derived.by(() => {
		const text = app.podFilter.trim().toLowerCase();
		return text ? resources.pods.filter((p) => `${p.namespace}/${p.name}`.toLowerCase().includes(text)) : resources.pods;
	});
</script>

<PodTable
	pods={filtered}
	total={resources.pods.length}
	filter={app.podFilter}
	selected={app.selectedPod}
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

{#if app.selectedPod}
	<PodDrawer
		pod={app.selectedPod}
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
