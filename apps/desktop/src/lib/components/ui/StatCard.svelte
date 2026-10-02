<script lang="ts">
	import type LucideIcon from '@lucide/svelte/icons/box';
	import type { StatusTone } from '$lib/status';
	import { toneColor } from '$lib/status';

	let {
		label,
		value,
		tone,
		icon: Icon,
		tint
	}: {
		label: string;
		value: string | number;
		/** Colors the value; omit for default bright text. */
		tone?: StatusTone;
		/** Lucide icon shown before the label (parity v2 §4). */
		icon?: typeof LucideIcon;
		/** CSS color for the icon (a design-token var). */
		tint?: string;
	} = $props();
</script>

<div class="rounded-xl border border-border-default bg-surface-surface px-4 py-3">
	<div class="mb-1.5 flex items-center gap-1.5">
		{#if Icon}
			<Icon class="h-3 w-3 shrink-0" strokeWidth={2.5} style="color: {tint ?? 'var(--color-text-tertiary)'};" />
		{/if}
		<span class="type-colhead">{label}</span>
	</div>
	<div
		class="type-stat"
		style="color: {tone ? toneColor[tone] : 'var(--color-text-data-bright)'};"
	>
		{value}
	</div>
</div>
