<script lang="ts">
	import { onDestroy } from 'svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import ResourceEditorFields from './ResourceEditorFields.svelte';
	import ResourceFindings from './ResourceFindings.svelte';
	import ResourceNodes from './ResourceNodes.svelte';
	import { editableContainers, managerLabel, nodeRows } from '#lib/resource-editor.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { resourceEditor } from '#lib/stores/resourceEditor.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';

	// The resources editor (spec #650 §3.2): a modal over one deployment, step 1
	// edits, step 2 reviews and applies. A thin view of `resourceEditor`, which
	// holds the facts, what is typed, the core's check and the apply.
	const ed = resourceEditor;
	// Between the parts of the header line.
	const SEPARATOR = ' · ';

	const target = $derived(ed.target);
	const name = $derived(target?.name ?? '');
	const title = $derived(
		ed.mode === 'restore' ? `Restore · ${name}` : ed.step === 'review' ? `Review · ${name}` : `Adjust resources · ${name}`
	);

	// The header line: the facts once read, the list's deployment before that.
	const listed = $derived(
		target === null
			? null
			: (resources.deployments.find((d) => d.namespace === target.namespace && d.name === target.name) ?? null)
	);
	const replicas = $derived(ed.facts?.workload.replicas ?? listed?.replicas ?? null);
	const manager = $derived(ed.facts?.workload.manager ?? listed?.manager ?? null);
	const context = $derived(
		[
			target?.namespace ?? null,
			app.activeCluster,
			replicas === null ? null : replicas === 1 ? '1 replica' : `${replicas} replicas`,
			manager === null ? null : managerLabel(manager)
		].filter((part): part is string => part !== null && part !== '')
	);

	const containers = $derived(ed.facts === null ? [] : editableContainers(ed.facts));
	const nodes = $derived(ed.evaluation === null ? null : nodeRows(ed.evaluation));

	// Focus: each step starts at its heading; closing returns it to what opened the editor.
	let heading = $state<HTMLElement | null>(null);
	$effect(() => {
		void ed.step;
		const h = heading;
		if (h !== null) queueMicrotask(() => h.focus());
	});

	let opener: HTMLElement | null = null;
	let wasOpen = false;
	$effect.pre(() => {
		const open = ed.target !== null;
		if (open && !wasOpen) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (!open && wasOpen) returnFocus();
		wasOpen = open;
	});
	onDestroy(() => {
		if (wasOpen) returnFocus();
	});

	/**
	 * Back to the element that opened the editor, once the editor is gone; when that
	 * element went meanwhile (the banner of a restored deployment, the pod panel),
	 * to the deployment panel's Adjust.
	 */
	function returnFocus() {
		const back = opener;
		opener = null;
		queueMicrotask(() => {
			const into =
				back !== null && back.isConnected && back !== document.body
					? back
					: document.querySelector<HTMLElement>('[data-resource-adjust]');
			into?.focus();
		});
	}

	/** A sentence with `quoted` parts: those are names, in the data face. */
	function parts(text: string): { text: string; code: boolean }[] {
		return text.split('`').map((t, i) => ({ text: t, code: i % 2 === 1 }));
	}
</script>

{#snippet sentence(text: string)}
	{#each parts(text) as part, i (i)}{#if part.code}<span class="type-data-sm">{part.text}</span>{:else}{part.text}{/if}{/each}
{/snippet}

{#if target !== null}
	<Modal {title} width={640} onClose={() => ed.close()} focusableTitle bind:heading>
		<div class="flex flex-col gap-4" data-editor-step={ed.step}>
			<p class="type-body-sm text-text-muted" data-testid="editor-context">
				{#each context as part, i (i)}{#if i > 0}{SEPARATOR}{/if}{@render sentence(part)}{/each}
			</p>

			{#if ed.loading}
				<p class="type-body-sm text-text-muted" role="status">Reading the cluster…</p>
			{:else if ed.factsError !== null}
				<div class="flex flex-col items-start gap-3">
					<p class="type-body-sm flex items-start gap-2 text-text" role="alert">
						<StatusGlyph state="err" class="mt-1 text-error" />
						<span>{ed.factsError}</span>
					</p>
					<Button variant="tonal" size="inline" onclick={() => void ed.retry()}>Try again</Button>
				</div>
			{:else if ed.facts !== null && ed.step === 'edit'}
				<div class="flex flex-col gap-2">
					{#each containers as container (container.name)}
						<ResourceEditorFields {container} facts={ed.facts} />
					{/each}
				</div>

				{#if nodes !== null}
					<ResourceNodes rows={nodes} />
				{/if}

				{#if ed.evaluateError !== null}
					<p class="type-body-sm flex items-start gap-2 text-text" role="alert">
						<StatusGlyph state="err" class="mt-1 text-error" />
						<span>{ed.evaluateError}</span>
					</p>
				{:else if ed.evaluation !== null}
					<ResourceFindings findings={ed.evaluation.findings} stale={ed.evaluating} />
				{/if}
			{/if}
		</div>

		{#snippet footer()}
			<Button variant="text" size="inline" onclick={() => ed.close()}>Cancel</Button>
			<Button variant="primary" size="primary" disabled={!ed.canReview} onclick={() => void ed.review()}>
				Review
			</Button>
		{/snippet}
	</Modal>
{/if}
