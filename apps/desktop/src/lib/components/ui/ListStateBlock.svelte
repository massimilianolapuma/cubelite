<script lang="ts">
	import Button from './Button.svelte';
	import StatusGlyph from './StatusGlyph.svelte';
	import type { ListState } from '#lib/list-state.ts';

	// What a list shows instead of rows (Tonal §8.2). Every state has its own
	// words, and the ones that are not plain text also a shape, so none of them
	// is told apart by colour.
	let {
		state,
		plural,
		busy = false,
		onRetry,
		onClear
	}: {
		state: Exclude<ListState, { kind: 'ready' }>;
		/** Plural row noun, e.g. "pods". */
		plural: string;
		/** A retry is in flight. */
		busy?: boolean;
		onRetry?: () => void;
		onClear?: () => void;
	} = $props();

	const PLACEHOLDERS = [0, 1, 2, 3, 4, 5];
</script>

{#if state.kind === 'loading'}
	<div
		class="flex flex-col gap-0.5"
		role="status"
		aria-label="Loading {plural}"
		aria-busy="true"
		data-list-state="loading"
	>
		{#each PLACEHOLDERS as i (i)}
			<div class="h-(--row-h) rounded-md bg-surface-container-high motion-safe:animate-pulse" data-placeholder></div>
		{/each}
	</div>
{:else if state.kind === 'error'}
	<div
		class="flex flex-col items-start gap-3 rounded-lg bg-error-container p-4 text-on-error-container"
		role="alert"
		data-list-state="error"
	>
		<h2 class="type-title flex items-center gap-2">
			<StatusGlyph state="err" />
			{state.title}
		</h2>
		<p class="type-data max-w-full break-words">{state.message}</p>
		{#if onRetry}
			<Button variant="tonal" pending={busy} onclick={onRetry}>Retry</Button>
		{/if}
	</div>
{:else if state.kind === 'forbidden' || state.kind === 'unavailable'}
	<div class="flex items-center justify-center gap-2.5 px-4 py-12 text-text-muted" role="status" data-list-state={state.kind}>
		<StatusGlyph state="unknown" size={12} />
		<p class="type-body">{state.kind === 'forbidden' ? state.title : 'Not available on this cluster'}</p>
	</div>
{:else}
	<div class="flex flex-col items-center gap-2 px-4 py-12 text-center" data-list-state={state.kind}>
		<h2 class="type-headline">{state.title}</h2>
		{#if state.kind === 'empty'}
			<p class="type-body-sm text-text-muted">{state.hint}</p>
		{:else if onClear}
			<Button variant="text" onclick={onClear}>Clear filter</Button>
		{/if}
	</div>
{/if}
