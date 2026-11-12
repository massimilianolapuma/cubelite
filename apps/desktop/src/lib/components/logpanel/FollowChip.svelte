<script lang="ts">
	import Pause from '@lucide/svelte/icons/pause';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';

	// Follow and pause of a live log (Tonal §8.5): following is the success
	// container with the circle, paused the warning container with a pause icon.
	let { following, onToggle }: { following: boolean; onToggle: () => void } = $props();
</script>

<button
	type="button"
	data-state={following ? 'following' : 'paused'}
	class="focus-ring type-body-sm inline-flex h-(--control-inline-h) shrink-0 items-center gap-2 rounded-full px-3.5 font-semibold hover:brightness-110 {following
		? 'bg-success-container text-on-success-container'
		: 'bg-warning-container text-on-warning-container'}"
	onclick={onToggle}
>
	{#if following}
		<StatusGlyph state="ok" />Following
	{:else}
		<Pause class="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" data-icon="pause" />Paused
	{/if}
</button>
