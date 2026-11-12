<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';

	// Work in progress beside a heading (Tonal §9.1). Always in place, so nothing
	// next to it moves when work starts or ends: idle, it keeps its room and shows
	// nothing. Working, a circle turns and its words are read out; with reduced
	// motion the circle stands still and the words show beside it, unless
	// `words` is false because the section's body already says so (first load).
	let {
		label,
		active,
		words = true
	}: { label: string; active: boolean; words?: boolean } = $props();
</script>

<span
	class="inline-flex items-center gap-1.5 text-text-muted"
	data-loading
	data-active={active ? 'true' : 'false'}
>
	<LoaderCircle class="h-3 w-3 shrink-0 {active ? 'animate-spin' : 'invisible'}" aria-hidden="true" />
	<span class="type-body-sm sr-only grid motion-reduce:not-sr-only">
		<!-- Keeps the words' room whether they show or not. -->
		<span class="invisible col-start-1 row-start-1 whitespace-nowrap" aria-hidden="true">{label}</span>
		{#if active && words}
			<span class="col-start-1 row-start-1 whitespace-nowrap">{label}</span>
		{/if}
	</span>
</span>
