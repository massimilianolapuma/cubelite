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

<!-- On is a setting, not a health state: the primary colour, never the green.
     Off is an outlined track, so the control is visible on any surface. -->
<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={label}
	class="focus-ring relative h-[26px] w-[44px] shrink-0 rounded-full border transition-colors motion-reduce:transition-none {checked
		? 'border-primary bg-primary'
		: 'border-outline-strong bg-transparent'}"
	onclick={() => onChange(!checked)}
>
	<span
		class="absolute top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full transition-[left] motion-reduce:transition-none {checked
			? 'bg-on-primary'
			: 'bg-outline-strong'}"
		style="left: {checked ? '21px' : '3px'};"
	></span>
</button>
