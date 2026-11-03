<script lang="ts">
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import { ACCENT_LINK_CLASS } from '#lib/integration.ts';
	import { HISTORY_HINT, showsIntegrationHint } from '#lib/integration-links.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { elastic } from '#lib/stores/elastic.svelte.ts';
	import { settings } from '#lib/stores/settings.svelte.ts';

	// Live · History switch (#501), shared by the log panel and the Logs view
	// (#529). Without Elasticsearch, History stays visible but disabled, with
	// a way to set it up (#526); `blocked` disables it with a reason when the
	// current filter has no history query.
	let {
		value,
		onChange,
		blocked = null,
		setup = true,
		testid = 'logpanel-source',
		hintTestid = 'logpanel-history-hint'
	}: {
		value: 'live' | 'history';
		onChange: (source: 'live' | 'history') => void;
		blocked?: string | null;
		/** Offer the "Set up" link (not in detached windows). */
		setup?: boolean;
		testid?: string;
		hintTestid?: string;
	} = $props();

	const endpoint = $derived(elastic.endpointFor(app.activeCluster));
	const historyHint = $derived(showsIntegrationHint(endpoint, settings.integrationHints.value));
	const segments = $derived([
		{ value: 'live' as const, label: 'Live' },
		{ value: 'history' as const, label: 'History', disabled: blocked !== null, title: blocked ?? undefined }
	]);
	const HINT_SEGMENTS = [
		{ value: 'live' as const, label: 'Live' },
		{ value: 'history' as const, label: 'History', disabled: true, title: HISTORY_HINT }
	];
</script>

{#if endpoint}
	<span data-testid={testid} title={blocked ?? undefined}>
		<SegmentedControl {segments} {value} {onChange} label="Log source" />
	</span>
{:else if historyHint}
	<span class="flex items-center gap-1.5" title={HISTORY_HINT} data-testid={hintTestid}>
		<SegmentedControl segments={HINT_SEGMENTS} value="live" label="Log source" />
		{#if setup}
			<button type="button" class={ACCENT_LINK_CLASS} onclick={() => app.openPreferences('elasticsearch')}>
				Set up
			</button>
		{/if}
	</span>
{/if}
