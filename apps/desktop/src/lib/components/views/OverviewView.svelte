<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { formatAge } from '$lib/age';
	import MeterBar from '$lib/components/ui/MeterBar.svelte';
	import StatCard from '$lib/components/ui/StatCard.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { resources } from '$lib/stores/resources.svelte';

	const warnings = $derived(resources.warningEvents);
</script>

<div class="flex flex-col gap-4 p-4">
	<h1 class="type-title">Overview</h1>

	<div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
		<StatCard label="Nodes" value="—" />
		<StatCard label="Pods running" value={resources.runningPods} />
		<StatCard label="Deployments" value={resources.deployments.length} />
		<StatCard label="Warnings" value={warnings.length} tone={warnings.length > 0 ? 'warn' : 'ok'} />
	</div>

	<div class="grid gap-3 xl:grid-cols-2">
		<div class="flex flex-col gap-2.5 rounded-xl border border-border-default bg-surface-surface p-4">
			<div class="type-colhead">Capacity</div>
			<MeterBar label="CPU" percent={null} />
			<MeterBar label="MEM" percent={null} />
			<p class="type-caption text-text-disabled">
				metrics unavailable — requires metrics-server integration
			</p>
		</div>

		<div class="rounded-xl border border-border-default bg-surface-surface p-4">
			<div class="mb-2 flex items-center">
				<div class="type-colhead flex-1">Recent warnings</div>
				<button
					type="button"
					class="focus-ring type-caption flex items-center gap-1 rounded-sm text-text-tertiary hover:text-text-secondary"
					onclick={() => app.navigate('events')}
				>
					All events
					<ArrowRight class="h-3 w-3" />
				</button>
			</div>
			{#if warnings.length === 0}
				<p class="type-caption text-text-disabled">No warning events.</p>
			{:else}
				<div class="flex flex-col">
					{#each warnings.slice(0, 5) as event, i (i)}
						<button
							type="button"
							class="flex items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-row-hover"
							onclick={() => app.navigate('events')}
						>
							<span
								class="h-1.5 w-1.5 shrink-0 rounded-full"
								style="background: var(--color-status-warn);"
							></span>
							<span class="type-data-sm w-40 shrink-0 truncate text-text-secondary">{event.object}</span>
							<span class="type-caption flex-1 truncate text-text-tertiary">
								{event.message ?? event.reason ?? '—'}
							</span>
							<span class="type-caption text-text-tertiary">{formatAge(event.last_timestamp)}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>
