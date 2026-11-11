<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import NamespaceGroupHeader from '#lib/components/ui/NamespaceGroupHeader.svelte';
	import {
		groupByNamespace,
		isCollapsed,
		shownCollapse,
		toggleCollapse,
		type CollapseState,
		type GroupAccessors
	} from '#lib/list-group.ts';
	import { sortRows } from '#lib/list-sort.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';

	// The rows of a resource list (#496, #547): flat in the current sort, or one
	// collapsible group per namespace while grouping applies. `row` renders one
	// row; its `grouped` argument tells it to drop the Namespace cell and indent
	// the name under the group's.
	let {
		list,
		rows,
		accessors,
		nouns,
		filter = '',
		groupable = true,
		row
	}: {
		/** Sort id of the list (see `lists.specFor`). */
		list: string;
		/** Rows after the list's filter. */
		rows: readonly T[];
		accessors: GroupAccessors<T>;
		/** Row noun for the header's accessible name, e.g. ['pod', 'pods']. */
		nouns: readonly [string, string];
		/** The list's filter text; while it is not empty every group shows expanded. */
		filter?: string;
		/** false for cluster-scoped kinds: always flat. */
		groupable?: boolean;
		row: Snippet<[T, boolean]>;
	} = $props();

	const spec = $derived(lists.specFor(list));
	const groups = $derived(groupable && app.groupedLists ? groupByNamespace(rows, spec, accessors) : null);
	const flat = $derived(groups === null ? sortRows(rows, spec, accessors) : []);

	// Header clicks while filtering only change `transient` (a writable
	// derived), which starts over whenever the filter text changes: retyping an
	// earlier filter must not bring its collapses back.
	let transient = $derived<{ filter: string; state: CollapseState }>({ filter, state: {} });
	const collapse = $derived(shownCollapse(filter, lists.collapsed, transient));

	function toggle(namespace: string, all: boolean) {
		const scope = all && groups ? groups.map((g) => g.namespace) : null;
		const next = toggleCollapse(collapse, namespace, scope);
		if (filter) transient = { filter, state: next };
		else lists.collapsed = next;
	}

	const keyOf = (r: T) => `${accessors.namespace(r)}/${accessors.name(r)}`;
</script>

{#if groups}
	{#each groups as group (group.namespace)}
		{@const expanded = !isCollapsed(collapse, group.namespace)}
		<NamespaceGroupHeader {group} {expanded} {nouns} onToggle={(all) => toggle(group.namespace, all)} />
		{#if expanded}
			{#each group.rows as r (keyOf(r))}
				{@render row(r, true)}
			{/each}
		{/if}
	{/each}
{:else}
	{#each flat as r (keyOf(r))}
		{@render row(r, false)}
	{/each}
{/if}
