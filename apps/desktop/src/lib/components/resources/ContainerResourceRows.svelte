<script lang="ts">
	import MeterBar from '#lib/components/ui/MeterBar.svelte';
	import type { ResourceRow } from '#lib/container-usage.ts';

	// A container's CPU and memory (#652): a meter against the limit when there is
	// one, else one line in the meter's label column with what is known.
	let { rows }: { rows: readonly ResourceRow[] } = $props();
</script>

<div class="flex flex-col gap-2">
	{#each rows as row (row.resource)}
		{#if row.meter}
			<div data-resource-row={row.resource}>
				<MeterBar label={row.label} percent={row.percent} detail={row.detail} />
			</div>
		{:else}
			<!-- Same label column as MeterBar (w-9, gap-2.5), so the text starts where a meter's detail does. -->
			<div class="flex items-baseline gap-2.5" data-resource-row={row.resource}>
				<span class="type-label w-9 shrink-0">{row.label}</span>
				<!-- A long sentence wraps at its separators, never inside "no limit". -->
				<span class="type-data-sm min-w-0 text-text-muted">
					{#each row.detail.split(' · ') as part, i (i)}{#if i > 0}{' · '}{/if}<span class="whitespace-nowrap">{part}</span>{/each}
				</span>
			</div>
		{/if}
	{/each}
</div>
