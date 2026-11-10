<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { ContextMenu } from 'bits-ui';
	import Search from '@lucide/svelte/icons/search';
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

	// Sidebar variant C (resource-kinds §3): profile switch, Go to resource,
	// the active profile's pins, then every section with one open at a time.
	// Order and visibility of sections and types come from Preferences (#496).
	const sections = $derived(navigation.sections);

	/** Every type's label, hidden ones included, plus the cluster's custom kinds. */
	const meta = $derived(
		new Map<View, { label: string; hint?: string }>([
			...navigation.arranged.flatMap((s) => s.items.map((i) => [i.view, { label: i.label }] as const)),
			...dynamic.customGroups.flatMap((g) => g.kinds.map((k) => [k.view, { label: k.kind, hint: g.group }] as const))
		])
	);
	/** A pin the cluster does not serve: custom kinds fall back to their plural. */
	const fallback = (view: View): { label: string; hint?: string } => ({
		label: (isCustomView(view) && parseCustomView(view)?.plural) || view
	});
	const pins = $derived(
		profiles.active.pins
			.filter((v) => !navigation.isHidden(v))
			.map((view) => ({ view, ...(meta.get(view) ?? fallback(view)) }))
	);

	// A view reached from elsewhere (palette, badges, links) that is not
	// pinned: open its section so the active row is visible. Only a new view,
	// or its row leaving Pinned, reopens a section: other pin changes, a
	// profile switch or a rediscovery leave a section you closed closed.
	const activePinned = $derived(pins.some((p) => p.view === app.view));
	$effect(() => {
		const view: View = app.view;
		if (activePinned) return;
		const custom = isCustomView(view) ? parseCustomView(view) : null;
		if (custom) {
			untrack(() => {
				sidebar.open('custom');
				// A filter left from earlier could hide the kind just opened.
				sidebar.customFilter = '';
			});
			return;
		}
		untrack(() => {
			const home = sections.find((s) => s.items.some((i) => i.view === view));
			if (home) sidebar.open(home.id);
		});
	});

	// Unpinning removes the focused row's menu trigger: focus the next pin
	// (the previous one at the end) instead of leaving it on <body>.
	let pinList = $state<HTMLElement | null>(null);
	function unpin(view: View) {
		const at = pins.findIndex((p) => p.view === view);
		profiles.unpin(view);
		void tick().then(() => {
			const rows = pinList?.querySelectorAll<HTMLElement>('li button') ?? [];
			rows[Math.min(at, rows.length - 1)]?.focus();
		});
	}

	const label = 'type-label px-3.5';
	const menuItem =
		'flex cursor-default items-center gap-3 rounded-md px-2.5 py-1.5 type-body text-text-secondary data-highlighted:text-text-primary';
</script>

<!-- Sits on the window ground, no card: tone separates it from the content (Tonal §5). -->
<aside class="flex min-h-0 w-[232px] shrink-0 flex-col gap-3 overflow-y-auto px-2 pt-1 pb-3">
	<div class="flex shrink-0 items-center gap-2">
		<div class="min-w-0 flex-1"><ProfileMenu /></div>
		<button
			type="button"
			class="focus-ring flex h-(--control-h) w-(--control-h) shrink-0 items-center justify-center rounded-full bg-surface-container-high text-text-muted hover:brightness-110"
			aria-label="Go to resource"
			title="Go to resource ({modLabel}K)"
			onclick={() => (app.paletteOpen = true)}
		>
			<Search class="h-4 w-4" aria-hidden="true" />
		</button>
	</div>

	<div class="shrink-0">
		<div class="{label} mb-1 truncate" id="sidebar-pinned-label" title={profiles.active.name}>
			Pinned · {profiles.active.name}
		</div>
		<ul aria-label="Pinned · {profiles.active.name}" bind:this={pinList}>
			{#each pins as pin (pin.view)}
				<li>
					<ContextMenu.Root>
						<ContextMenu.Trigger>
							<NavRow view={pin.view} label={pin.label} hint={pin.hint} />
						</ContextMenu.Trigger>
						<ContextMenu.Portal>
							<ContextMenu.Content
								class="animate-popin z-50 min-w-40 rounded-xl border border-border-strong bg-surface-overlay p-1 shadow-overlay"
							>
								<ContextMenu.Item class={menuItem} onSelect={() => unpin(pin.view)}>Unpin</ContextMenu.Item>
							</ContextMenu.Content>
						</ContextMenu.Portal>
					</ContextMenu.Root>
				</li>
			{/each}
		</ul>
		{#if pins.length === 0}
			<p class="type-body-sm px-3.5 text-text-subtle">Pin any resource from its list header.</p>
		{/if}
	</div>

	<div class="flex min-h-0 flex-1 flex-col">
		<div class="{label} mb-1 shrink-0">All resources</div>
		<AllResources {sections} />
	</div>
</aside>
