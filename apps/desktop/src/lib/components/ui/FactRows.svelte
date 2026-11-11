<script lang="ts">
	// The facts of an object in a detail panel (Tonal §8.3): one row per fact,
	// label on the left, value on the right. A missing value is an en dash.
	let { facts }: { facts: readonly (readonly [label: string, value: string | null])[] } = $props();
</script>

<!-- A long label takes at most a little over half the row: the value keeps its room. -->
<dl class="grid grid-cols-[fit-content(55%)_minmax(0,1fr)] gap-x-4 gap-y-2">
	<!-- Keyed by position: a kind's columns may repeat a label. -->
	{#each facts as [label, value], i (i)}
		<dt class="type-label break-words text-text-muted">{label}</dt>
		<dd
			class="type-data-sm text-right break-words {value === null ? 'text-text-subtle' : 'text-text'}"
			data-missing={value === null}
		>
			{value ?? '–'}
		</dd>
	{/each}
</dl>
