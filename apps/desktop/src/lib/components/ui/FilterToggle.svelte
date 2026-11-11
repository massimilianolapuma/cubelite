<script lang="ts">
	import Chip from './Chip.svelte';

	// A pressed/unpressed filter chip in a list's title bar (#574), e.g.
	// "Needs attention 3". The v2 API on the Tonal chip.
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
</script>

<Chip {label} {count} state={tone} {pressed} {onToggle} />
