<script lang="ts">
	let {
		checked,
		label,
		onChange
	}: {
		checked: boolean;
		/** Accessible name. */
		label: string;
		onChange: (checked: boolean) => void;
	} = $props();
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={label}
	class="focus-ring relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors"
	style="background: {checked ? 'var(--color-status-ok)' : 'var(--color-surface-raised)'};"
	onclick={() => onChange(!checked)}
>
	<span
		class="absolute top-[3px] h-4 w-4 rounded-full bg-text-primary transition-[left]"
		style="left: {checked ? '18px' : '3px'};"
	></span>
</button>
