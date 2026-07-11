<script lang="ts">
	import type { Snippet } from 'svelte';
	import X from '@lucide/svelte/icons/x';

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
</script>

<div
	class="animate-fadein fixed inset-0 z-40"
	style="background: color-mix(in srgb, black 45%, transparent);"
	role="presentation"
	onclick={onClose}
></div>
<div
	class="animate-popin fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface-overlay shadow-overlay"
	style="width: {width}px;"
	role="dialog"
	aria-modal="true"
	aria-label={title}
>
	<header class="flex items-center justify-between border-b border-border-faint px-4 py-3">
		<h2 class="type-subtitle">{title}</h2>
		<button
			type="button"
			aria-label="Close"
			class="focus-ring -mr-1 rounded-md p-1 text-text-tertiary hover:bg-surface-raised hover:text-text-secondary"
			onclick={onClose}
		>
			<X class="h-3.5 w-3.5" />
		</button>
	</header>
	<div class="flex-1 overflow-y-auto px-4 py-4">
		{@render children()}
	</div>
	{#if footer}
		<footer class="flex justify-end gap-2 border-t border-border-faint px-4 py-3">
			{@render footer()}
		</footer>
	{/if}
</div>
