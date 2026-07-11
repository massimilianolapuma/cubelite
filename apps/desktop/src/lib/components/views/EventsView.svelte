<script lang="ts">
	import { formatAge } from '$lib/age';
	import { resources } from '$lib/stores/resources.svelte';

	const grid = 'grid-template-columns: 0.7fr 1fr 1.4fr 2.6fr 0.5fr;';
</script>

<div class="flex flex-col gap-3 p-4">
	<h1 class="type-title">Events</h1>

	<div class="overflow-hidden rounded-lg border border-border-default">
		<div class="grid gap-x-3 border-b border-border-default bg-surface-surface px-3 py-2" style={grid}>
			<span class="type-colhead">Type</span>
			<span class="type-colhead">Reason</span>
			<span class="type-colhead">Object</span>
			<span class="type-colhead">Message</span>
			<span class="type-colhead">Age</span>
		</div>
		<div class="bg-surface-panel">
			{#if resources.events.length === 0}
				<p class="py-8 text-center text-xs text-text-disabled">No events found.</p>
			{:else}
				{#each resources.events as event, i (i)}
					{@const warning = event.event_type === 'Warning'}
					<div
						class="grid items-center gap-x-3 border-b border-border-faint px-3 last:border-b-0 hover:bg-surface-row-hover"
						style="{grid} padding-top: var(--row-pad-default); padding-bottom: var(--row-pad-default); {warning
							? 'background: var(--alpha-log-warn-row);'
							: ''}"
					>
						<span>
							<span
								class="inline-flex rounded-full px-2 py-0.5 text-[10.5px] font-medium"
								style={warning
									? 'background: var(--alpha-pill-warn); color: var(--color-status-warn);'
									: 'background: var(--color-surface-raised); color: var(--color-text-secondary);'}
							>
								{event.event_type ?? '—'}
							</span>
						</span>
						<span class="type-data-sm truncate text-text-secondary">
							{event.reason ?? '—'}{event.count > 1 ? ` ×${event.count}` : ''}
						</span>
						<span class="type-data-sm truncate text-text-secondary">{event.object}</span>
						<span class="type-caption truncate text-text-secondary">{event.message ?? '—'}</span>
						<span class="type-data-sm text-text-secondary">{formatAge(event.last_timestamp)}</span>
					</div>
				{/each}
			{/if}
		</div>
	</div>
</div>
