<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
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
	<!-- A pill above the content card; a failure takes the error container and its square. -->
	<div
		class="card flex min-h-(--chip-h) shrink-0 items-center gap-3 rounded-full px-4 {banner.failure
			? 'bg-error-container text-on-error-container'
			: 'bg-surface-container-high text-text-muted'}"
		role="status"
		data-testid="integrations-banner"
		data-tone={banner.failure ? 'err' : undefined}
	>
		{#if banner.failure}
			<StatusGlyph state="err" />
		{/if}
		<span class="type-body-sm min-w-0 flex-1 truncate">
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
			class="focus-ring rounded-full p-1 opacity-80 hover:opacity-100"
			disabled={busy}
			onclick={() => integrations.dismiss(banner.context)}
		>
			<X size={12} strokeWidth={2} />
		</button>
	</div>
{/if}
