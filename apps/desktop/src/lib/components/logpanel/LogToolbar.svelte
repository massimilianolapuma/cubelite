<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { logPanel } from '$lib/stores/logPanel.svelte';
	import type { LogSession } from '$lib/stores/logSession.svelte';

	let { session }: { session: LogSession } = $props();

	let pickerOpen = $state(false);
	let overflowOpen = $state(false);

	const TAIL_OPTIONS = [100, 500, 1000, 5000] as const;

	const selected = $derived(session.containers.find((c) => c.name === session.container) ?? null);
	const mains = $derived(session.containers.filter((c) => !c.init));
	const inits = $derived(session.containers.filter((c) => c.init));

	function pick(name: string) {
		pickerOpen = false;
		logPanel.rememberContainer(session.key, name);
		void session.switchContainer(name);
	}
</script>

<div class="flex h-9 shrink-0 items-center gap-2 border-b border-border-default bg-surface-raised px-2.5">
	<!-- container picker -->
	<div class="relative">
		<button
			type="button"
			class="focus-ring type-caption flex h-7 items-center gap-1.5 rounded-md border border-border-default bg-surface-window px-2.5 font-mono text-text-primary"
			onclick={() => (pickerOpen = !pickerOpen)}
		>
			{session.container ?? '…'}
			<ChevronDown size={12} strokeWidth={1.5} />
		</button>
		{#if pickerOpen}
			<div
				class="absolute bottom-full left-0 z-20 mb-1 min-w-56 rounded-md border border-border-default bg-surface-raised py-1 shadow-lg"
			>
				{#each mains as c (c.name)}
					<button
						type="button"
						class="flex w-full items-center gap-2 px-2.5 py-1 text-left hover:bg-surface-sunken"
						onclick={() => pick(c.name)}
					>
						<span class="type-caption flex-1 font-mono text-text-primary">{c.name}</span>
						<span class="type-caption text-text-tertiary"
							>{c.state}{c.restarts > 0 ? ` · ↺${c.restarts}` : ''}</span
						>
					</button>
				{/each}
				{#if inits.length > 0}
					<div class="my-1 border-t border-border-default"></div>
					{#each inits as c (c.name)}
						<button
							type="button"
							class="flex w-full items-center gap-2 px-2.5 py-1 text-left hover:bg-surface-sunken"
							onclick={() => pick(c.name)}
						>
							<span class="type-caption flex-1 font-mono text-text-secondary">{c.name}</span>
							<span class="type-caption text-text-tertiary">init</span>
						</button>
					{/each}
				{/if}
			</div>
		{/if}
	</div>

	<!-- previous-instance chip: only when the selected container has restarts -->
	{#if (selected?.restarts ?? 0) > 0}
		<button
			type="button"
			class="focus-ring type-caption flex h-7 items-center gap-1 rounded-md px-2 {session.previous
				? 'bg-surface-sunken text-text-primary'
				: 'text-text-tertiary'}"
			title="Previous instance"
			onclick={() => void session.setPrevious(!session.previous)}
		>
			<RotateCcw size={12} strokeWidth={1.5} /> prev
		</button>
	{/if}

	<span class="flex-1"></span>

	<!-- tail size -->
	<div class="flex overflow-hidden rounded-md border border-border-default">
		{#each TAIL_OPTIONS as n (n)}
			<button
				type="button"
				class="type-section h-7 border-r border-border-default px-2 last:border-r-0"
				style={session.tailLines === n
					? 'background: var(--color-text-secondary); color: var(--color-surface-window);'
					: 'color: var(--color-text-tertiary);'}
				onclick={() => void session.setTail(n)}
			>
				{n}
			</button>
		{/each}
	</div>
	<button
		type="button"
		class="focus-ring type-caption h-7 rounded-md px-2 text-text-tertiary hover:text-text-secondary"
		onclick={() => void session.loadEarlier()}
	>
		Load 500 earlier
	</button>

	<!-- follow/pause -->
	<button
		type="button"
		class="type-caption flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium"
		style={session.following
			? 'background: var(--color-status-ok); color: var(--color-surface-window);'
			: 'background: var(--alpha-pill-warn); color: var(--color-status-warn);'}
		onclick={() => session.toggleFollow()}
	>
		{session.following ? '● Following' : '⏸ Paused'}
	</button>

	<!-- overflow -->
	<div class="relative">
		<button
			type="button"
			class="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:text-text-secondary"
			aria-label="More log options"
			onclick={() => (overflowOpen = !overflowOpen)}
		>
			<Ellipsis size={14} strokeWidth={1.5} />
		</button>
		{#if overflowOpen}
			<div
				class="absolute right-0 bottom-full z-20 mb-1 min-w-44 rounded-md border border-border-default bg-surface-raised py-1 shadow-lg"
			>
				<button
					type="button"
					class="type-caption block w-full px-2.5 py-1 text-left text-text-primary hover:bg-surface-sunken"
					onclick={() => {
						logPanel.timestamps = !logPanel.timestamps;
						overflowOpen = false;
					}}
				>
					{logPanel.timestamps ? '✓ ' : ''}Timestamps
				</button>
				<button
					type="button"
					class="type-caption block w-full px-2.5 py-1 text-left text-text-primary hover:bg-surface-sunken"
					onclick={() => {
						logPanel.wrap = !logPanel.wrap;
						overflowOpen = false;
					}}
				>
					{logPanel.wrap ? '✓ ' : ''}Wrap lines
				</button>
				<div class="my-1 border-t border-border-default"></div>
				<button
					type="button"
					class="type-caption block w-full px-2.5 py-1 text-left text-text-primary hover:bg-surface-sunken"
					onclick={() => {
						session.clear();
						overflowOpen = false;
					}}
				>
					Clear buffer
				</button>
			</div>
		{/if}
	</div>
</div>
