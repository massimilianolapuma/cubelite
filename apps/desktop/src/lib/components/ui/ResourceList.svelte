<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import GroupedRows from './GroupedRows.svelte';
	import ListCard from './ListCard.svelte';
	import SortHeader from './SortHeader.svelte';
	import { shownColumns, type GroupAccessors } from '#lib/list-group.ts';
	import { listState } from '#lib/list-state.ts';
	import { applyChips, chipViews, type ChipDef } from '#lib/status-chips.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';
	import { LIST_ROW, LIST_ROW_ACTION, LIST_STICKY } from '#lib/ui-classes.ts';

	// A list of one resource kind (Tonal §8.1): the shared card, the status
	// chips, the load state, namespace groups and the Name and Namespace cells,
	// which every kind has. A kind adds its own header cells (`head`) and row
	// cells (`cells`) after them.
	let {
		list,
		title,
		nouns,
		rows,
		total,
		filter = '',
		tracks,
		accessors,
		namespaced = true,
		namespaceColumn = true,
		chipDefs,
		chipOf,
		loaded = true,
		error = null,
		busy = false,
		onRetry,
		onClearFilter,
		selected,
		onSelect,
		onEnterSelected,
		minWidth,
		tools,
		notice,
		head: kindHead,
		cells,
		below
	}: {
		/** List id: sort and status chips. */
		list: string;
		title: string;
		nouns: readonly [singular: string, plural: string];
		/** Rows after the list's text filter. */
		rows: readonly T[];
		/** Rows before it; `rows.length` when the list has no text filter. */
		total?: number;
		/** The text filter behind `rows`. */
		filter?: string;
		/** Grid tracks of every column; for a namespaced kind the second is Namespace. */
		tracks: readonly string[];
		accessors: GroupAccessors<T>;
		/** false for cluster-scoped kinds: no Namespace column, no groups. */
		namespaced?: boolean;
		/**
		 * false drops the Namespace column of a namespaced kind (its track, the
		 * second, goes with it): a list narrowed by the docked panel has no room
		 * for a column that repeats the selected namespace.
		 */
		namespaceColumn?: boolean;
		/** Status chips of the list, worst first, and the chip a row counts under. */
		chipDefs?: readonly ChipDef[];
		chipOf?: (row: T) => string;
		/** A load for the current cluster and namespace has finished. */
		loaded?: boolean;
		/** Message of the last failed load. */
		error?: string | null;
		/** A reload is in flight. */
		busy?: boolean;
		onRetry?: () => void;
		/** Empties the text filter (Clear filter also releases the chips). */
		onClearFilter?: () => void;
		/** With `onSelect`, rows open something: click, Enter or Space selects. */
		selected?: (row: T) => boolean;
		onSelect?: (row: T) => void;
		/** Enter on the row that is already selected. */
		onEnterSelected?: (row: T) => void;
		minWidth?: number;
		tools?: Snippet;
		notice?: Snippet;
		/** Header cells after Name and Namespace. */
		head: Snippet;
		/** Cells of one row after Name and Namespace. */
		cells: Snippet<[T]>;
		/** A block under a row (a secret's keys). */
		below?: Snippet<[T]>;
	} = $props();

	const grouped = $derived(namespaced && app.groupedLists);
	const withNamespace = $derived(namespaced && !grouped && namespaceColumn);
	const columns = $derived(namespaced ? shownColumns(tracks, !withNamespace) : tracks);

	const pressed = $derived(chipOf ? lists.pressed(list) : []);
	const chips = $derived(chipDefs && chipOf ? chipViews(chipDefs, rows, chipOf, pressed) : []);
	const visible = $derived(chipOf ? applyChips(rows, chipOf, pressed) : rows);
	const before = $derived(total ?? rows.length);

	// Not named `state`: that would shadow the `$state` rune.
	const shows = $derived(
		listState({
			nouns,
			namespace: app.namespace,
			namespaced,
			loaded,
			error,
			total: before,
			shown: visible.length,
			filter,
			chips: pressed.length > 0
		})
	);

	function clear() {
		lists.setStatus(list, []);
		onClearFilter?.();
	}

	// Keys on a control inside the row (scale, restart, reveal) are not the row's.
	function rowKey(e: KeyboardEvent, row: T, active: boolean) {
		if (e.target !== e.currentTarget) return;
		if (e.key === 'Enter') {
			e.preventDefault();
			if (active && onEnterSelected) onEnterSelected(row);
			else onSelect?.(row);
		} else if (e.key === ' ') {
			e.preventDefault();
			onSelect?.(row);
		}
	}
</script>

{#snippet nameCells(item: T, inGroup: boolean)}
	{@const name = accessors.name(item)}
	<!-- As tall as the row: a badge passing under it while the columns scroll must not show above or below the name. -->
	<span class="{LIST_STICKY} flex min-w-0 items-center self-stretch {inGroup ? 'pl-4.5' : ''}">
		<span class="type-data truncate text-text" title={name}>{name}</span>
	</span>
	{#if withNamespace}
		<span class="type-data-sm truncate text-text-muted">{accessors.namespace(item)}</span>
	{/if}
{/snippet}

<ListCard
	{title}
	{list}
	{nouns}
	{columns}
	state={shows}
	shown={visible.length}
	total={before}
	groupable={namespaced}
	{chips}
	{minWidth}
	{busy}
	{onRetry}
	onClear={clear}
	{tools}
	{notice}
>
	{#snippet head()}
		<span class="{LIST_STICKY} flex min-w-0"><SortHeader {list} field="name" label="Name" /></span>
		{#if withNamespace}<SortHeader {list} field="namespace" label="Namespace" />{/if}
		{@render kindHead()}
	{/snippet}

	<GroupedRows {list} rows={visible} {accessors} {nouns} {filter} groupable={namespaced}>
		{#snippet row(item, inGroup)}
			{@const active = selected?.(item) ?? false}
			{#if onSelect}
				<!-- Resource names are never links; the row is the interactive target (HIG §4.8.1). -->
				<div
					role="button"
					tabindex="0"
					class={LIST_ROW_ACTION}
					data-selected={active}
					aria-current={active ? 'true' : undefined}
					onclick={() => onSelect(item)}
					onkeydown={(e) => rowKey(e, item, active)}
				>
					{@render nameCells(item, inGroup)}
					{@render cells(item)}
				</div>
			{:else}
				<div class={LIST_ROW}>
					{@render nameCells(item, inGroup)}
					{@render cells(item)}
				</div>
			{/if}
			{@render below?.(item)}
		{/snippet}
	</GroupedRows>
</ListCard>
