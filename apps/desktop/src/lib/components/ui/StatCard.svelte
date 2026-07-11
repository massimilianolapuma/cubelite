<script lang="ts">
	import type { StatusTone } from '$lib/status';
	import { toneColor } from '$lib/status';

	let {
		label,
		value,
		tone
	}: {
		label: string;
		value: string | number;
		/** Colors the value; omit for default bright text. */
		tone?: StatusTone;
	} = $props();
</script>

<div class="rounded-xl border border-border-default bg-surface-surface px-4 py-3">
	<div class="type-colhead mb-1.5">{label}</div>
	<div
		class="font-mono text-[22px] font-semibold"
		style="color: {tone ? toneColor[tone] : 'var(--color-text-data-bright)'};"
	>
		{value}
	</div>
</div>
