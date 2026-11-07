<script lang="ts">
	import { app, type View } from '#lib/stores/app.svelte.ts';
	import { isExtraKind, resources } from '#lib/stores/resources.svelte.ts';
	import { navigation } from '#lib/stores/navigation.svelte.ts';

	// Order and visibility come from Preferences (#496).
	const sections = $derived(navigation.sections);

	const issueCount = $derived(resources.issuePods.length);
	const warningCount = $derived(resources.warningEvents.length);

	interface Attention {
		value: number;
		/** Tooltip and accessible name, e.g. "3 pods need attention". */
		label: string;
		tone: 'err' | 'warn';
		/** Opens the list filtered to these items. */
		open: () => void;
	}

	interface Count {
		value: number;
		/**
		 * Items needing attention: a separate badge next to the neutral total
		 * (#574), so 24 failing pods out of 187 do not turn all 187 red.
		 */
		attention: Attention | null;
	}

	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

	/** One right-aligned count per row; null when the kind is not loaded. */
	function countFor(view: View): Count | null {
		switch (view) {
			case 'pods':
				return {
					value: resources.pods.length,
					attention:
						issueCount > 0
							? {
									value: issueCount,
									label: `${plural(issueCount, 'pod needs', 'pods need')} attention`,
									tone: 'err',
									open: () => {
										app.navigate('pods');
										app.podIssuesOnly = true;
									}
								}
							: null
				};
			case 'deployments':
				return { value: resources.deployments.length, attention: null };
			case 'events':
				return {
					value: resources.events.length,
					attention:
						warningCount > 0
							? {
									value: warningCount,
									label: plural(warningCount, 'warning', 'warnings'),
									tone: 'warn',
									open: () => {
										app.navigate('events');
										app.eventWarningsOnly = true;
									}
								}
							: null
				};
			default: {
				if (!isExtraKind(view)) return null;
				const value = resources.kindCount(view);
				return value === null ? null : { value, attention: null };
			}
		}
	}

	const badgeStyle = {
		err: 'color: var(--color-status-err); background: var(--alpha-pill-err);',
		warn: 'color: var(--color-status-warn); background: var(--alpha-pill-warn);'
	} as const;
</script>

<aside class="flex w-[198px] shrink-0 flex-col gap-4 overflow-y-auto bg-surface-panel px-2 py-3">
	{#each sections as section (section.id)}
		<div>
			<div class="type-section mb-1 px-2.5 text-text-tertiary">{section.label}</div>
			{#each section.items as item (item.view)}
				{@const active = app.view === item.view}
				{@const count = countFor(item.view)}
				{@const attention = count?.attention ?? null}
				<div
					class="flex items-center rounded-md hover:bg-surface-row-hover"
					style={active ? 'background: var(--alpha-active-nav-bg);' : ''}
				>
					<button
						type="button"
						class="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2.5 text-left {attention
							? 'pr-1.5'
							: 'pr-2.5'}"
						onclick={() => app.navigate(item.view)}
					>
						<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {section.dot};"></span>
						<span class="type-body flex-1 truncate {active ? 'text-text-primary' : 'text-text-secondary'}">
							{item.label}
						</span>
						{#if count}
							<span class="type-micro font-mono text-text-tertiary" data-testid="nav-count">{count.value}</span>
						{/if}
					</button>
					{#if attention}
						<button
							type="button"
							class="focus-ring type-micro mr-1.5 shrink-0 rounded-full px-1.5 font-mono"
							style={badgeStyle[attention.tone]}
							title="{attention.label} — show them"
							aria-label="{attention.label}: show them"
							data-testid="nav-attention"
							onclick={attention.open}
						>
							{attention.value}
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{/each}
</aside>
