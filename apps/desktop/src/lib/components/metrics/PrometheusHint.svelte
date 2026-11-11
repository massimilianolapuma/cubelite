<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';
	import { app } from '#lib/stores/app.svelte.ts';
	import { settings } from '#lib/stores/settings.svelte.ts';

	// Placeholder of a Prometheus feature while the context has no endpoint
	// (#526): what it would show, Set up Prometheus, and Hide (every hint).
	// A tile with a dashed border (Tonal §9.2): something that is not there yet.
	let { title, text, testid }: { title: string; text: string; testid: string } = $props();
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed border-outline-strong px-3 py-2.5" data-testid={testid}>
	<div class="min-w-40 flex-1">
		<div class="type-label text-text-muted">{title}</div>
		<p class="type-body-sm mt-0.5 text-text-muted">{text}</p>
	</div>
	<Button variant="tonal" size="inline" onclick={() => app.openPreferences('prometheus')}>Set up Prometheus</Button>
	<Button
		variant="text"
		size="inline"
		title="Hide integration hints (Preferences → Integrations brings them back)"
		onclick={() => (settings.integrationHints.value = false)}
	>
		Hide
	</Button>
</div>
