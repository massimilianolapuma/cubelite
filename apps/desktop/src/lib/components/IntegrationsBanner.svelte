<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import { ACCENT_LINK_CLASS, UI_LINK_CLASS } from '#lib/integration.ts';
	import { REVIEW_ONLY_HINT, bannerTitle } from '#lib/integration-suggest.ts';
	import { integrations } from '#lib/stores/integrations.svelte.ts';

	// Integrations found when the context connected (#527): one slim line
	// above the content naming the services, "— Enable · Review · ✕". Enable
	// only when each one is the single operator-managed service; else Review.
	const banner = $derived(integrations.banner);
	const busy = $derived(banner !== null && integrations.enabling === banner.context);
</script>

{#if banner}
	<div
		class="flex items-center gap-3 border-b border-border-default px-3 py-1"
		style="background: {banner.failure ? 'var(--alpha-pill-err)' : 'var(--alpha-selection-bg)'};"
		role="status"
		data-testid="integrations-banner"
	>
		<span class="type-caption min-w-0 flex-1 truncate {banner.failure ? 'text-status-err' : 'text-text-secondary'}">
			{banner.failure ?? bannerTitle(banner.found, banner.kinds)}
		</span>
		{#if !banner.failure && banner.canEnable}
			<button
				type="button"
				class={ACCENT_LINK_CLASS}
				disabled={busy}
				onclick={() => void integrations.enable(banner.context)}
			>
				{busy ? 'Enabling…' : 'Enable'}
			</button>
		{/if}
		<button
			type="button"
			class={banner.canEnable || banner.failure ? UI_LINK_CLASS : ACCENT_LINK_CLASS}
			title={banner.canEnable || banner.failure ? undefined : REVIEW_ONLY_HINT}
			disabled={busy}
			onclick={() => integrations.review(banner.context)}
		>
			Review
		</button>
		<button
			type="button"
			aria-label="Dismiss"
			title="Hide for this cluster (Preferences → Integrations brings it back)"
			class="focus-ring rounded-sm text-text-tertiary hover:text-text-secondary"
			disabled={busy}
			onclick={() => integrations.dismiss(banner.context)}
		>
			<X size={12} strokeWidth={2} />
		</button>
	</div>
{/if}
