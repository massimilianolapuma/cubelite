<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import X from '@lucide/svelte/icons/x';
	import { app } from '#lib/stores/app.svelte.ts';

	let {
		title,
		width = 520,
		onClose,
		children,
		footer,
		heading = $bindable(null),
		focusableTitle = false,
		placement = 'center',
		pinned,
		pinnedLabel,
		scrollLabel
	}: {
		title: string;
		width?: number;
		onClose: () => void;
		children: Snippet;
		footer?: Snippet;
		/** The title element, for a dialog that moves focus to it (a step of a wizard). */
		heading?: HTMLElement | null;
		/** The title takes focus from script (`tabindex="-1"`); off by default. */
		focusableTitle?: boolean;
		/**
		 * `top` holds the dialog's top edge at 10% of the window, so a body that grows
		 * (content arriving, a step changing) grows downwards and the title stays put.
		 * Centred, the whole dialog would move.
		 */
		placement?: 'center' | 'top';
		/**
		 * What must stay in view while the body scrolls (a check's findings, the
		 * answer of a request): between the body and the footer, outside the body's
		 * scroll. Its height is capped; past the cap it scrolls on its own.
		 */
		pinned?: Snippet;
		/** Names the pinned region; it is then a keyboard stop while its content overflows. */
		pinnedLabel?: string;
		/**
		 * Makes the scrolling body a keyboard stop, a region with this name. Chromium
		 * focuses a scroller by itself, WebKit may not: without it a keyboard user
		 * could not scroll a body whose controls are all out of view or disabled.
		 */
		scrollLabel?: string;
	} = $props();

	// Esc closes the topmost overlay: register so app.closeTopOverlay() reaches
	// this modal before any drawer underneath it.
	onMount(() => app.pushModal(() => onClose()));

	// The pinned region takes the keyboard only when there is something to scroll.
	let pinnedEl = $state<HTMLElement | null>(null);
	let pinnedOverflows = $state(false);
	$effect(() => {
		const el = pinnedEl;
		if (el === null || pinnedLabel === undefined) return;
		const measure = () => (pinnedOverflows = el.scrollHeight > el.clientHeight + 1);
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		for (const child of el.children) observer.observe(child);
		const mutations = new MutationObserver(() => {
			for (const child of el.children) observer.observe(child);
			measure();
		});
		mutations.observe(el, { childList: true, subtree: true, characterData: true });
		measure();
		return () => {
			observer.disconnect();
			mutations.disconnect();
		};
	});
</script>

<!-- Backdrop: black at 50 % (Tonal §7). -->
<div class="animate-fadein fixed inset-0 z-40 bg-black/50" role="presentation" onclick={onClose}></div>
<div
	class="card animate-popin fixed left-1/2 z-50 flex max-h-[80vh] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col overflow-hidden rounded-xl bg-surface-overlay shadow-overlay {placement ===
	'top'
		? 'top-[10vh]'
		: 'top-1/2 -translate-y-1/2'}"
	data-placement={placement}
	style="width: {width}px;"
	role="dialog"
	aria-modal="true"
	aria-label={title}
>
	<header class="flex shrink-0 items-center justify-between gap-3 px-6 pt-5 pb-3">
		<!-- -1 or nothing: the title takes focus from script only, never from Tab. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<h2
			bind:this={heading}
			class="type-headline min-w-0 truncate {focusableTitle ? 'focus-ring rounded-xs' : ''}"
			{title}
			tabindex={focusableTitle ? -1 : undefined}
		>
			{title}
		</h2>
		<button
			type="button"
			aria-label="Close"
			class="focus-ring forced-edge hover-layer -mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-muted"
			onclick={onClose}
		>
			<X class="h-4 w-4" aria-hidden="true" />
		</button>
	</header>
	<!-- Without a footer the body owns the bottom gutter. Only the body scrolls: the
	     title and the actions stay in the window however short it is. Scroll padding
	     keeps a control the focus scrolls into view clear of the edge, so its 4 px
	     ring is not cut. `relative`: what is positioned inside (a visually hidden
	     label) is placed against the body, not the card, so the card never scrolls. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="relative min-h-0 flex-1 scroll-py-2 overflow-y-auto px-6 pt-2 {footer || pinned ? 'pb-2' : 'pb-6'} {scrollLabel
			? 'focus-ring-inset'
			: ''}"
		role={scrollLabel ? 'region' : undefined}
		aria-label={scrollLabel}
		tabindex={scrollLabel ? 0 : undefined}
	>
		{@render children()}
	</div>
	{#if pinned}
		<!-- A rule above it: the body scrolls behind this line, the pinned part does not. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			bind:this={pinnedEl}
			class="relative max-h-[min(30vh,12rem)] shrink-0 overflow-y-auto border-t border-outline px-6 pt-3 {footer
				? 'pb-1'
				: 'pb-6'} {pinnedLabel ? 'focus-ring-inset' : ''}"
			data-modal-pinned
			role={pinnedLabel ? 'region' : undefined}
			aria-label={pinnedLabel}
			tabindex={pinnedLabel && pinnedOverflows ? 0 : undefined}
		>
			{@render pinned()}
		</div>
	{/if}
	{#if footer}
		<footer class="flex shrink-0 items-center justify-end gap-2 px-6 pt-3 pb-5">
			{@render footer()}
		</footer>
	{/if}
</div>
