<script lang="ts">
	import { BUTTON_CLASS, UI_LINK_CLASS } from '#lib/integration.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { settings } from '#lib/stores/settings.svelte.ts';

	// Placeholder of a Prometheus feature while the context has no endpoint
	// (#526): what it would show, Set up Prometheus, and Hide (every hint).
	let { title, text, testid }: { title: string; text: string; testid: string } = $props();
</script>

<div class="flex items-center gap-2 rounded-lg border border-border-faint px-2.5 py-2" data-testid={testid}>
	<div class="min-w-0 flex-1">
		<div class="type-section text-text-tertiary">{title}</div>
		<p class="type-caption mt-0.5 text-text-tertiary">{text}</p>
	</div>
	<button type="button" class={BUTTON_CLASS} onclick={() => app.openPreferences('prometheus')}>
		Set up Prometheus
	</button>
	<button
		type="button"
		class={UI_LINK_CLASS}
		title="Hide integration hints (Preferences → Integrations brings them back)"
		onclick={() => (settings.integrationHints.value = false)}
	>
		Hide
	</button>
</div>
