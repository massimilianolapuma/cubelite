<script lang="ts" generics="T">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import StatusGlyph from './StatusGlyph.svelte';
	import { groupLabel, type NamespaceGroup } from '#lib/list-group.ts';
	import { toneGlyph, type StatusTone } from '#lib/status.ts';
	import { LIST_PINNED } from '#lib/ui-classes.ts';

	// Header of one namespace group (#547, Tonal §8.1): a label row lower than
	// the rows, with the chevron, the name, the row count and, on lists with a
	// status, the worst state as a shape beside the number of problem rows.
	let {
		group,
		expanded,
		nouns,
		onToggle
	}: {
		group: NamespaceGroup<T>;
		expanded: boolean;
		nouns: readonly [string, string];
		/** `all`: Option/Alt-click, every group takes the new state. */
		onToggle: (all: boolean) => void;
	} = $props();

	const tone: Record<StatusTone, string> = {
		ok: 'text-success',
		warn: 'text-warning',
		err: 'text-error',
		neutral: 'text-text-subtle'
	};
</script>

<button
	type="button"
	class="focus-ring-inset {LIST_PINNED} flex h-(--control-inline-h) shrink-0 items-center gap-2 rounded-md px-3 text-left hover:bg-surface-container-high"
	aria-label={groupLabel(group, nouns, expanded)}
	data-group={group.namespace}
	data-expanded={expanded}
	onclick={(e) => onToggle(e.altKey)}
>
	{#if expanded}
		<ChevronDown size={12} class="shrink-0 text-text-subtle" aria-hidden="true" />
	{:else}
		<ChevronRight size={12} class="shrink-0 text-text-subtle" aria-hidden="true" />
	{/if}
	<span class="type-label truncate text-text">{group.namespace}</span>
	<span class="type-data-sm shrink-0 text-text-muted">{group.count}</span>
	{#if group.worst !== null && group.problems > 0}
		<span class="type-data-sm flex shrink-0 items-center gap-1.5 font-semibold text-text" data-marker={group.worst}>
			<StatusGlyph state={toneGlyph(group.worst)} class={tone[group.worst]} />
			{group.problems}
		</span>
	{/if}
</button>
