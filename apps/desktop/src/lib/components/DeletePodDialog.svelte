<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import type { PodInfo } from '#lib/tauri.ts';

	// Destructive confirm for the pod drawer's Delete action (wired in PodsView).
	// `confirmDisabled` defaults to true so a caller must opt in to enabling it.
	let {
		pod,
		cluster,
		onCancel,
		onConfirm,
		confirmDisabled = true,
		blockedReason = null
	}: {
		pod: PodInfo;
		/** The cluster the dialog was opened on, where the delete goes (#685): not the active one. */
		cluster: string;
		onCancel: () => void;
		onConfirm: () => void;
		confirmDisabled?: boolean;
		/** Why the delete is off (a read-only cluster, #662): the button says so and does nothing. */
		blockedReason?: string | null;
	} = $props();

	// What is deleted, and where (Tonal §8.6): the pod, its namespace and the
	// cluster, since the same pod name can live on several clusters.
	const facts = $derived<[string, string][]>([
		['Pod', pod.name],
		['Namespace', pod.namespace],
		['Cluster', cluster]
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
		<!-- The dialog's one primary action: 48 px (Tonal §7). -->
		<Button
			variant="danger-solid"
			size="primary"
			disabled={confirmDisabled}
			title={confirmDisabled ? 'Requires backend support' : undefined}
			{blockedReason}
			onclick={onConfirm}
		>
			Delete Pod
		</Button>
	{/snippet}
</Modal>
