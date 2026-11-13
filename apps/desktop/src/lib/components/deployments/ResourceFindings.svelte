<script lang="ts">
	import StatusGlyph, { type GlyphState } from '#lib/components/ui/StatusGlyph.svelte';
	import { findingLook } from '#lib/resource-editor.ts';
	import type { Finding } from '#lib/tauri.ts';

	// The check's findings (spec #650 §4), in its order, worst first: each a shape
	// and a sentence, the blocking and warning ones in a weight as well. While a
	// newer check runs, the last findings stay, quieter, so nothing moves.
	let {
		findings,
		label = 'Findings',
		stale = false
	}: { findings: readonly Finding[]; label?: string; stale?: boolean } = $props();

	const tone: Record<GlyphState, string> = {
		err: 'text-error',
		warn: 'text-warning',
		unknown: 'text-text-muted',
		ok: 'text-success',
		done: 'text-text-muted'
	};
</script>

<ul
	role="list"
	aria-label={label}
	aria-live="polite"
	aria-busy={stale ? 'true' : undefined}
	class="flex flex-col gap-1.5 {stale ? 'text-text-muted' : 'text-text'}"
	data-stale={stale}
>
	{#each findings as finding, i (i)}
		{@const look = findingLook(finding)}
		<li class="type-body-sm flex items-start gap-2" data-level={finding.level}>
			<StatusGlyph state={look.glyph} class="mt-1 {tone[look.glyph]}" />
			<span class="min-w-0 break-words {look.strong ? 'font-semibold' : ''}"
				>{#if look.lead}<span class="sr-only">{look.lead}</span>{' '}{/if}{finding.message}</span
			>
		</li>
	{/each}
</ul>
