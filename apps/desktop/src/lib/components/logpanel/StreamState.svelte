<script lang="ts" module>
	import type { GlyphState } from '#lib/components/ui/StatusGlyph.svelte';
	import type { SessionStatus } from '#lib/stores/logSession.svelte.ts';

	// A log stream's state as a shape and a word (Tonal §6, §9.3), in place of
	// the coloured dot of the tab strip and the pop-out header.
	const LOOK: Record<SessionStatus, { state: GlyphState; word: string; tone: string }> = {
		streaming: { state: 'ok', word: 'Streaming', tone: 'text-success' },
		connecting: { state: 'unknown', word: 'Connecting', tone: 'text-text-muted' },
		reconnecting: { state: 'warn', word: 'Reconnecting', tone: 'text-warning' },
		ended: { state: 'done', word: 'Ended', tone: 'text-text-muted' },
		error: { state: 'err', word: 'Error', tone: 'text-error' }
	};
</script>

<script lang="ts">
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';

	/** `word` shows the word beside the shape; otherwise it is read out only. */
	let { status, word = false }: { status: SessionStatus; word?: boolean } = $props();

	const look = $derived(LOOK[status]);
</script>

<span class="inline-flex shrink-0 items-center gap-1.5" title={look.word} data-status={status}>
	<StatusGlyph state={look.state} class={look.tone} />
	<span class={word ? 'type-body-sm text-text-muted' : 'sr-only'}>{look.word}</span>
</span>
