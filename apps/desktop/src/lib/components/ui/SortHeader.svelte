<script lang="ts">
	import type { SortField } from '#lib/list-sort.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';

	// Clickable column header (#496): sorts the list for this session.
	let { list, field, label }: { list: string; field: SortField; label: string } = $props();

	const spec = $derived(lists.specFor(list));
	const active = $derived(spec.field === field);
	const sortState = $derived(active ? (spec.dir === 'asc' ? 'ascending' : 'descending') : 'none');
</script>

<button
	type="button"
	class="focus-ring type-colhead flex items-center gap-1 rounded-sm text-left hover:text-text-secondary {active
		? 'text-text-secondary'
		: ''}"
	aria-label="Sort by {label}"
	data-sort={sortState}
	title={active ? `Sorted ${sortState}` : `Sort by ${label}`}
	onclick={() => lists.clickHeader(list, field)}
>
	{label}
	{#if active}<span aria-hidden="true">{spec.dir === 'asc' ? '▲' : '▼'}</span><span class="sr-only"
			>, sorted {sortState}</span
		>{/if}
</button>
