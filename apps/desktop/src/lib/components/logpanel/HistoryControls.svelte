<script lang="ts">
	import { HISTORY_RANGES, isHistoryRange } from '#lib/elastic.ts';
	import type { LogHistory } from '#lib/stores/logHistory.svelte.ts';
	import { TOOLBAR_FIELD_FLEX, TOOLBAR_SELECT } from '#lib/ui-classes.ts';

	// History range and Elasticsearch query (#501), shared by the log panel
	// and the Logs view (#529).
	let { history }: { history: LogHistory } = $props();
</script>

<select
	aria-label="History range"
	class={TOOLBAR_SELECT}
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
	class={TOOLBAR_FIELD_FLEX}
/>
