<script lang="ts">
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { mutations } from '#lib/stores/mutations.svelte.ts';
	import type { DeploymentInfo } from '#lib/tauri.ts';

	// Scale a deployment: minus, the target, plus, and one segment per target
	// replica (filled = ready, outlined = not yet). In the list row while the
	// list has its full width, and always in the detail panel (Tonal §3 #11).
	let { deployment }: { deployment: DeploymentInfo } = $props();

	/** Replica segments shown next to the stepper (more render as "+N"). */
	const MAX_SEGMENTS = 8;

	const pendingScale = $derived(mutations.pendingScale(deployment.namespace, deployment.name));
	const applying = $derived(mutations.isApplyingScale(deployment.namespace, deployment.name));
	const target = $derived(pendingScale ?? deployment.replicas);

	function scale(event: MouseEvent, delta: number) {
		// Inside a list row: the click is the stepper's, not the row's.
		event.stopPropagation();
		mutations.nudgeScale(deployment.namespace, deployment.name, deployment.replicas, delta);
	}

	const STEP =
		'focus-ring-inset hover-layer flex h-(--control-inline-h) w-(--control-inline-h) items-center justify-center text-text-muted disabled:opacity-45';
</script>

<span class="flex min-w-0 items-center gap-2">
	<span class="flex shrink-0 items-center overflow-hidden rounded-full border border-outline-strong">
		<button
			type="button"
			aria-label="Scale down"
			disabled={applying || target <= 0}
			class={STEP}
			onclick={(e) => scale(e, -1)}
		>
			<Minus class="h-3 w-3" aria-hidden="true" />
		</button>
		<!-- A replica count not applied yet is bold with a triangle, not coloured. -->
		<span
			class="type-data-sm flex min-w-7 items-center justify-center gap-1 px-1 {pendingScale !== null
				? 'font-semibold text-text'
				: 'text-text-muted'}"
			data-pending={pendingScale !== null}
		>
			{#if pendingScale !== null}<StatusGlyph state="warn" size={8} class="text-warning" />{/if}
			{target}
		</span>
		<button type="button" aria-label="Scale up" disabled={applying} class={STEP} onclick={(e) => scale(e, 1)}>
			<Plus class="h-3 w-3" aria-hidden="true" />
		</button>
	</span>
	<span
		class="flex shrink-0 items-center gap-0.5"
		aria-label="{deployment.ready_replicas} of {target} replicas ready"
		role="img"
	>
		{#each Array.from({ length: Math.min(target, MAX_SEGMENTS) }, (_, i) => i) as i (i)}
			<span
				class="h-2.5 w-1.5 rounded-[1px] border {i < deployment.ready_replicas
					? 'border-success bg-success'
					: pendingScale !== null
						? 'border-warning'
						: 'border-outline-strong'}"
			></span>
		{/each}
		{#if target > MAX_SEGMENTS}
			<span class="type-micro font-mono text-text-subtle">+{target - MAX_SEGMENTS}</span>
		{/if}
	</span>
</span>
