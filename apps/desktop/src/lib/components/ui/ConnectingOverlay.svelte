<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { app } from '$lib/stores/app.svelte';
	import { clusters } from '$lib/stores/clusters.svelte';
</script>

{#if app.connecting !== null}
	<div
		class="animate-fadein fixed inset-0 z-50 flex items-center justify-center"
		style="background: color-mix(in srgb, black 45%, transparent);"
		role="status"
	>
		<div
			class="animate-popin flex items-center gap-3 rounded-2xl border border-border-strong bg-surface-overlay px-5 py-4 shadow-overlay"
		>
			<LoaderCircle class="h-4 w-4 animate-spin text-accent" />
			<span class="type-body text-text-primary">Connecting to {app.connecting}…</span>
			<button
				type="button"
				class="focus-ring type-body rounded-md border border-border-default bg-surface-raised px-2.5 py-1 text-text-secondary hover:brightness-110"
				onclick={() => clusters.cancelSwitch()}
			>
				Cancel
			</button>
		</div>
	</div>
{/if}
