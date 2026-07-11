<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { app } from '$lib/stores/app.svelte';
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
		</div>
	</div>
{/if}
