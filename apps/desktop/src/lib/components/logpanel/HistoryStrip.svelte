<script lang="ts">
	import type { LogHistory } from '#lib/stores/logHistory.svelte.ts';
	import { HISTORY_CAP } from '#lib/stores/logHistory.svelte.ts';
	import { HISTORY_RANGES, hitsLabel } from '#lib/elastic.ts';

	// Top strip of the log body in History mode (#501): status, hit count,
	// Load older and errors.
	let { history }: { history: LogHistory } = $props();

	const rangeLabel = $derived(HISTORY_RANGES.find((r) => r.value === history.range)?.label ?? '');
	const hits = $derived(hitsLabel(history.total, history.totalIsLowerBound));
</script>

<div
	class="flex shrink-0 items-center gap-2 border-b border-border-faint px-2.5 py-1"
	data-testid="history-strip"
>
	{#if history.next !== null && history.lines.length < HISTORY_CAP}
		<button
			type="button"
			class="focus-ring type-caption rounded-md border border-border-default bg-surface-raised px-2 py-0.5 text-text-secondary hover:brightness-110 disabled:opacity-50"
			disabled={!history.canLoadOlder}
			onclick={() => void history.loadOlder()}
		>
			Load older
		</button>
	{/if}
	<span class="type-caption flex-1 truncate text-text-tertiary" aria-live="polite">
		{#if history.loading}
			Loading history…
		{:else if history.error === null && history.started}
			{[hits, `showing ${history.lines.length.toLocaleString('en-US')}`, `last ${rangeLabel}`]
				.filter(Boolean)
				.join(' · ')}
		{/if}
	</span>
	{#if history.error}
		<span class="type-caption truncate text-status-err" role="alert" title={history.error}>{history.error}</span>
		<button
			type="button"
			class="focus-ring type-caption shrink-0 rounded-sm text-accent hover:brightness-110"
			onclick={() => void history.reload()}
		>
			Retry
		</button>
	{/if}
</div>
