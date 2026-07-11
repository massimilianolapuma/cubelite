<script lang="ts">
	import type { Snippet } from 'svelte';
	import X from '@lucide/svelte/icons/x';

	let {
		title,
		onClose,
		children,
		footer
	}: {
		title: string;
		onClose: () => void;
		children: Snippet;
		footer?: Snippet;
	} = $props();
</script>

<!-- Overlays the content area (absolute within the view outlet) — never squeezes it. -->
<div
	class="animate-drawer-in absolute inset-y-0 right-0 z-30 flex w-[370px] flex-col border-l border-border-default bg-surface-panel shadow-drawer"
	role="dialog"
	aria-label={title}
>
	<header class="flex items-start justify-between gap-3 border-b border-border-faint px-4 py-3">
		<h2 class="type-data break-words text-text-data-bright" style="word-break: break-word;">
			{title}
		</h2>
		<button
			type="button"
			aria-label="Close"
			class="focus-ring -mr-1 rounded-md p-1 text-text-tertiary hover:bg-surface-raised hover:text-text-secondary"
			onclick={onClose}
		>
			<X class="h-3.5 w-3.5" />
		</button>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-3">
		{@render children()}
	</div>

	{#if footer}
		<footer class="flex gap-2 border-t border-border-faint px-4 py-3">
			{@render footer()}
		</footer>
	{/if}
</div>
