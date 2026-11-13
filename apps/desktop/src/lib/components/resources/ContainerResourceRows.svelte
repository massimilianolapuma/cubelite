<script lang="ts">
	import MeterBar from '#lib/components/ui/MeterBar.svelte';
	import type { ResourceRow } from '#lib/container-usage.ts';

	// A container's CPU and memory (#652): a meter against the limit when there is
	// one, else one line in the meter's label column with what is known.
	let { rows }: { rows: readonly ResourceRow[] } = $props();
	// The rows model joins the parts of a sentence with it.
	const SEPARATOR = ' · ';
</script>

<!-- One sentence for both kinds of row: its label column is MeterBar's (w-9, gap-2.5),
     so the text starts where the meter's track does; it wraps only at its separators. -->
{#snippet sentence(row: ResourceRow, label: string | null)}
	<div class="flex items-baseline gap-2.5" data-resource-detail>
		<span class="type-label w-9 shrink-0" aria-hidden={label === null ? 'true' : undefined}>{label ?? ''}</span>
		<span class="type-data-sm min-w-0 text-text-muted">
			{#each row.detail.split(SEPARATOR) as part, i (i)}{#if i > 0}{SEPARATOR}{/if}<span class="whitespace-nowrap">{part}</span>{/each}
		</span>
	</div>
{/snippet}

<div class="flex flex-col gap-2">
	{#each rows as row (row.resource)}
		<div class="flex flex-col gap-1" data-resource-row={row.resource}>
			{#if row.meter}
				<MeterBar label={row.label} percent={row.percent} />
				{@render sentence(row, null)}
			{:else}
				{@render sentence(row, row.label)}
			{/if}
		</div>
	{/each}
</div>
