<script lang="ts">
	import StatusBadge from './StatusBadge.svelte';
	import StatusGlyph, { type GlyphState } from './StatusGlyph.svelte';

	// The state of the object a detail panel shows (Tonal §8.3). Attention and
	// failure are a hero in the state's container: the state as a headline, the
	// reason under it. Healthy, finished and unknown stay one plain line.
	let {
		state,
		label,
		reason,
		heading
	}: {
		state: GlyphState;
		label: string;
		reason?: string;
		/** Makes the hero's label a heading of this level: on a view it is the title. */
		heading?: 1 | 2;
	} = $props();

	const fill = $derived(state === 'warn' ? 'warning' : state === 'err' ? 'error' : 'none');
	const look = {
		warning: 'bg-warning-container text-on-warning-container',
		error: 'bg-error-container text-on-error-container'
	} as const;
</script>

{#if fill === 'none'}
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1" data-hero="none">
		<StatusBadge {state} {label} />
		{#if reason}
			<span class="type-body-sm text-text-muted">{reason}</span>
		{/if}
	</div>
{:else}
	<div class="flex flex-col gap-1 rounded-lg p-4 {look[fill]}" data-hero={fill}>
		<div class="type-headline flex min-w-0 items-center gap-2.5 text-inherit">
			<StatusGlyph {state} size={12} />
			<span class="min-w-0 break-words" role={heading ? 'heading' : undefined} aria-level={heading}>{label}</span>
		</div>
		{#if reason}
			<p class="type-body-sm">{reason}</p>
		{/if}
	</div>
{/if}
