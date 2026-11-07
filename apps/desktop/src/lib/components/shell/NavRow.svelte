<script lang="ts">
	import { app, type View } from '#lib/stores/app.svelte.ts';
	import { dynamic } from '#lib/stores/dynamic.svelte.ts';
	import { countFor } from '#lib/stores/nav-counts.svelte.ts';
	import { isKindView } from '#lib/resource-kinds.ts';

	// One sidebar row (#574, resource-kinds §3): section dot, label, neutral
	// total and a separate attention badge; greyed when the cluster does not
	// serve the kind. `compact` is the denser row inside an open section.
	let {
		view,
		label,
		dot,
		compact = false,
		hint
	}: {
		view: View;
		label: string;
		dot: string;
		compact?: boolean;
		/** Tooltip, e.g. a custom kind's API group. */
		hint?: string;
	} = $props();

	const badgeStyle = {
		err: 'color: var(--color-status-err); background: var(--alpha-pill-err);',
		warn: 'color: var(--color-status-warn); background: var(--alpha-pill-warn);'
	} as const;

	const active = $derived(app.view === view);
	const count = $derived(countFor(view));
	const attention = $derived(count?.attention ?? null);
	const unavailable = $derived(isKindView(view) && dynamic.isUnavailable(view));
	// Mockup C: 26 px rows, 24 px inside an open section.
	const pad = $derived(compact ? 'h-6' : 'h-[26px]');
</script>

<div
	class="flex items-center rounded-md hover:bg-surface-row-hover"
	style={active ? 'background: var(--alpha-active-nav-bg);' : ''}
>
	<button
		type="button"
		class="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md {pad} pl-2.5 text-left {attention
			? 'pr-1.5'
			: 'pr-2.5'}"
		aria-current={active ? 'page' : undefined}
		title={unavailable ? 'Not available on this cluster' : hint}
		onclick={() => app.navigate(view)}
	>
		<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {dot};"></span>
		<span
			class="type-body flex-1 truncate {unavailable
				? 'text-text-disabled'
				: active
					? 'text-text-primary'
					: 'text-text-secondary'}"
		>
			{label}
		</span>
		{#if count}
			<span class="type-micro font-mono text-text-tertiary" data-testid="nav-count">{count.value}</span>
		{/if}
	</button>
	{#if attention}
		<button
			type="button"
			class="focus-ring type-micro mr-1.5 shrink-0 rounded-full px-1.5 font-mono"
			style={badgeStyle[attention.tone]}
			title="{attention.label} — show them"
			aria-label="{attention.label}: show them"
			data-testid="nav-attention"
			onclick={attention.open}
		>
			{attention.value}
		</button>
	{/if}
</div>
