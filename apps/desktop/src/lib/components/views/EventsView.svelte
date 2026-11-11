<script lang="ts">
	import ListCard from '#lib/components/ui/ListCard.svelte';
	import StatusBadge from '#lib/components/ui/StatusBadge.svelte';
	import { formatAge } from '#lib/age.ts';
	import { listState } from '#lib/list-state.ts';
	import { STATUS_CHIPS } from '#lib/status.ts';
	import { applyChips, chipViews } from '#lib/status-chips.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { lists } from '#lib/stores/lists.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import type { EventInfo } from '#lib/tauri.ts';
	import { LIST_ROW } from '#lib/ui-classes.ts';

	const NOUNS = ['event', 'events'] as const;
	const chipOf = (e: EventInfo) => (e.event_type === 'Warning' ? 'warning' : 'normal');

	const pressed = $derived(lists.pressed('events'));
	const chips = $derived(chipViews(STATUS_CHIPS.events, resources.events, chipOf, pressed));
	const shown = $derived(applyChips(resources.events, chipOf, pressed));
	// Not named `state`: that would shadow the `$state` rune.
	const shows = $derived(
		listState({
			nouns: NOUNS,
			namespace: app.namespace,
			loaded: resources.mainLoaded,
			error: resources.listError('events'),
			total: resources.events.length,
			shown: shown.length,
			chips: pressed.length > 0
		})
	);
</script>

<!-- Events keep the server's order: newest activity is what the list is for. -->
<ListCard
	title="Events"
	list="events"
	nouns={NOUNS}
	columns={['6.5rem', '1fr', '1.4fr', '2.6fr', '0.5fr']}
	state={shows}
	shown={shown.length}
	total={resources.events.length}
	groupable={false}
	{chips}
	busy={resources.loading}
	onRetry={() => void resources.load()}
	onClear={() => lists.setStatus('events', [])}
>
	{#snippet head()}
		<span class="truncate">Type</span>
		<span class="truncate">Reason</span>
		<span class="truncate">Object</span>
		<span class="truncate">Message</span>
		<span class="truncate">Age</span>
	{/snippet}

	{#each shown as event, i (i)}
		<!-- A warning is told by its pill; the row itself is not tinted (Tonal §8.1). -->
		<div class={LIST_ROW} data-event-type={event.event_type ?? ''}>
			<span class="flex min-w-0 items-center">
				{#if event.event_type === 'Warning'}
					<StatusBadge state="warn" label="Warning" />
				{:else}
					<span class="type-body-sm truncate text-text-muted">{event.event_type ?? '–'}</span>
				{/if}
			</span>
			<span class="type-data-sm truncate text-text-muted">
				{event.reason ?? '–'}{event.count > 1 ? ` ×${event.count}` : ''}
			</span>
			<span class="type-data-sm truncate text-text-muted" title={event.object}>{event.object}</span>
			<span class="type-body-sm truncate text-text-muted" title={event.message ?? undefined}>{event.message ?? '–'}</span>
			<span class="type-data-sm text-text-muted">{formatAge(event.last_timestamp)}</span>
		</div>
	{/each}
</ListCard>
