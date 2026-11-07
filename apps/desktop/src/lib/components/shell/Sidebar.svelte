<script lang="ts">
	import { untrack } from 'svelte';
	import { ContextMenu } from 'bits-ui';
	import Search from '@lucide/svelte/icons/search';
	import Kbd from '#lib/components/ui/Kbd.svelte';
	import AllResources from './AllResources.svelte';
	import NavRow from './NavRow.svelte';
	import ProfileMenu from './ProfileMenu.svelte';
	import { modLabel } from '#lib/platform.ts';
	import { app, type View } from '#lib/stores/app.svelte.ts';
	import { navigation } from '#lib/stores/navigation.svelte.ts';
	import { profiles } from '#lib/stores/profiles.svelte.ts';
	import { sidebar } from '#lib/stores/sidebar.svelte.ts';
	import { dynamic } from '#lib/stores/dynamic.svelte.ts';
	import { isCustomView, parseCustomView } from '#lib/resource-kinds.ts';
	import { CUSTOM_DOT } from './CustomResources.svelte';

	// Sidebar variant C (resource-kinds §3): profile switch, Go to resource,
	// the active profile's pins, then every section with one open at a time.
	// Order and visibility of sections and types come from Preferences (#496).
	const sections = $derived(navigation.sections);

	/** Every type's label and section dot, hidden ones included, plus the cluster's custom kinds. */
	const meta = $derived(
		new Map<View, { label: string; dot: string }>([
			...navigation.arranged.flatMap((s) => s.items.map((i) => [i.view, { label: i.label, dot: s.dot }] as const)),
			...dynamic.customGroups.flatMap((g) => g.kinds.map((k) => [k.view, { label: k.kind, dot: CUSTOM_DOT }] as const))
		])
	);
	/** A pin the cluster does not serve: custom kinds fall back to their plural. */
	const fallback = (view: View) => ({
		label: (isCustomView(view) && parseCustomView(view)?.plural) || view,
		dot: CUSTOM_DOT
	});
	const pins = $derived(
		profiles.active.pins
			.filter((v) => !navigation.isHidden(v))
			.map((view) => ({ view, ...(meta.get(view) ?? fallback(view)) }))
	);

	// A view reached from elsewhere (palette, badges, links) that is not
	// pinned: open its section so the active row is visible.
	$effect(() => {
		const view: View = app.view;
		if (pins.some((p) => p.view === view)) return;
		const custom = isCustomView(view) ? parseCustomView(view) : null;
		if (custom) {
			untrack(() => {
				sidebar.open('custom');
				sidebar.openGroup = custom.group;
				// A filter left from earlier could hide the kind just opened.
				sidebar.customFilter = '';
			});
			return;
		}
		const home = sections.find((s) => s.items.some((i) => i.view === view));
		if (home) untrack(() => sidebar.open(home.id));
	});

	const label = 'type-section px-2.5 text-text-tertiary';
	const menuItem =
		'flex cursor-default items-center gap-3 rounded-md px-2.5 py-1.5 type-body text-text-secondary data-highlighted:text-text-primary';
</script>

<aside class="flex min-h-0 w-[216px] shrink-0 flex-col gap-2 overflow-y-auto bg-surface-panel px-2 py-2.5">
	<div class="flex shrink-0 items-center gap-1">
		<div class="min-w-0 flex-1"><ProfileMenu /></div>
		<button
			type="button"
			class="focus-ring flex h-7 shrink-0 items-center gap-1 rounded-md border border-border-default bg-surface-window px-1.5 text-text-tertiary hover:text-text-secondary"
			aria-label="Go to resource"
			title="Go to resource ({modLabel}K)"
			onclick={() => (app.paletteOpen = true)}
		>
			<Search class="h-3 w-3" aria-hidden="true" />
			<Kbd label="{modLabel}K" />
		</button>
	</div>

	<div class="shrink-0">
		<div class="{label} mb-0.5" id="sidebar-pinned-label">Pinned · {profiles.active.name}</div>
		<ul aria-label="Pinned · {profiles.active.name}">
			{#each pins as pin (pin.view)}
				<li>
					<ContextMenu.Root>
						<ContextMenu.Trigger>
							<NavRow view={pin.view} label={pin.label} dot={pin.dot} />
						</ContextMenu.Trigger>
						<ContextMenu.Portal>
							<ContextMenu.Content
								class="animate-popin z-50 min-w-40 rounded-xl border border-border-strong bg-surface-overlay p-1 shadow-overlay"
							>
								<ContextMenu.Item class={menuItem} onSelect={() => profiles.unpin(pin.view)}>Unpin</ContextMenu.Item>
							</ContextMenu.Content>
						</ContextMenu.Portal>
					</ContextMenu.Root>
				</li>
			{/each}
		</ul>
		{#if pins.length === 0}
			<p class="type-caption px-2.5 text-text-tertiary">Pin any resource from its list header.</p>
		{/if}
	</div>

	<div class="flex min-h-0 flex-1 flex-col border-t border-border-faint pt-2">
		<div class="{label} mb-0.5 shrink-0">All resources</div>
		<AllResources {sections} />
	</div>
</aside>
