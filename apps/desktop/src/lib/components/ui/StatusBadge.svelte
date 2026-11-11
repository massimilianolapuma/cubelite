<script lang="ts">
	import StatusGlyph, { type GlyphState } from './StatusGlyph.svelte';

	// A resource's state as a shape and its word (Tonal §6). Healthy and
	// finished are a glyph beside plain text; only attention and failure are
	// filled, and failure is a rectangle (6 px corners) where attention is a pill, so
	// the two also differ in outline. The label is the exact word the API returned.
	let { state, label }: { state: GlyphState; label: string } = $props();

	const look: Record<GlyphState, { fill: 'none' | 'warning' | 'error'; shell: string; glyph: string }> = {
		ok: { fill: 'none', shell: 'text-text', glyph: 'text-success' },
		done: { fill: 'none', shell: 'text-text-subtle', glyph: '' },
		unknown: { fill: 'none', shell: 'text-text-subtle', glyph: '' },
		warn: {
			fill: 'warning',
			shell: 'rounded-full bg-warning-container px-2.5 py-0.5 text-on-warning-container',
			glyph: ''
		},
		err: {
			fill: 'error',
			shell: 'rounded-xs bg-error-container px-2.5 py-0.5 text-on-error-container',
			glyph: ''
		}
	};
	const style = $derived(look[state]);
</script>

<span
	data-state={state}
	data-fill={style.fill}
	class="type-body-sm inline-flex max-w-full items-center gap-1.5 font-semibold whitespace-nowrap {style.shell}"
>
	<StatusGlyph {state} class={style.glyph} />
	<span class="truncate">{label}</span>
</span>
