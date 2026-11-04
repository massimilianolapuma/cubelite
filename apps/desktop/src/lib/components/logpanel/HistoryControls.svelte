<script lang="ts">
	import { HISTORY_RANGES, isHistoryRange } from '#lib/elastic.ts';
	import type { LogHistory } from '#lib/stores/logHistory.svelte.ts';

	// History range and Elasticsearch query (#501), shared by the log panel
	// and the Logs view (#529).
	let { history }: { history: LogHistory } = $props();
</script>

<select
	aria-label="History range"
	class="focus-ring type-caption h-7 rounded-md border border-border-default bg-surface-window px-2 text-text-primary"
	value={history.range}
	onchange={(e) => {
		const v = e.currentTarget.value;
		if (isHistoryRange(v)) {
			history.range = v;
			void history.reload();
		}
	}}
>
	{#each HISTORY_RANGES as r (r.value)}
		<option value={r.value}>Last {r.label}</option>
	{/each}
</select>
<input
	type="text"
	aria-label="Elasticsearch query"
	placeholder="Query Elasticsearch… ⏎"
	bind:value={history.text}
	onkeydown={(e) => {
		if (e.key === 'Enter') void history.reload();
	}}
	class="focus-ring h-7 w-44 rounded-md border border-border-default bg-surface-window px-2.5 type-caption text-text-primary placeholder:text-text-disabled"
/>
