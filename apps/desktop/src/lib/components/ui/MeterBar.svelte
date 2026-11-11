<script lang="ts">
	import StatusGlyph from './StatusGlyph.svelte';

	let {
		label,
		/** 0–100; null renders an empty track (no data source). */
		percent,
		/** Absolute sub-label, e.g. "1.2 / 4.0 cores" (parity v2 §4). */
		detail = null
	}: { label: string; percent: number | null; detail?: string | null } = $props();

	// Unified thresholds (parity v2 §4): high from 60%, critical from 75%. A
	// threshold is a shape and a bold value as well as a colour (Tonal §7).
	const level = $derived(
		percent === null ? 'none' : percent >= 75 ? 'critical' : percent >= 60 ? 'high' : 'normal'
	);
	const look = {
		none: { fill: '', tone: 'text-text-subtle', glyph: null },
		normal: { fill: 'bg-primary', tone: 'text-text-muted', glyph: null },
		high: { fill: 'bg-warning', tone: 'text-warning', glyph: 'warn' },
		critical: { fill: 'bg-error', tone: 'text-error', glyph: 'err' }
	} as const;
	const style = $derived(look[level]);
</script>

<div class="flex flex-col gap-1" data-level={level}>
	<div class="flex items-center gap-2.5">
		<span class="type-label w-9 shrink-0">{label}</span>
		<div class="h-2 flex-1 overflow-hidden rounded-full bg-outline">
			<div
				class="h-full rounded-full transition-[width] motion-reduce:transition-none {style.fill}"
				data-testid="meter-fill"
				style="width: {percent ?? 0}%;"
			></div>
		</div>
		<span class="flex w-12 shrink-0 items-center justify-end gap-1 {style.tone}">
			{#if style.glyph}
				<StatusGlyph state={style.glyph} size={7} />
			{/if}
			<span class="type-data-sm {style.glyph ? 'font-bold' : ''}" data-testid="meter-value">
				{percent === null ? '–' : `${Math.round(percent)}%`}
			</span>
		</span>
	</div>
	{#if detail}
		<span class="type-data-sm pl-[46px] text-text-subtle">{detail}</span>
	{/if}
</div>
