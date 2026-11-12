<script lang="ts">
	import StatusGlyph, { type GlyphState } from './StatusGlyph.svelte';
	import { tintStyle } from '#lib/appearance.ts';
	import { initials } from '#lib/cluster-identity.ts';
	import type { IdentityColor } from '#lib/cluster-identity.ts';

	export type Health = 'connected' | 'unreachable' | 'unknown';

	let {
		name,
		color,
		active = false,
		health,
		size,
		surface = 'high'
	}: {
		name: string;
		color: IdentityColor;
		active?: boolean;
		/** Omit to hide the health badge entirely. */
		health?: Health;
		/** Side in px; the control height of the current density when omitted. */
		size?: number;
		/**
		 * What the resting disc is filled with: `high` on the window (the rail),
		 * `container` on a card that is itself `surface-container-high`, where the
		 * disc would otherwise vanish.
		 */
		surface?: 'high' | 'container';
	} = $props();

	const side = $derived(size ? `${size}px` : 'var(--control-h)');
	// Health is a shape and a colour: circle, square, dashed ring.
	const healthGlyph: Record<Health, { state: GlyphState; tone: string }> = {
		connected: { state: 'ok', tone: 'text-success' },
		unreachable: { state: 'err', tone: 'text-error' },
		unknown: { state: 'unknown', tone: 'text-text-subtle' }
	};
</script>

<span class="relative inline-flex shrink-0" style="width: {side}; height: {side};">
	<!-- The disc carries its own cluster's tint; the active one is a filled square,
	     its corner in proportion to the size so it never rounds back into a disc. -->
	<span
		data-tint
		data-avatar
		data-testid="identity-avatar"
		data-active={active}
		class="type-body flex h-full w-full items-center justify-center transition-[border-radius] duration-200 motion-reduce:transition-none {active
			? 'bg-primary font-bold text-on-primary'
			: surface === 'container'
				? 'bg-primary-container font-semibold text-on-primary-container'
				: 'bg-surface-container-high font-semibold text-text-muted'}"
		data-surface={surface}
		style="{tintStyle(color)}; border-radius: {active ? `calc(${side} * 0.32)` : '9999px'};"
	>
		{initials(name)}
	</span>
	{#if health}
		<span
			data-testid="health-dot"
			data-health={health}
			class="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full bg-surface-window {healthGlyph[
				health
			].tone}"
		>
			<StatusGlyph state={healthGlyph[health].state} />
		</span>
	{/if}
</span>
