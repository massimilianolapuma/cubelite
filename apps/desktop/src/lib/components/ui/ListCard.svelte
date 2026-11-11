<script lang="ts">
	import type { Snippet } from 'svelte';
	import Rows3 from '@lucide/svelte/icons/rows-3';
	import Chip from './Chip.svelte';
	import ListStateBlock from './ListStateBlock.svelte';
	import PinToggle from './PinToggle.svelte';
	import type { ListState } from '#lib/list-state.ts';
	import type { ChipView } from '#lib/status-chips.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';
	import { iconToggle, LIST_HEAD } from '#lib/ui-classes.ts';

	// The one shell of every resource list (Tonal §8.1): title with its count,
	// pin and group toggles, the list's own tools, status chips, then either the
	// rows under a sticky column header or the list's state (§8.2). The header
	// stays put; only the rows scroll, sideways too when the columns need more
	// room than the card has (the name column then stays in view).
	let {
		title,
		list,
		nouns,
		columns,
		state,
		shown,
		total,
		groupable = true,
		chips = [],
		minWidth,
		busy = false,
		onRetry,
		onClear,
		tools,
		notice,
		head,
		children
	}: {
		title: string;
		/** List id: sort, status chips. */
		list: string;
		nouns: readonly [singular: string, plural: string];
		/** Grid tracks of the shown columns; the first is the name. */
		columns: readonly string[];
		state: ListState;
		/** Rows after the list's filters, and before them. */
		shown: number;
		total: number;
		/** false for cluster-scoped kinds: never offers Group by namespace. */
		groupable?: boolean;
		chips?: readonly ChipView[];
		/** Width in px below which the rows scroll sideways; by default from the column count. */
		minWidth?: number;
		/** A retry is in flight. */
		busy?: boolean;
		onRetry?: () => void;
		onClear?: () => void;
		/** The list's own controls in the title row (filter field, notes). */
		tools?: Snippet;
		/** One line under the header, e.g. "metrics unavailable". */
		notice?: Snippet;
		/** Column header cells. */
		head: Snippet;
		/** Rows. */
		children: Snippet;
	} = $props();

	const grouping = $derived(lists.groupByNamespace);
	const counted = $derived(state.kind === 'ready' || state.kind === 'filtered');
	const count = $derived(shown === total ? `${total}` : `${shown} of ${total}`);
	const width = $derived(minWidth ?? 220 + 92 * (columns.length - 1));
</script>

<!-- No min-h-0: when the window is too short for the header and a few rows, the
     content card scrolls the whole list rather than squeezing the rows away. -->
<section class="flex flex-1 flex-col gap-3 p-4" aria-label={title}>
	<!-- The title never gives way to the tools: when both do not fit, the tools wrap under it. -->
	<header class="flex min-h-(--chip-h) flex-wrap items-center gap-x-3 gap-y-2">
		<div class="flex max-w-full min-w-0 items-baseline gap-3">
			<h1 class="type-display truncate" {title}>{title}</h1>
			{#if counted}
				<!-- The phrase is real text: a label on a plain span is not announced. -->
				<span class="type-title shrink-0 text-text-subtle" data-testid="list-count" aria-hidden="true">{count}</span>
				<span class="sr-only" data-testid="list-count-label">{count} {total === 1 ? nouns[0] : nouns[1]}</span>
			{/if}
		</div>
		<div class="min-w-0 flex-1"></div>
		<PinToggle />
		{#if groupable && app.namespace === null}
			<button
				type="button"
				class={iconToggle(grouping)}
				aria-label="Group by namespace"
				aria-pressed={grouping}
				title="Group by namespace"
				onclick={() => (lists.groupByNamespace = !grouping)}
			>
				<Rows3 size={14} strokeWidth={1.5} aria-hidden="true" />
			</button>
		{/if}
		{@render tools?.()}
	</header>

	<!-- Chips count the rows on screen: over placeholders or an error they would
	     be the previous answer's. -->
	{#if chips.length > 0 && counted}
		<div class="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
			{#each chips as chip (chip.key)}
				<Chip
					label={chip.label}
					count={chip.count}
					state={chip.state}
					pressed={chip.pressed}
					onToggle={() => lists.toggleStatus(list, chip.key)}
				/>
			{/each}
		</div>
	{/if}

	{@render notice?.()}

	{#if state.kind === 'ready'}
		<!-- @container: what must stay in view while the columns scroll sideways (group
		     headers, a secret's keys) is sized to the scroller, 100cqw. At least three rows tall. -->
		<div
			class="@container min-h-[calc(var(--row-h)*3+2rem)] flex-1 overflow-auto"
			data-testid="list-scroller"
			style="--list-cols: {columns.join(' ')};"
		>
			<div class="flex flex-col gap-0.5" style="min-width: {width}px;">
				<div class={LIST_HEAD}>
					{@render head()}
				</div>
				{@render children()}
			</div>
		</div>
	{:else}
		<ListStateBlock {state} plural={nouns[1]} {busy} {onRetry} {onClear} />
	{/if}
</section>
