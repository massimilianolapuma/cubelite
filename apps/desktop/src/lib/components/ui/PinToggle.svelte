<script lang="ts">
	import Pin from '@lucide/svelte/icons/pin';
	import PinOff from '@lucide/svelte/icons/pin-off';
	import { app } from '#lib/stores/app.svelte.ts';
	import { navigation } from '#lib/stores/navigation.svelte.ts';
	import { profiles } from '#lib/stores/profiles.svelte.ts';

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
		class="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-md border disabled:opacity-45 {pinned
			? 'border-accent text-accent'
			: 'border-border-default bg-surface-window text-text-tertiary hover:text-text-secondary'}"
		style={pinned ? 'background: var(--alpha-selection-bg);' : undefined}
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
