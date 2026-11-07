<script lang="ts">
	import type { Snippet } from 'svelte';
	import Rows3 from '@lucide/svelte/icons/rows-3';
	import { app } from '#lib/stores/app.svelte.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';

	// Title bar of a resource list: the title, the "Group by namespace" toggle
	// (#547; only with all namespaces shown) and the list's own controls.
	// `groupable = false` (cluster-scoped kinds) never offers the toggle.
	let {
		title,
		groupable = true,
		children
	}: { title: string; groupable?: boolean; children?: Snippet } = $props();

	const pressed = $derived(lists.groupByNamespace);
</script>

<div class="flex min-h-7 items-center gap-3">
	<h1 class="type-title flex-1">{title}</h1>
	{#if groupable && app.namespace === null}
		<button
			type="button"
			class="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-md border {pressed
				? 'border-accent text-accent'
				: 'border-border-default bg-surface-window text-text-tertiary hover:text-text-secondary'}"
			style={pressed ? 'background: var(--alpha-selection-bg);' : undefined}
			aria-label="Group by namespace"
			aria-pressed={pressed}
			title="Group by namespace"
			onclick={() => (lists.groupByNamespace = !pressed)}
		>
			<Rows3 size={14} strokeWidth={1.5} aria-hidden="true" />
		</button>
	{/if}
	{@render children?.()}
</div>
