<script lang="ts">
	let {
		label,
		/** 0–100; null renders an empty track (no data source). */
		percent,
		/** Absolute sub-label, e.g. "1.2 / 4.0 cores" (parity v2 §4). */
		detail = null
	}: { label: string; percent: number | null; detail?: string | null } = $props();

	// Unified thresholds (parity v2 §4): accent < 60%, warn ≥ 60%, err ≥ 75%.
	const fill = $derived(
		percent === null
			? 'transparent'
			: percent >= 75
				? 'var(--color-status-err)'
				: percent >= 60
					? 'var(--color-status-warn)'
					: 'var(--color-accent)'
	);
</script>

<div class="flex flex-col gap-1">
	<div class="flex items-center gap-2.5">
		<span class="type-colhead w-9 shrink-0">{label}</span>
		<div class="h-[5px] flex-1 overflow-hidden rounded-full bg-border-faint">
			<div
				class="h-full rounded-full transition-[width]"
				data-testid="meter-fill"
				style="width: {percent ?? 0}%; background: {fill};"
			></div>
		</div>
		<span class="w-9 shrink-0 text-right type-micro font-mono text-text-tertiary">
			{percent === null ? '—' : `${Math.round(percent)}%`}
		</span>
	</div>
	{#if detail}
		<span class="type-data-sm pl-[46px] text-text-tertiary">{detail}</span>
	{/if}
</div>
