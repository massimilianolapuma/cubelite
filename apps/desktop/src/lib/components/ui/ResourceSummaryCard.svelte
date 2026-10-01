<script lang="ts" module>
	import type { StatusTone } from '$lib/status';

	/** One metric row; a null value renders "—" (kind not loaded yet). */
	export type SummaryRow = { label: string; value: number | null; tone?: StatusTone | 'accent' };
</script>

<script lang="ts">
	import type { IconProps } from '@lucide/svelte';
	import Lock from '@lucide/svelte/icons/lock';
	import type { Component } from 'svelte';
	import { toneColor } from '$lib/status';

	let {
		title,
		icon: Icon,
		tint,
		rows,
		forbidden = false
	}: {
		title: string;
		icon: Component<IconProps>;
		/** CSS color for the title icon (sidebar section palette). */
		tint: string;
		rows: SummaryRow[];
		/** RBAC denied this kind: show the badge instead of the metrics. */
		forbidden?: boolean;
	} = $props();

	/** Tone colour only for non-zero values ("0 failed" stays neutral). */
	function color(tone: SummaryRow['tone'], value: number | null): string {
		if (!tone || !value) return 'var(--color-text-data-bright)';
		return tone === 'accent' ? 'var(--color-accent)' : toneColor[tone];
	}
</script>

<section
	class="flex flex-col rounded-xl border border-border-default bg-surface-surface p-4"
	aria-label={title}
>
	<div class="flex items-center gap-2 pb-2.5">
		<Icon class="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} style="color: {tint};" />
		<h2 class="type-subtitle">{title}</h2>
	</div>
	<div class="mb-2 h-px bg-border-faint"></div>
	{#if forbidden}
		<div class="flex items-center gap-1.5 py-1" data-testid="forbidden-badge">
			<span
				class="flex items-center gap-1 rounded-sm px-1.5 py-px type-micro font-mono text-status-warn"
				style="background: color-mix(in srgb, var(--color-status-warn) 12%, transparent);"
			>
				<Lock class="h-2.5 w-2.5" />
				forbidden
			</span>
			<span class="type-caption text-text-tertiary">RBAC restricted</span>
		</div>
	{:else}
		<dl class="flex flex-col gap-1">
			{#each rows as row (row.label)}
				<div class="flex items-center justify-between gap-3">
					<dt class="type-body text-text-secondary">{row.label}</dt>
					<dd class="type-data" style="color: {color(row.tone, row.value)};">
						{row.value ?? '—'}
					</dd>
				</div>
			{/each}
		</dl>
	{/if}
</section>
