<script lang="ts">
	import StatusGlyph, { type GlyphState } from './StatusGlyph.svelte';

	// A pill that filters a list (Tonal §7), with an optional status shape and a
	// count. Resting it is a quiet surface; pressed it takes its state's fill,
	// or the tonal primary one when it has no state.
	let {
		label,
		count,
		state,
		pressed,
		onToggle
	}: {
		label: string;
		count?: number;
		state?: GlyphState;
		pressed: boolean;
		onToggle: () => void;
	} = $props();

	const fill = $derived(
		!pressed ? 'none' : state === 'err' ? 'error' : state === 'warn' ? 'warning' : 'primary'
	);
	// Pressed adds a 1.5 px inset ring in the state's colour: the container fill alone
	// is 1.2–1.9:1 from the card, the ring reaches 3:1 on both the fill and the card
	// (WCAG 1.4.11), as on the selected segment.
	const look = {
		none: 'bg-surface-container-high text-text-muted',
		error: 'bg-error-container text-on-error-container font-semibold inset-ring-[1.5px] inset-ring-error',
		warning: 'bg-warning-container text-on-warning-container font-semibold inset-ring-[1.5px] inset-ring-warning',
		primary: 'bg-primary-container text-on-primary-container font-semibold inset-ring-[1.5px] inset-ring-primary'
	} as const;
	// Resting, the glyph keeps its state's colour; pressed, it takes the fill's text colour.
	const glyphTone = $derived(
		pressed ? '' : state === 'ok' ? 'text-success' : state === 'warn' ? 'text-warning' : state === 'err' ? 'text-error' : 'text-text-subtle'
	);
</script>

<button
	type="button"
	class="focus-ring type-body flex h-(--chip-h) shrink-0 items-center gap-2 rounded-full px-4 hover:brightness-110 {look[fill]}"
	aria-pressed={pressed}
	data-fill={fill}
	onclick={onToggle}
>
	{#if state}
		<StatusGlyph {state} class={glyphTone} />
	{/if}
	{label}
	{#if count !== undefined}
		<span class="type-data-sm font-semibold">{count}</span>
	{/if}
</button>
