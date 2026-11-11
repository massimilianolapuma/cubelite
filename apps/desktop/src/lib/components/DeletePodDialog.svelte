<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';
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
	<p class="type-body text-text-muted">
		This will delete the pod
		<span class="type-data text-text">{pod.name}</span>
		in namespace
		<span class="type-data text-text">{pod.namespace}</span>.
		The workload controller may recreate it.
	</p>

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
