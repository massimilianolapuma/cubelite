<script lang="ts">
	import { toasts } from '$lib/stores/toasts.svelte';
	import { toneColor } from '$lib/status';
</script>

{#if toasts.items.length > 0}
	<div class="fixed right-4 bottom-9 z-50 flex flex-col gap-2" role="status" aria-live="polite">
		{#each toasts.items as toast (toast.id)}
			<div
				class="animate-toast-in flex items-center gap-2.5 rounded-xl border border-border-strong bg-surface-overlay py-2.5 pr-3 pl-3 shadow-toast"
			>
				<span
					class="h-2 w-2 shrink-0 rounded-full"
					style="background: {toneColor[toast.tone]};"
				></span>
				<span class="type-body text-text-primary">{toast.message}</span>
				<button
					type="button"
					aria-label="Dismiss"
					class="focus-ring ml-1 rounded-sm text-[10px] text-text-tertiary hover:text-text-secondary"
					onclick={() => toasts.dismiss(toast.id)}
				>
					✕
				</button>
			</div>
		{/each}
	</div>
{/if}
