<script lang="ts">
	import StatusBadge from './StatusBadge.svelte';

	export type PillTone = 'ok' | 'warn' | 'err' | 'neutral';

	// The v2 pill API on the Tonal badge: a tone is a state with its shape.
	// `neutral` is not a state (an event of type Normal, a plain tag): a quiet
	// chip with no glyph.
	let { label, tone = 'neutral' }: { label: string; tone?: PillTone } = $props();
</script>

{#if tone === 'neutral'}
	<span
		class="type-body-sm inline-flex items-center rounded-full bg-surface-container-high px-2.5 py-0.5 text-text-muted"
	>
		<span>{label}</span>
	</span>
{:else}
	<StatusBadge state={tone} {label} />
{/if}
