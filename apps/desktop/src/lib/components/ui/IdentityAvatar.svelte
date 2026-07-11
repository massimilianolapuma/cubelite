<script lang="ts">
	import { initials } from '$lib/cluster-identity';
	import type { IdentityColor } from '$lib/cluster-identity';

	export type Health = 'connected' | 'unreachable' | 'unknown';

	let {
		name,
		color,
		active = false,
		health,
		size = 38
	}: {
		name: string;
		color: IdentityColor;
		active?: boolean;
		/** Omit to hide the health badge entirely. */
		health?: Health;
		size?: number;
	} = $props();

	const identityVar = $derived(`var(--color-cluster-${color})`);
	const healthColor: Record<Health, string> = {
		connected: 'var(--color-status-ok)',
		unreachable: 'var(--color-status-err)',
		unknown: 'var(--color-text-tertiary)'
	};
</script>

<span class="relative inline-flex" style="width: {size}px; height: {size}px;">
	<span
		class="flex h-full w-full items-center justify-center rounded-xl text-xs font-semibold"
		style="
			background: {active ? `color-mix(in srgb, ${identityVar} 20%, transparent)` : 'var(--color-surface-raised)'};
			color: {active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)'};
			{active ? `box-shadow: 0 0 0 2px ${identityVar};` : ''}
		"
	>
		{initials(name)}
	</span>
	{#if health}
		<span
			data-testid="health-dot"
			data-health={health}
			class="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface-window"
			style="background: {healthColor[health]};"
		></span>
	{/if}
</span>
