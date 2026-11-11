<script lang="ts" module>
	/** Healthy, attention, failure, finished, unknown (spec §6). */
	export type GlyphState = 'ok' | 'warn' | 'err' | 'done' | 'unknown';
</script>

<script lang="ts">
	// State as a shape: circle, triangle, square, ring, dashed ring. Drawn as SVG
	// in the current text colour, so it survives forced-colours mode, where
	// backgrounds are dropped. Decorative: the state's word sits next to it.
	let { state, size = 9, class: klass = '' }: { state: GlyphState; size?: number; class?: string } = $props();
</script>

<svg
	viewBox="0 0 10 10"
	width={size}
	height={size}
	fill="currentColor"
	aria-hidden="true"
	data-glyph={state}
	class="shrink-0 {klass}"
>
	{#if state === 'ok'}
		<circle cx="5" cy="5" r="5" />
	{:else if state === 'warn'}
		<path d="M5 0.5 10 9.5H0z" />
	{:else if state === 'err'}
		<rect x="0.5" y="0.5" width="9" height="9" rx="2" />
	{:else if state === 'done'}
		<circle cx="5" cy="5" r="3.75" fill="none" stroke="currentColor" stroke-width="2.5" />
	{:else}
		<circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 2" />
	{/if}
</svg>
