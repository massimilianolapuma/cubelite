<script lang="ts">
	import type LucideIcon from '@lucide/svelte/icons/box';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import type { StatusTone } from '#lib/status.ts';
	import { toneColor } from '#lib/status.ts';

	let {
		label,
		value,
		tone,
		icon: Icon,
		tint,
		target,
		onclick
	}: {
		label: string;
		value: string | number;
		/** Colors the value; omit for default bright text. */
		tone?: StatusTone;
		/** Lucide icon shown before the label (parity v2 §4). */
		icon?: typeof LucideIcon;
		/** CSS color for the icon (a design-token var). */
		tint?: string;
		/** Name of the view `onclick` opens; part of the accessible name (#463). */
		target?: string;
		/** When set, the card is a button that navigates to `target`. */
		onclick?: () => void;
	} = $props();

	const chrome = 'rounded-xl border border-border-default bg-surface-surface px-4 py-3';
</script>

{#snippet body()}
	<div class="mb-1.5 flex items-center gap-1.5">
		{#if Icon}
			<Icon class="h-3 w-3 shrink-0" strokeWidth={2.5} style="color: {tint ?? 'var(--color-text-tertiary)'};" />
		{/if}
		<span class="type-colhead flex-1">{label}</span>
		{#if onclick}
			<ArrowRight class="h-3 w-3 shrink-0 text-text-tertiary" aria-hidden="true" />
		{/if}
	</div>
	<div
		class="type-stat"
		style="color: {tone ? toneColor[tone] : 'var(--color-text-data-bright)'};"
	>
		{value}
	</div>
{/snippet}

{#if onclick}
	<button
		type="button"
		class="focus-ring block w-full text-left hover:bg-surface-raised {chrome}"
		aria-label="{label}: {value}. Open {target ?? label}"
		{onclick}
	>
		{@render body()}
	</button>
{:else}
	<div class={chrome}>
		{@render body()}
	</div>
{/if}
