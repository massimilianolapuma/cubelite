<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Modal from '#lib/components/ui/Modal.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { errorMessage } from '#lib/errors.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { applyResourceYaml, getResourceYaml, type YamlResourceType } from '#lib/tauri.ts';

	let {
		resourceType,
		namespace,
		name,
		onClose
	}: {
		resourceType: YamlResourceType;
		namespace: string;
		name: string;
		onClose: () => void;
	} = $props();

	let yaml = $state<string | null>(null);
	let error = $state<string | null>(null);
	let copied = $state(false);

	// Edit & apply (#487): the draft replaces the resource (kubectl replace).
	let editing = $state(false);
	let draft = $state('');
	let applying = $state(false);
	let applyError = $state<string | null>(null);

	$effect(() => {
		yaml = null;
		error = null;
		const kc = app.kubeconfigPath;
		const cluster = app.activeCluster;
		if (!kc || !cluster) return;
		getResourceYaml(kc, resourceType, namespace, name, cluster)
			.then((text) => (yaml = text))
			.catch((e: unknown) => (error = errorMessage(e)));
	});

	async function copy() {
		if (!yaml) return;
		try {
			await navigator.clipboard.writeText(yaml);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard may be unavailable; the selection still works.
		}
	}

	function startEditing() {
		if (yaml === null) return;
		draft = yaml;
		applyError = null;
		editing = true;
	}

	function cancelEditing() {
		editing = false;
		applyError = null;
	}

	async function apply() {
		const kc = app.kubeconfigPath;
		const cluster = app.activeCluster;
		if (!kc || !cluster || applying) return;
		applying = true;
		applyError = null;
		try {
			await applyResourceYaml(kc, resourceType, namespace, name, draft, cluster);
			onClose();
		} catch (e: unknown) {
			applyError = errorMessage(e);
		} finally {
			applying = false;
		}
	}

	/** Tab indents with two spaces instead of leaving the editor. */
	function onEditorKeydown(event: KeyboardEvent) {
		if (event.key !== 'Tab' || event.shiftKey) return;
		event.preventDefault();
		const area = event.currentTarget as HTMLTextAreaElement;
		const { selectionStart: start, selectionEnd: end } = area;
		draft = `${draft.slice(0, start)}  ${draft.slice(end)}`;
		queueMicrotask(() => area.setSelectionRange(start + 2, start + 2));
	}

</script>

<!-- The code area fits the modal at any window height, so there is one scroller,
     not two. The modal is at most 80vh; its header and body padding take 6.25rem
     (Modal.svelte). Editing, the button row holds Apply, the dialog's one primary
     action at 48 px (Tonal §7): with the gap it takes 3.75rem. The column is as
     tall as the room left (60vh of editor at most) and the editor takes what the
     error line, when there is one, leaves. -->
<Modal title="{name}.yaml" width={720} {onClose}>
	<div
		class="flex flex-col gap-3 {editing
			? 'h-[min(calc(60vh_+_3.75rem),calc(80vh_-_6.25rem))]'
			: ''}"
	>
		<div class="flex items-center justify-end gap-2">
			{#if editing}
				<Button variant="text" size="inline" disabled={applying} onclick={cancelEditing}>Cancel</Button>
				<Button variant="primary" size="primary" pending={applying} onclick={() => void apply()}>
					Apply
				</Button>
			{:else}
				<Button variant="tonal" size="inline" disabled={!yaml} onclick={startEditing}>
					{#snippet icon()}<Pencil class="h-3.5 w-3.5" aria-hidden="true" />{/snippet}
					Edit
				</Button>
				<Button variant="tonal" size="inline" disabled={!yaml} onclick={() => void copy()}>
					{#snippet icon()}
						{#if copied}
							<Check class="h-3.5 w-3.5" aria-hidden="true" />
						{:else}
							<Copy class="h-3.5 w-3.5" aria-hidden="true" />
						{/if}
					{/snippet}
					{copied ? 'Copied' : 'Copy'}
				</Button>
			{/if}
		</div>

		{#if editing}
			{#if applyError}
				<p class="type-body-sm flex shrink-0 items-start gap-2 text-text" role="alert">
					<StatusGlyph state="err" class="mt-1 text-error" />{applyError}
				</p>
			{/if}
			<textarea
				bind:value={draft}
				aria-label="Manifest YAML"
				spellcheck="false"
				autocapitalize="off"
				class="focus-ring type-log min-h-0 w-full flex-1 resize-none rounded-md bg-surface-sunken p-3 text-text"
				onkeydown={onEditorKeydown}
			></textarea>
		{:else if error}
			<p class="type-body-sm flex items-center justify-center gap-2 py-8 text-text" role="alert">
				<StatusGlyph state="err" class="text-error" />{error}
			</p>
		{:else if yaml === null}
			<p class="type-body-sm py-8 text-center text-text-muted" role="status">Loading…</p>
		{:else}
			<pre
				class="type-log max-h-[min(60vh,calc(80vh_-_9rem))] overflow-auto rounded-md bg-surface-sunken p-3 text-text">{yaml}</pre>
		{/if}
	</div>
</Modal>
