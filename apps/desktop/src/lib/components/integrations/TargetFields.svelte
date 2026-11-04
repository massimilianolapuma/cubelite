<script lang="ts">
	import type { Snippet } from 'svelte';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import {
		BUTTON_CLASS,
		INPUT_CLASS,
		MODE_SEGMENTS,
		type TargetForm,
		type TargetMode
	} from '#lib/integration-form.svelte.ts';

	// Where an integration's endpoint lives: off, a service found in the
	// cluster, or an external URL (shared by Elasticsearch and Prometheus).
	let {
		form,
		segments = MODE_SEGMENTS,
		sourceLabel,
		urlLabel,
		urlPlaceholder,
		httpsLabel,
		detectHint,
		detecting,
		disabled,
		onDetect,
		detected
	}: {
		form: TargetForm;
		/** Modes offered (the default endpoint is external only, #528). */
		segments?: { value: TargetMode; label: string }[];
		sourceLabel: string;
		urlLabel: string;
		urlPlaceholder: string;
		httpsLabel: string;
		detectHint: string;
		detecting: boolean;
		disabled: boolean;
		onDetect: () => void;
		/** The detected services list, when Detect ran. */
		detected?: Snippet;
	} = $props();
</script>

<div class="flex items-center justify-between gap-3">
	<span class="type-caption text-text-secondary">{sourceLabel}</span>
	<SegmentedControl {segments} bind:value={form.mode} />
</div>

{#if form.mode === 'in-cluster'}
	<div class="flex items-center gap-2">
		<button type="button" class={BUTTON_CLASS} {disabled} onclick={onDetect}>
			{detecting ? 'Detecting…' : 'Detect'}
		</button>
		<span class="type-caption text-text-tertiary">{detectHint}</span>
	</div>
	{@render detected?.()}
	<div class="grid grid-cols-[1fr_1.4fr_5rem] gap-2">
		<input class={INPUT_CLASS} aria-label="Namespace" placeholder="namespace" bind:value={form.namespace} />
		<input class={INPUT_CLASS} aria-label="Service" placeholder="service" bind:value={form.service} />
		<input class={INPUT_CLASS} aria-label="Port" type="number" min="1" max="65535" bind:value={form.port} />
	</div>
	<label class="type-caption flex items-center gap-2 text-text-secondary">
		<input type="checkbox" bind:checked={form.https} /> {httpsLabel}
	</label>
{:else if form.mode === 'external'}
	<input class={INPUT_CLASS} aria-label={urlLabel} placeholder={urlPlaceholder} bind:value={form.url} />
	{#if form.urlError}<p class="type-caption text-status-err">{form.urlError}</p>{/if}
{/if}
