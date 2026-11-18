<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { envPlan, leftOutText, values } from '#lib/secret-env.ts';
	import type { SecretKeyInfo } from '#lib/tauri.ts';

	// Before a Secret is saved as a .env file (#661 §3.3): what will be written in
	// plain text and what is left out, drawn from what the list holds (key names
	// and the binary mark). Nothing is read to draw it. The save dialog is the
	// system's, opened by the backend.
	let {
		name,
		keys,
		saving = false,
		onCancel,
		onSave
	}: {
		/** The Secret's name. */
		name: string;
		keys: readonly SecretKeyInfo[];
		/** The backend is asking for a path, or writing. */
		saving?: boolean;
		onCancel: () => void;
		onSave: () => void;
	} = $props();

	const plan = $derived(envPlan(keys));
	const nothing = $derived(plan.written.length === 0);
	const leftOut = $derived(plan.leftOut.length);

	// Focus starts on Cancel (Close when nothing can be written).
	let cancel = $state<HTMLElement | null>(null);
	onMount(() => cancel?.querySelector('button')?.focus());

	const list = 'type-data-sm mt-1 text-text [overflow-wrap:anywhere]';
</script>

<Modal title="Download {name} as .env" width={480} onClose={onCancel}>
	{#if nothing}
		<p class="type-body text-text">No value of {name} can be written to a .env file.</p>
	{:else}
		<p class="type-body text-text">{values(plan.written.length)} will be written to a file in plain text:</p>
		<p class={list}>{plan.written.join(', ')}</p>
	{/if}

	{#if leftOut > 0}
		<p class="type-body mt-4 text-text">{leftOut} {leftOut === 1 ? 'key is' : 'keys are'} left out:</p>
		<p class={list}>{plan.leftOut.map(leftOutText).join(', ')}</p>
	{/if}

	{#if !nothing}
		<p class="type-body-sm mt-4 text-text-muted">
			Written for a shell: <code class="type-data-sm text-text">set -a; . ./{name}.env</code>
		</p>
		<!-- The warning container, with a glyph as well as the colour. -->
		<p
			class="card type-body-sm mt-4 flex items-start gap-2 rounded-md bg-warning-container px-3 py-2.5 text-on-warning-container"
			data-env-warning
		>
			<StatusGlyph state="warn" class="mt-0.5" />
			<span>Anyone who can read the file can read these values. CubeLite does not delete it.</span>
		</p>
	{/if}

	{#snippet footer()}
		<span bind:this={cancel} class="contents">
			<Button variant="text" onclick={onCancel}>{nothing ? 'Close' : 'Cancel'}</Button>
		</span>
		{#if !nothing}
			<!-- The dialog's one primary action: 48 px (Tonal §7). -->
			<Button variant="primary" size="primary" pending={saving} onclick={onSave}>Choose where to save…</Button>
		{/if}
	{/snippet}
</Modal>
