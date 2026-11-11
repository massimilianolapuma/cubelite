<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';
	import { Portal } from 'bits-ui';
	import X from '@lucide/svelte/icons/x';
	import Button from './Button.svelte';
	import { layout } from '#lib/stores/layout.svelte.ts';

	// The detail panel of a selected object (Tonal §8.3). It is a card beside
	// the list when the content column has room for both, and lies over the
	// list otherwise. Never modal: the list stays operable in both modes.
	let {
		kind,
		title,
		onClose,
		onPrimary,
		children,
		footer
	}: {
		/** What the object is, e.g. "Pod"; shown above its name. */
		kind?: string;
		title: string;
		onClose: () => void;
		/**
		 * The panel's primary action. Enter on the heading runs it: opening the
		 * panel moves focus there, so Enter on a row and Enter again still reach it.
		 */
		onPrimary?: () => void;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	// The app shell provides the host beside the content card. Without it
	// (isolated component tests) the panel renders in place.
	const host =
		typeof document === 'undefined'
			? null
			: document.querySelector<HTMLElement>('[data-drawer-host]');

	const mode = $derived(layout.docked ? 'docked' : 'overlay');

	let root = $state<HTMLElement | null>(null);
	let heading = $state<HTMLElement | null>(null);

	// Opening moves focus to the heading; closing gives it back to the row it
	// came from, unless the user has meanwhile moved on to something else. The
	// heading exists only once the portal has rendered, which is after mount:
	// hence an effect that runs when it appears, once.
	let opener: HTMLElement | null = null;
	let opened = false;
	$effect(() => {
		if (!heading || opened) return;
		opened = true;
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		heading.focus({ preventScroll: true });
	});
	onDestroy(() => {
		const active = document.activeElement;
		const stillHere = active === null || active === document.body || (root?.contains(active) ?? false);
		if (stillHere && opener?.isConnected) opener.focus({ preventScroll: true });
	});

	function headingKey(event: KeyboardEvent) {
		if (event.key !== 'Enter' || !onPrimary) return;
		event.preventDefault();
		onPrimary();
	}
</script>

<Portal to={host ?? undefined} disabled={!host}>
	<div
		bind:this={root}
		class="flex w-[360px] max-w-full shrink-0 flex-col rounded-xl {mode === 'docked'
			? 'ml-3 bg-surface-container'
			: 'animate-drawer-in absolute inset-y-0 right-0 z-30 bg-surface-overlay shadow-overlay'}"
		role="dialog"
		aria-label={title}
		data-mode={mode}
	>
		<header class="flex items-start gap-3 px-4 pt-4 pb-3">
			<div class="min-w-0 flex-1">
				{#if kind}
					<div class="type-label mb-1 text-text-muted">{kind}</div>
				{/if}
				<!-- Focusable from script only: it is where focus lands when the panel opens,
				     and Enter there is the panel's primary action. -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<h2
					bind:this={heading}
					tabindex="-1"
					class="focus-ring type-data rounded-xs break-words text-text"
					onkeydown={headingKey}
				>
					{title}
				</h2>
			</div>
			<Button variant="text" size="inline" iconOnly label="Close" class="-mt-1 -mr-1" onclick={onClose}>
				{#snippet icon()}<X class="h-4 w-4" aria-hidden="true" />{/snippet}
			</Button>
		</header>

		<div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4" data-panel-body>
			{@render children()}
		</div>

		{#if footer}
			<footer class="flex flex-wrap items-center gap-2 px-4 py-3">
				{@render footer()}
			</footer>
		{/if}
	</div>
</Portal>
