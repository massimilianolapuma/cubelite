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

	// Sidebar variant C (resource-kinds §3): profile switch, Go to resource,
	// the active profile's pins, then every section with one open at a time.
	// Order and visibility of sections and types come from Preferences (#496).
	const sections = $derived(navigation.sections);

	/** Every type's label and section dot, hidden ones included. */
	const meta = $derived(
		new Map(navigation.arranged.flatMap((s) => s.items.map((i) => [i.view, { label: i.label, dot: s.dot }] as const)))
	);
	const pins = $derived(
		profiles.active.pins
			.filter((v) => !navigation.isHidden(v))
			.map((view) => ({ view, ...(meta.get(view) ?? { label: view, dot: 'var(--color-text-tertiary)' }) }))
	);

	// A view reached from elsewhere (palette, badges, links) that is not
	// pinned: open its section so the active row is visible.
	$effect(() => {
		const view: View = app.view;
		if (pins.some((p) => p.view === view)) return;
		const home = sections.find((s) => s.items.some((i) => i.view === view));
		if (home) untrack(() => sidebar.open(home.id));
	});

	const label = 'type-section px-2.5 text-text-tertiary';
	const menuItem =
		'flex cursor-default items-center gap-3 rounded-md px-2.5 py-1.5 type-body text-text-secondary data-highlighted:text-text-primary';
</script>

<aside class="flex w-[216px] shrink-0 flex-col gap-3 overflow-y-auto bg-surface-panel px-2 py-3">
	<div class="flex flex-col gap-1.5">
		<ProfileMenu />
		<button
			type="button"
			class="focus-ring flex h-7 items-center gap-2 rounded-md px-2.5 text-left text-text-tertiary hover:bg-surface-row-hover hover:text-text-secondary"
			onclick={() => (app.paletteOpen = true)}
		>
			<Search class="h-3 w-3 shrink-0" aria-hidden="true" />
			<span class="type-body flex-1">Go to resource</span>
			<Kbd label="{modLabel}K" />
		</button>
	</div>

	<div>
		<div class="{label} mb-1" id="sidebar-pinned-label">Pinned · {profiles.active.name}</div>
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

	<div class="border-t border-border-faint pt-3">
		<div class="{label} mb-1">All resources</div>
		<AllResources {sections} />
	</div>
</aside>
