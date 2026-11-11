<script lang="ts">
	import type LucideIcon from '@lucide/svelte/icons/box';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import StatusGlyph from './StatusGlyph.svelte';
	import type { StatusTone } from '#lib/status.ts';

	let {
		label,
		value,
		tone,
		icon: Icon,
		target,
		onclick
	}: {
		label: string;
		value: string | number;
		/** A value that needs attention fills the tile; healthy and neutral stay plain. */
		tone?: StatusTone;
		/** Lucide icon shown before the label (parity v2 §4). */
		icon?: typeof LucideIcon;
		/** Name of the view `onclick` opens; part of the accessible name (#463). */
		target?: string;
		/** When set, the card is a button that navigates to `target`. */
		onclick?: () => void;
	} = $props();

	// A tile (Tonal §7): the label, then the one number that explains a state.
	// Only warning and failure are filled, each with its shape.
	const fill = $derived(tone === 'warn' || tone === 'err' ? tone : 'none');
	const look = {
		none: 'bg-surface-container-high text-text',
		warn: 'bg-warning-container text-on-warning-container',
		err: 'bg-error-container text-on-error-container'
	} as const;
	const chrome = $derived(`rounded-lg px-4 py-3 ${look[fill]}`);
</script>

{#snippet body()}
	<div class="mb-1.5 flex items-center gap-1.5 {fill === 'none' ? 'text-text-subtle' : ''}">
		{#if fill !== 'none'}
			<StatusGlyph state={fill} />
		{:else if Icon}
			<Icon class="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
		{/if}
		<span class="type-label flex-1 text-inherit">{label}</span>
		{#if onclick}
			<ArrowRight class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
		{/if}
	</div>
	<div class="type-stat text-inherit">{value}</div>
{/snippet}

{#if onclick}
	<button
		type="button"
		class="focus-ring block w-full text-left hover:brightness-110 {chrome}"
		data-tone={fill}
		aria-label="{label}: {value}. Open {target ?? label}"
		{onclick}
	>
		{@render body()}
	</button>
{:else}
	<div class={chrome} data-tone={fill}>
		{@render body()}
	</div>
{/if}
