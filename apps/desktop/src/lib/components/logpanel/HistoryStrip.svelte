<script lang="ts">
	import type { LogHistory } from '#lib/stores/logHistory.svelte.ts';
	import { HISTORY_CAP } from '#lib/stores/logHistory.svelte.ts';
	import { HISTORY_RANGES, hitsLabel } from '#lib/elastic.ts';
	import Button from '#lib/components/ui/Button.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';

	// Top strip of the log body in History mode (#501): status, hit count,
	// Load older and errors.
	let { history }: { history: LogHistory } = $props();

	const rangeLabel = $derived(HISTORY_RANGES.find((r) => r.value === history.range)?.label ?? '');
	const hits = $derived(hitsLabel(history.total, history.totalIsLowerBound));
</script>

<div class="flex shrink-0 items-center gap-2 px-3 pt-1.5 pb-1" data-testid="history-strip">
	{#if history.next !== null && history.lines.length < HISTORY_CAP}
		<Button
			variant="tonal"
			size="inline"
			disabled={!history.canLoadOlder}
			onclick={() => void history.loadOlder()}
		>
			Load older
		</Button>
	{/if}
	<span class="type-body-sm min-w-0 flex-1 truncate text-text-muted" aria-live="polite">
		{#if history.loading}
			Loading history…
		{:else if history.error === null && history.started}
			{[hits, `showing ${history.lines.length.toLocaleString('en-US')}`, `last ${rangeLabel}`]
				.filter(Boolean)
				.join(' · ')}
		{/if}
	</span>
	{#if history.error}
		<span class="type-body-sm flex min-w-0 items-center gap-1.5 text-text" role="alert" title={history.error}>
			<StatusGlyph state="err" class="text-error" /><span class="truncate">{history.error}</span>
		</span>
		<Button variant="text" size="inline" onclick={() => void history.reload()}>Retry</Button>
	{/if}
</div>
