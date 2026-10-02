<script lang="ts">
	import Modal from '#lib/components/ui/Modal.svelte';
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
</script>

<Modal title="Delete Pod" width={420} onClose={onCancel}>
	<p class="type-body text-text-secondary">
		This will delete the pod
		<span class="type-data text-text-data-bright">{pod.name}</span>
		in namespace
		<span class="type-data text-text-data-bright">{pod.namespace}</span>.
		The workload controller may recreate it.
	</p>

	{#snippet footer()}
		<button
			type="button"
			class="focus-ring type-body flex h-7 items-center rounded-md border border-border-default bg-surface-raised px-3 text-text-secondary hover:brightness-110"
			onclick={onCancel}
		>
			Cancel
		</button>
		<button
			type="button"
			disabled={confirmDisabled}
			title={confirmDisabled ? 'Requires backend support' : undefined}
			class="focus-ring type-body flex h-7 items-center rounded-md px-3 text-text-primary hover:brightness-110 disabled:opacity-45"
			style="background: var(--color-status-err-solid);"
			onclick={onConfirm}
		>
			Delete Pod
		</button>
	{/snippet}
</Modal>
