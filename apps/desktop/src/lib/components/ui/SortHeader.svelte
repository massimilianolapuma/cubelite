<script lang="ts">
	import type { SortField } from '#lib/list-sort.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';

	// Clickable column header (#496): sorts the list for this session.
	let {
		list,
		field,
		label,
		align = 'start'
	}: { list: string; field: SortField; label: string; /** `end` for a column of numbers. */ align?: 'start' | 'end' } = $props();

	const spec = $derived(lists.specFor(list));
	const active = $derived(spec.field === field);
	const sortState = $derived(active ? (spec.dir === 'asc' ? 'ascending' : 'descending') : 'none');
</script>

<button
	type="button"
	class="focus-ring-inset type-label flex min-w-0 items-center gap-1 rounded-xs text-left hover:text-text {active
		? 'text-text'
		: 'text-text-muted'} {align === 'end' ? 'justify-end' : ''}"
	aria-label="Sort by {label}"
	data-sort={sortState}
	title={active ? `Sorted ${sortState}` : `Sort by ${label}`}
	onclick={() => lists.clickHeader(list, field)}
>
	<span class="truncate">{label}</span>
	{#if active}<span aria-hidden="true">{spec.dir === 'asc' ? '▲' : '▼'}</span><span class="sr-only"
			>, sorted {sortState}</span
		>{/if}
</button>
