<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import StatusGlyph from './StatusGlyph.svelte';
	import { toasts } from '#lib/stores/toasts.svelte.ts';

	// The outcome is a shape as well as a colour: circle, triangle, square.
	const tone = { ok: 'text-success', warn: 'text-warning', err: 'text-error' } as const;
</script>

{#if toasts.items.length > 0}
	<div class="fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2" role="status" aria-live="polite">
		{#each toasts.items as toast (toast.id)}
			<div
				class="animate-toast-in flex max-w-[min(480px,90vw)] items-center gap-2.5 rounded-lg bg-surface-overlay py-2.5 pr-2.5 pl-4 shadow-overlay"
				data-tone={toast.tone}
			>
				<StatusGlyph state={toast.tone} class={tone[toast.tone]} />
				<span class="type-body-sm text-text">{toast.message}</span>
				<button
					type="button"
					aria-label="Dismiss"
					class="focus-ring ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-subtle hover:bg-surface-container-high hover:text-text-muted"
					onclick={() => toasts.dismiss(toast.id)}
				>
					<X size={14} strokeWidth={2} aria-hidden="true" />
				</button>
			</div>
		{/each}
	</div>
{/if}
