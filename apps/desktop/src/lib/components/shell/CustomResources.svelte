<script lang="ts" module>
	/** Section dot of Custom Resources and of custom kinds (mockup grey). */
	export const CUSTOM_DOT = 'var(--color-text-tertiary)';
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { app } from '#lib/stores/app.svelte.ts';
	import NavRow from './NavRow.svelte';
	import { dynamic } from '#lib/stores/dynamic.svelte.ts';
	import { sidebar } from '#lib/stores/sidebar.svelte.ts';

	// Custom Resources (resource-kinds §5.3): one row per API group of the
	// cluster's custom kinds, in an area at most 8 rows tall that scrolls on
	// its own, so 60 CRD groups never make the sidebar scroll.
	let { onkeydown }: { onkeydown: (event: KeyboardEvent) => void } = $props();

	const ROW_PX = 26;
	const MAX_ROWS = 8;

	const open = $derived(sidebar.openSection === 'custom');

	// The active custom kind may sit below the 8-row area (60 groups): bring it into view.
	let area = $state<HTMLElement | null>(null);
	$effect(() => {
		void [app.view, sidebar.openGroup, sidebar.customFilter];
		if (!open || !area) return;
		const el = area;
		void tick().then(() => el.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest' }));
	});
	const groups = $derived(dynamic.customGroups);
	const needle = $derived(sidebar.customFilter.trim().toLowerCase());
	/** While filtering: matching groups, each with its matching kinds (all of them when the group matches). */
	const shown = $derived(
		needle
			? groups
					.map((g) =>
						g.group.toLowerCase().includes(needle)
							? g
							: { ...g, kinds: g.kinds.filter((k) => k.kind.toLowerCase().includes(needle)) }
					)
					.filter((g) => g.kinds.length > 0)
			: groups
	);
</script>

<button
	type="button"
	data-section-toggle
	class="focus-ring flex h-[26px] shrink-0 items-center gap-2 rounded-md pr-2 pl-2.5 text-left hover:bg-surface-row-hover"
	aria-expanded={open}
	aria-controls="sidebar-section-custom"
	onclick={() => sidebar.toggle('custom')}
	{onkeydown}
>
	<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {CUSTOM_DOT};"></span>
	<span class="type-body flex-1 truncate {open ? 'text-text-primary' : 'text-text-secondary'}">Custom Resources</span>
	{#if dynamic.customKnown}
		<span class="type-micro font-mono text-text-tertiary">{groups.length}</span>
	{/if}
	<ChevronRight
		class="h-3 w-3 shrink-0 text-text-tertiary transition-transform {open ? 'rotate-90' : ''}"
		aria-hidden="true"
	/>
</button>
{#if open}
	<div id="sidebar-section-custom" class="mb-0.5 flex min-h-0 flex-col gap-1 pl-2">
		{#if dynamic.discoveryFailed}
			<p class="type-caption px-2.5 text-text-tertiary">Couldn't discover custom resources</p>
		{:else if !dynamic.customKnown}
			<p class="type-caption px-2.5 text-text-tertiary">Loading…</p>
		{:else if groups.length === 0}
			<p class="type-caption px-2.5 text-text-tertiary">No custom resources on this cluster</p>
		{:else}
			<input
				type="text"
				bind:value={sidebar.customFilter}
				aria-label="Filter custom resources"
				placeholder="Filter groups and kinds…"
				class="focus-ring type-caption h-6 shrink-0 rounded-md border border-border-default bg-surface-window px-2 text-text-primary placeholder:text-text-disabled"
			/>
			<ul
				bind:this={area}
				aria-label="Custom resource groups"
				class="min-h-0 overflow-y-auto"
				style="max-height: {ROW_PX * MAX_ROWS}px;"
				data-testid="custom-groups"
			>
				{#each shown as g (g.group)}
					{@const expanded = needle !== '' || sidebar.openGroup === g.group}
					<li>
						<button
							type="button"
							class="focus-ring flex h-6 w-full items-center gap-2 rounded-md pr-2 pl-2.5 text-left hover:bg-surface-row-hover"
							aria-expanded={expanded}
							onclick={() => sidebar.toggleGroup(g.group)}
						>
							<span class="type-caption flex-1 truncate font-mono {expanded ? 'text-text-primary' : 'text-text-secondary'}"
								>{g.group}</span
							>
							<span class="type-micro font-mono text-text-tertiary">{g.kinds.length}</span>
							<ChevronRight
								class="h-3 w-3 shrink-0 text-text-tertiary transition-transform {expanded ? 'rotate-90' : ''}"
								aria-hidden="true"
							/>
						</button>
						{#if expanded}
							<ul aria-label="{g.group} kinds" class="pl-2">
								{#each g.kinds as kind (kind.view)}
									<li><NavRow view={kind.view} label={kind.kind} dot={CUSTOM_DOT} compact /></li>
								{/each}
							</ul>
						{/if}
					</li>
				{:else}
					<li class="type-caption px-2.5 text-text-tertiary">No match</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
