<script lang="ts">
	import { tick } from 'svelte';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import NavRow from './NavRow.svelte';
	import { app } from '#lib/stores/app.svelte.ts';
	import { dynamic, type CustomKind } from '#lib/stores/dynamic.svelte.ts';
	import { sidebar } from '#lib/stores/sidebar.svelte.ts';

	// Custom Resources (resource-kinds §5.3, revised in #589): every custom
	// kind right away, in the same rows as the other sections, under small
	// vendor headers (elastic.co, coreos.com…). The filter narrows the same
	// rows; like any open section, only this list scrolls when space runs out.
	let { onkeydown }: { onkeydown: (event: KeyboardEvent) => void } = $props();

	const open = $derived(sidebar.openSection === 'custom');
	const needle = $derived(sidebar.customFilter.trim().toLowerCase());

	const matches = (k: CustomKind, vendor: string) =>
		[k.kind, k.plural, k.group, vendor].some((w) => w.toLowerCase().includes(needle));
	const shown = $derived(
		dynamic.customVendors
			.map((v) => ({ ...v, kinds: needle ? v.kinds.filter((k) => matches(k, v.vendor)) : v.kinds }))
			.filter((v) => v.kinds.length > 0)
	);

	/** "Certificate (acme.cert-manager.io)" when a vendor has the kind name twice. */
	function labelOf(k: CustomKind, siblings: CustomKind[]): string {
		return siblings.filter((s) => s.kind === k.kind).length > 1 ? `${k.kind} (${k.group})` : k.kind;
	}

	// The active custom kind may sit below the visible part of a long list.
	let area = $state<HTMLElement | null>(null);
	$effect(() => {
		void [app.view, sidebar.customFilter];
		if (!open || !area) return;
		const el = area;
		void tick().then(() => el.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest' }));
	});
</script>

<button
	type="button"
	data-section-toggle
	class="focus-ring flex h-(--nav-h) shrink-0 items-center gap-2 rounded-full pr-3.5 pl-2.5 text-left hover:bg-surface-container {open
		? 'text-text'
		: 'text-text-muted'}"
	aria-expanded={open}
	aria-controls="sidebar-section-custom"
	onclick={() => sidebar.toggle('custom')}
	{onkeydown}
>
	<ChevronRight
		class="h-3.5 w-3.5 shrink-0 text-text-subtle transition-transform {open ? 'rotate-90' : ''}"
		aria-hidden="true"
	/>
	<span class="type-body flex-1 truncate {open ? 'font-semibold' : ''}">Custom Resources</span>
	{#if dynamic.customKnown}
		<span class="type-data-sm text-text-subtle">{dynamic.customKindCount}</span>
	{/if}
</button>
{#if open}
	{#if dynamic.discoveryFailed}
		<p class="type-body-sm mb-0.5 pl-8.5 text-text-subtle">Couldn't discover custom resources</p>
	{:else if !dynamic.customKnown}
		<p class="type-body-sm mb-0.5 pl-8.5 text-text-subtle">Loading…</p>
	{:else if dynamic.customKindCount === 0}
		<p class="type-body-sm mb-0.5 pl-8.5 text-text-subtle">No custom resources on this cluster</p>
	{:else}
		<div class="shrink-0 py-0.5 pl-5">
			<input
				type="text"
				bind:value={sidebar.customFilter}
				aria-label="Filter custom resources"
				placeholder="Filter…"
				class="focus-ring type-body-sm h-(--control-inline-h) w-full rounded-full bg-surface-container-high px-3.5 text-text placeholder:text-text-subtle"
			/>
		</div>
		<ul
			id="sidebar-section-custom"
			bind:this={area}
			aria-label="Custom Resources types"
			class="mb-0.5 min-h-0 overflow-y-auto pl-5"
		>
			{#each shown as v (v.vendor)}
				<li class="type-label truncate px-3.5 pt-1.5 pb-0.5">{v.vendor}</li>
				{#each v.kinds as kind (kind.view)}
					<li>
						<NavRow view={kind.view} label={labelOf(kind, v.kinds)} hint={kind.group} />
					</li>
				{/each}
			{:else}
				<li class="type-body-sm px-3.5 py-1 text-text-subtle">No match</li>
			{/each}
		</ul>
	{/if}
{/if}
