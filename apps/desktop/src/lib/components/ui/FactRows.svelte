<script lang="ts">
	// The facts of an object in a detail panel (Tonal §8.3): one row per fact,
	// label on the left, value on the right. A missing value is an en dash.
	let { facts }: { facts: readonly (readonly [label: string, value: string | null])[] } = $props();
</script>

<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
	{#each facts as [label, value] (label)}
		<dt class="type-label text-text-muted">{label}</dt>
		<dd
			class="type-data-sm text-right break-words {value === null ? 'text-text-subtle' : 'text-text'}"
			data-missing={value === null}
		>
			{value ?? '–'}
		</dd>
	{/each}
</dl>
