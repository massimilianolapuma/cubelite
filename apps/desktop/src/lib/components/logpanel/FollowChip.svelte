<script lang="ts">
	import Pause from '@lucide/svelte/icons/pause';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';

	// Follow and pause of a live log (Tonal §8.5): following is the success
	// container with the circle, paused the warning container with a pause icon.
	// In a narrow log toolbar (an @container) the word gives way to the shape; it
	// stays the button's name.
	let { following, onToggle }: { following: boolean; onToggle: () => void } = $props();
</script>

<button
	type="button"
	title={following ? 'Following: click to pause' : 'Paused: click to follow'}
	data-state={following ? 'following' : 'paused'}
	class="focus-ring type-body-sm relative inline-flex h-(--control-inline-h) shrink-0 items-center gap-2 rounded-full px-3 font-semibold hover:brightness-110 {following
		? 'bg-success-container text-on-success-container'
		: 'bg-warning-container text-on-warning-container'}"
	onclick={onToggle}
>
	{#if following}
		<StatusGlyph state="ok" /><span class="@max-[64rem]:sr-only">Following</span>
	{:else}
		<Pause class="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" data-icon="pause" /><span
			class="@max-[64rem]:sr-only">Paused</span
		>
	{/if}
</button>
