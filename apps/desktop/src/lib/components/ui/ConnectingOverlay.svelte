<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Button from './Button.svelte';
	import { app } from '#lib/stores/app.svelte.ts';
	import { clusters } from '#lib/stores/clusters.svelte.ts';
</script>

{#if app.connecting !== null}
	<div
		class="animate-fadein fixed inset-0 z-50 flex items-center justify-center"
		style="background: color-mix(in srgb, black 50%, transparent);"
		role="status"
	>
		<div
			class="animate-popin flex items-center gap-3 rounded-xl bg-surface-overlay py-3 pr-3 pl-6 shadow-overlay"
		>
			<LoaderCircle class="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
			<span class="type-body text-text">Connecting to {app.connecting}…</span>
			<Button variant="text" onclick={() => clusters.cancelSwitch()}>Cancel</Button>
		</div>
	</div>
{/if}
