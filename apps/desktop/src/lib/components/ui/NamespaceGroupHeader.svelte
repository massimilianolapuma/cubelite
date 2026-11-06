<script lang="ts" generics="T">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { groupLabel, type NamespaceGroup } from '#lib/list-group.ts';
	import { toneColor } from '#lib/status.ts';

	// Full-width header of one namespace group (#547): chevron, name, row
	// count and, on lists with a status, the worst tone and the problem count.
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
</script>

<button
	type="button"
	class="focus-ring flex w-full items-center gap-1.5 border-b border-border-faint bg-surface-surface px-3 text-left last:border-b-0 hover:bg-surface-row-hover"
	style="padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default);"
	aria-label={groupLabel(group, nouns, expanded)}
	data-group={group.namespace}
	data-expanded={expanded}
	onclick={(e) => onToggle(e.altKey)}
>
	{#if expanded}
		<ChevronDown size={12} class="shrink-0 text-text-tertiary" aria-hidden="true" />
	{:else}
		<ChevronRight size={12} class="shrink-0 text-text-tertiary" aria-hidden="true" />
	{/if}
	<span class="type-data flex-1 truncate text-text-data-bright">{group.namespace}</span>
	<span class="type-data-sm w-10 shrink-0 text-right text-text-secondary">{group.count}</span>
	{#if group.worst !== null}
		<span class="flex w-12 shrink-0 items-center justify-end gap-1.5">
			{#if group.problems > 0}
				<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {toneColor[group.worst]};"></span>
				<span class="type-data-sm" style="color: {toneColor[group.worst]};">{group.problems}</span>
			{/if}
		</span>
	{/if}
</button>
