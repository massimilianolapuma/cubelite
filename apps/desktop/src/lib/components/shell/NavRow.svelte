<script lang="ts">
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { app, type View } from '#lib/stores/app.svelte.ts';
	import { dynamic } from '#lib/stores/dynamic.svelte.ts';
	import { countFor } from '#lib/stores/nav-counts.svelte.ts';
	import { isKindView } from '#lib/resource-kinds.ts';

	// One sidebar row (#574, resource-kinds §3, Tonal §7): a pill with the label,
	// a neutral total and a separate attention badge. A kind the cluster does not
	// serve stays in place, subdued, with an en dash where the count would be.
	let {
		view,
		label,
		hint
	}: {
		view: View;
		label: string;
		/** Tooltip, e.g. a custom kind's API group. */
		hint?: string;
	} = $props();

	// Attention is a shape and a colour: square for failure, triangle for warning.
	const badge = {
		err: { glyph: 'err', tone: 'bg-error-container text-on-error-container' },
		warn: { glyph: 'warn', tone: 'bg-warning-container text-on-warning-container' }
	} as const;

	const active = $derived(app.view === view);
	const count = $derived(countFor(view));
	const attention = $derived(count?.attention ?? null);
	const unavailable = $derived(isKindView(view) && dynamic.isUnavailable(view));
</script>

<div
	data-active={active}
	class="flex items-center rounded-full {active
		? 'bg-primary-container text-on-primary-container'
		: 'text-text-muted hover:bg-surface-container'}"
>
	<button
		type="button"
		class="focus-ring-inset flex h-(--nav-h) min-w-0 flex-1 items-center gap-2 rounded-full pl-3.5 text-left {attention
			? 'pr-1.5'
			: 'pr-3.5'}"
		aria-current={active ? 'page' : undefined}
		title={unavailable ? 'Not available on this cluster' : hint}
		data-unavailable={unavailable ? 'true' : undefined}
		onclick={() => app.navigate(view)}
	>
		<span class="type-body flex-1 truncate {active ? 'font-semibold' : unavailable ? 'text-text-subtle' : ''}">
			{label}
		</span>
		{#if unavailable}
			<span class="sr-only">, not available on this cluster</span>
			<span class="type-data-sm {active ? '' : 'text-text-subtle'}" aria-hidden="true">–</span>
		{:else if count}
			<span class="type-data-sm {active ? '' : 'text-text-subtle'}" data-testid="nav-count">{count.value}</span>
		{/if}
	</button>
	{#if attention}
		<button
			type="button"
			class="focus-ring type-data-sm mr-1.5 flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 {badge[
				attention.tone
			].tone}"
			title="{attention.label} — show them"
			aria-label="{attention.label}: show them"
			data-testid="nav-attention"
			data-tone={attention.tone}
			onclick={attention.open}
		>
			<StatusGlyph state={badge[attention.tone].glyph} size={7} />
			{attention.value}
		</button>
	{/if}
</div>
