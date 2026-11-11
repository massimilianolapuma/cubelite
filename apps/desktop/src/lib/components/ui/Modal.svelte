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
		footer
	}: {
		title: string;
		width?: number;
		onClose: () => void;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	// Esc closes the topmost overlay: register so app.closeTopOverlay() reaches
	// this modal before any drawer underneath it.
	onMount(() => app.pushModal(() => onClose()));
</script>

<div
	class="animate-fadein fixed inset-0 z-40"
	style="background: color-mix(in srgb, black 50%, transparent);"
	role="presentation"
	onclick={onClose}
></div>
<div
	class="animate-popin fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-surface-overlay shadow-overlay"
	style="width: {width}px;"
	role="dialog"
	aria-modal="true"
	aria-label={title}
>
	<header class="flex items-center justify-between gap-3 px-6 pt-5 pb-3">
		<h2 class="type-headline min-w-0 truncate">{title}</h2>
		<button
			type="button"
			aria-label="Close"
			class="focus-ring -mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-subtle hover:bg-surface-container-high hover:text-text-muted"
			onclick={onClose}
		>
			<X class="h-4 w-4" aria-hidden="true" />
		</button>
	</header>
	<div class="flex-1 overflow-y-auto px-6 py-2">
		{@render children()}
	</div>
	{#if footer}
		<footer class="flex justify-end gap-2 px-6 pt-3 pb-5">
			{@render footer()}
		</footer>
	{/if}
</div>
