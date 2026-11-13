<script lang="ts">
	import { onDestroy } from 'svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import ResourceEditorFields from './ResourceEditorFields.svelte';
	import ResourceFindings from './ResourceFindings.svelte';
	import ResourceNodes from './ResourceNodes.svelte';
	import { EMPTY } from '#lib/empty.ts';
	import {
		changeLabel,
		editableContainers,
		managerLabel,
		managerSentence,
		needsConfirmation,
		nodeRows,
		rolloutSentence
	} from '#lib/resource-editor.ts';
	import { PANEL_CARD, PANEL_SECTION } from '#lib/ui-classes.ts';
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

	// Step 2: what the dry run answered (the last check of the drafts until it does).
	const findings = $derived(ed.evaluation?.findings ?? []);
	const blockedFindings = $derived(findings.filter((f) => f.level === 'blocked'));
	const warnings = $derived(findings.filter((f) => f.level === 'warning' || f.level === 'not_checked'));
	const notes = $derived(findings.filter((f) => f.level === 'note'));
	const anyway = $derived(ed.evaluation !== null && needsConfirmation(ed.evaluation));
	const primaryLabel = $derived(
		`${ed.mode === 'restore' ? 'Restore' : 'Apply'}${anyway ? ' anyway' : ''}`
	);
	const happens = $derived(
		ed.facts === null
			? []
			: [
					rolloutSentence(ed.facts.workload),
					managerSentence(ed.facts.workload.manager),
					ed.mode === 'restore'
						? 'The override mark is removed.'
						: 'CubeLite marks the deployment as overridden, so the change stays visible and can be restored.'
				]
	);
	const stepError = $derived(ed.applyError ?? ed.dryRunError);

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

<!-- A message from the cluster or the check: a long token in it (a URL, a policy
     id) wraps instead of running out of the card. -->
{#snippet problem(text: string)}
	<p class="type-body-sm flex items-start gap-2 text-text" role="alert">
		<StatusGlyph state="err" class="mt-1 shrink-0 text-error" />
		<span class="min-w-0 break-words">{text}</span>
	</p>
{/snippet}

<!-- What decides the primary button, kept in view under the scrolling body: on
     step 1 the check's findings, on step 2 the dry run's answer. -->
{#snippet check()}
	{#if ed.step === 'review'}
		<!-- One line is kept, so the answer arriving moves nothing. -->
		<div class="min-h-5">
			{#if ed.dryRun === 'running'}
				<p class="type-body-sm text-text-muted" role="status">Checking with the cluster…</p>
			{:else if stepError !== null}
				{@render problem(stepError)}
			{:else if ed.dryRun === 'ok'}
				<p class="type-body-sm flex items-start gap-2 text-text-muted" role="status">
					<StatusGlyph state="ok" class="mt-1 shrink-0 text-success" />
					<span>The cluster accepts this change.</span>
				</p>
			{/if}
		</div>
	{:else if ed.evaluateError !== null}
		{@render problem(ed.evaluateError)}
	{:else if ed.evaluation !== null}
		<ResourceFindings findings={ed.evaluation.findings} stale={ed.evaluating} />
	{/if}
{/snippet}

{#if target !== null}
	<!-- Held at the top: the body grows as the facts and the check arrive, and changes
	     with the step; the title and the header line must not move with it. -->
	<Modal
		{title}
		width={640}
		onClose={() => ed.close()}
		focusableTitle
		placement="top"
		bind:heading
		scrollLabel={ed.step === 'review' ? 'The change and what happens' : 'Containers and nodes'}
		pinned={ed.facts !== null && !ed.loading && ed.factsError === null ? check : undefined}
		pinnedLabel={ed.step === 'review' ? 'Dry run' : 'Check'}
	>
		<div class="flex flex-col gap-4" data-editor-step={ed.step}>
			<p class="type-body-sm text-text-muted" data-testid="editor-context">
				{#each context as part, i (i)}{#if i > 0}{SEPARATOR}{/if}{@render sentence(part)}{/each}
			</p>

			{#if ed.loading}
				<p class="type-body-sm text-text-muted" role="status">Reading the cluster…</p>
			{:else if ed.factsError !== null}
				<div class="flex flex-col items-start gap-3">
					{@render problem(ed.factsError)}
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
			{:else if ed.facts !== null && ed.step === 'review'}
				{#if ed.evaluation !== null}
					<div class="{PANEL_CARD} flex flex-col gap-1.5 px-3 py-2.5">
						<ul role="list" aria-label="Changes" class="flex flex-col gap-1">
							{#each ed.evaluation.changes as change (`${change.container}/${change.resource}.${change.field}`)}
								<li
									class="grid grid-cols-[minmax(0,1fr)_7.5rem_auto] items-baseline gap-x-3"
									data-change="{change.container}/{change.resource}.{change.field}"
								>
									<span class="type-data-sm min-w-0 break-words text-text">{change.container}</span>
									<span class="type-body-sm text-text-muted">{changeLabel(change)}</span>
									<span class="type-data-sm text-right whitespace-nowrap text-text">
										{change.before ?? EMPTY} → <span class="font-semibold">{change.after ?? EMPTY}</span>
									</span>
								</li>
							{/each}
						</ul>
						<p class="type-body-sm text-text-muted">(nothing else changes)</p>
					</div>
				{/if}

				<section aria-labelledby="editor-happens">
					<h3 id="editor-happens" class={PANEL_SECTION}>What happens</h3>
					<ul role="list" aria-label="What happens" class="type-body-sm flex flex-col gap-1.5 text-text">
						{#each happens as line, i (i)}
							<li class="flex items-start gap-2">
								<!-- A character, not a filled dot: forced colours keep it. -->
								<span class="shrink-0 text-text-muted" aria-hidden="true">•</span>
								<span>{@render sentence(line)}</span>
							</li>
						{/each}
					</ul>
				</section>

				{#if blockedFindings.length > 0}
					<ResourceFindings findings={blockedFindings} label="Cannot be applied" />
				{/if}
				{#if warnings.length > 0}
					<section aria-labelledby="editor-warnings">
						<h3 id="editor-warnings" class={PANEL_SECTION}>Warnings ({warnings.length})</h3>
						<ResourceFindings findings={warnings} label="Warnings" />
					</section>
				{/if}
				{#if notes.length > 0}
					<ResourceFindings findings={notes} label="Notes" />
				{/if}
			{/if}
		</div>

		{#snippet footer()}
			{#if ed.step === 'review'}
				{#if ed.mode === 'adjust'}
					<Button variant="text" size="inline" disabled={ed.applying} onclick={() => ed.back()}>Back</Button>
				{:else}
					<Button variant="text" size="inline" disabled={ed.applying} onclick={() => ed.close()}>Cancel</Button>
				{/if}
				<Button
					variant="primary"
					size="primary"
					pending={ed.applying}
					disabled={ed.dryRun !== 'ok'}
					onclick={() => void ed.apply()}
				>
					{primaryLabel}
				</Button>
			{:else}
				<Button variant="text" size="inline" onclick={() => ed.close()}>Cancel</Button>
				<Button variant="primary" size="primary" disabled={!ed.canReview} onclick={() => void ed.review()}>
					Review
				</Button>
			{/if}
		{/snippet}
	</Modal>
{/if}
