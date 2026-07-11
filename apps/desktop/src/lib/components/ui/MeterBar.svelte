<script lang="ts">
	let {
		label,
		/** 0–100; null renders an empty track (no data source). */
		percent
	}: { label: string; percent: number | null } = $props();

	const fill = $derived(
		percent === null
			? 'transparent'
			: percent > 75
				? 'var(--color-status-err)'
				: percent > 60
					? 'var(--color-status-warn)'
					: 'var(--color-accent)'
	);
</script>

<div class="flex items-center gap-2.5">
	<span class="type-colhead w-9 shrink-0">{label}</span>
	<div class="h-[5px] flex-1 overflow-hidden rounded-full bg-border-faint">
		<div
			class="h-full rounded-full transition-[width]"
			style="width: {percent ?? 0}%; background: {fill};"
		></div>
	</div>
	<span class="w-9 shrink-0 text-right font-mono text-[10.5px] text-text-tertiary">
		{percent === null ? '—' : `${Math.round(percent)}%`}
	</span>
</div>
