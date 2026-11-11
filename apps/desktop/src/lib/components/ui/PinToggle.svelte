<script lang="ts">
	import Pin from '@lucide/svelte/icons/pin';
	import PinOff from '@lucide/svelte/icons/pin-off';
	import { app } from '#lib/stores/app.svelte.ts';
	import { navigation } from '#lib/stores/navigation.svelte.ts';
	import { profiles } from '#lib/stores/profiles.svelte.ts';
	import { iconToggle } from '#lib/ui-classes.ts';

	// Title-bar toggle (resource-kinds §3): pins the current view to the
	// active profile. Hidden types (Preferences) cannot be pinned.
	const view = $derived(app.view);
	const pinned = $derived(profiles.isPinned(view));
	const hidden = $derived(navigation.isHidden(view));
	const name = $derived(profiles.active.name);
</script>

{#if view !== 'dashboard'}
	<button
		type="button"
		class={iconToggle(pinned)}
		aria-label="Pin to {name}"
		aria-pressed={pinned}
		title={hidden && !pinned ? 'Hidden in Preferences' : pinned ? `Unpin from ${name}` : `Pin to ${name}`}
		disabled={hidden && !pinned}
		onclick={() => profiles.togglePin(view)}
	>
		{#if pinned}
			<PinOff size={14} strokeWidth={1.5} aria-hidden="true" />
		{:else}
			<Pin size={14} strokeWidth={1.5} aria-hidden="true" />
		{/if}
	</button>
{/if}
