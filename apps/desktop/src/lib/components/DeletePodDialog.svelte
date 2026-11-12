<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import { app } from '#lib/stores/app.svelte.ts';
	import type { PodInfo } from '#lib/tauri.ts';

	// Destructive confirm for the pod drawer's Delete action (wired in PodsView).
	// `confirmDisabled` defaults to true so a caller must opt in to enabling it.
	let {
		pod,
		onCancel,
		onConfirm,
		confirmDisabled = true
	}: {
		pod: PodInfo;
		onCancel: () => void;
		onConfirm: () => void;
		confirmDisabled?: boolean;
	} = $props();

	// What is deleted, and where (Tonal §8.6): the pod, its namespace and the
	// cluster, since the same pod name can live on several clusters.
	const facts = $derived<[string, string][]>([
		['Pod', pod.name],
		['Namespace', pod.namespace],
		['Cluster', app.activeCluster ?? '–']
	]);
</script>

<Modal title="Delete Pod" width={420} onClose={onCancel}>
	<p class="type-body text-text-muted">This deletes the pod. Its workload controller may create it again.</p>
	<ul class="mt-4 flex flex-col gap-2" aria-label="Pod to delete">
		{#each facts as [label, value] (label)}
			<li class="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-4">
				<span class="type-label text-text-muted">{label}</span>
				<!-- A pod name can be long: it wraps rather than leaving the dialog. -->
				<span class="type-data text-text [overflow-wrap:anywhere]">{value}</span>
			</li>
		{/each}
	</ul>

	{#snippet footer()}
		<Button variant="text" onclick={onCancel}>Cancel</Button>
		<Button
			variant="danger-solid"
			disabled={confirmDisabled}
			title={confirmDisabled ? 'Requires backend support' : undefined}
			onclick={onConfirm}
		>
			Delete Pod
		</Button>
	{/snippet}
</Modal>
