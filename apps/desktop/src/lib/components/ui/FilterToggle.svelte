<script lang="ts">
	// A pressed/unpressed filter chip in a list's title bar (#574), e.g.
	// "Needs attention 3". Tinted with the tone while pressed.
	let {
		label,
		count,
		pressed,
		tone,
		onToggle
	}: {
		label: string;
		count: number;
		pressed: boolean;
		tone: 'err' | 'warn';
		onToggle: () => void;
	} = $props();

	const color = $derived(tone === 'err' ? 'var(--color-status-err)' : 'var(--color-status-warn)');
	const tint = $derived(tone === 'err' ? 'var(--alpha-pill-err)' : 'var(--alpha-pill-warn)');
</script>

<button
	type="button"
	class="focus-ring type-caption flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 {pressed
		? ''
		: 'border-border-default bg-surface-window text-text-secondary hover:text-text-primary'}"
	style={pressed ? `color: ${color}; border-color: ${color}; background: ${tint};` : undefined}
	aria-pressed={pressed}
	onclick={onToggle}
>
	{label}
	<span class="font-mono" style="color: {color};">{count}</span>
</button>
