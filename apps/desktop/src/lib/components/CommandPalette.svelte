<script lang="ts">
	import { Command } from 'bits-ui';
	import House from '@lucide/svelte/icons/house';
	import FileText from '@lucide/svelte/icons/file-text';
	import Settings from '@lucide/svelte/icons/settings';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import {
		canOpenGrafana,
		canOpenKibana,
		openGrafanaStart,
		openKibanaStart,
		toastErrors
	} from '#lib/integration-links.ts';
	import { elastic } from '#lib/stores/elastic.svelte.ts';
	import { prometheus } from '#lib/stores/prometheus.svelte.ts';
	import Kbd from '#lib/components/ui/Kbd.svelte';
	import { app, type View } from '#lib/stores/app.svelte.ts';
	import { clusters } from '#lib/stores/clusters.svelte.ts';
	import { health } from '#lib/stores/health.svelte.ts';
	import { logPanel } from '#lib/stores/logPanel.svelte.ts';
	import { isMac, modLabel } from '#lib/platform.ts';
	import { navigation } from '#lib/stores/navigation.svelte.ts';
	import { profiles } from '#lib/stores/profiles.svelte.ts';
	import { countFor } from '#lib/stores/nav-counts.svelte.ts';
	import { dynamic } from '#lib/stores/dynamic.svelte.ts';
	import { searchKeywords } from '#lib/resource-kinds.ts';
	import { RESOURCE_PREFIX, paletteFilter } from '#lib/palette-filter.ts';
	import StatusGlyph, { type GlyphState } from '#lib/components/ui/StatusGlyph.svelte';
	import { tintStyle } from '#lib/appearance.ts';
	import type { ConnectionState } from '#lib/stores/clusters.svelte.ts';
	import { providerOf } from '#lib/provider.ts';
	import type { Component } from 'svelte';

	interface Action {
		label: string;
		icon: Component;
		view?: View;
		/** Takes precedence over `view` navigation in the select handler. */
		run?: () => void;
	}
	const staticActions: Action[] = [
		{ label: 'All Clusters dashboard', icon: House, view: 'dashboard' },
		{ label: 'Tail logs', icon: FileText, view: 'logs' },
		{ label: 'Preferences', icon: Settings, view: 'overview' }
	];
	// Integrations of the active context (#526): open their web UIs, or set them up.
	const es = $derived(elastic.endpointFor(app.activeCluster));
	const prom = $derived(prometheus.active);
	const integrationActions = $derived<Action[]>([
		...(canOpenKibana(es)
			? [{ label: 'Open Kibana', icon: ExternalLink, run: () => void toastErrors(() => openKibanaStart(es)) }]
			: []),
		...(canOpenGrafana(prom)
			? [{ label: 'Open Grafana', icon: ExternalLink, run: () => void toastErrors(() => openGrafanaStart(prom)) }]
			: []),
		{ label: 'Integrations settings', icon: Settings, run: () => app.openPreferences('integrations') }
	]);
	const actions = $derived<Action[]>([
		...staticActions,
		...integrationActions,
		...(app.selectedPod
			? [
					{
						label: 'Open pod logs',
						icon: FileText,
						run: () =>
							void logPanel.openFor({
								namespace: app.selectedPod!.namespace,
								name: app.selectedPod!.name
							})
					}
				]
			: [])
	]);

	// Go to resource (resource-kinds §6): every type of the sidebar, hidden
	// ones included. `value` starts with "Go to" so it never collides with a
	// cluster context of the same name (bits-ui highlights by value).
	const resourceItems = $derived<
		{ view: View; label: string; caption: string | null; section: string; value: string; keywords: string[] }[]
	>([
		...navigation.arranged.flatMap((section) =>
			section.items.map((item) => ({
				view: item.view,
				label: item.label,
				caption: null,
				section: section.label,
				value: `${RESOURCE_PREFIX}${item.label}`,
				keywords: searchKeywords(item.view, item.label)
			}))
		),
		// The active cluster's custom kinds (§5.3); the group keeps same-named kinds apart.
		...dynamic.customGroups.flatMap((g) =>
			g.kinds.map((k) => ({
				view: k.view,
				label: k.kind,
				caption: g.group,
				section: 'Custom Resources',
				value: `${RESOURCE_PREFIX}${k.kind} · ${g.group}`,
				keywords: searchKeywords(k.view, k.kind, k)
			}))
		)
	]);
	const viewByValue = $derived(new Map(resourceItems.map((r) => [r.value, r.view] as const)));
	/** Value of the highlighted row (bits-ui `bind:value`). */
	let highlighted = $state('');
	// Every opening starts from the top: a highlight left over from the last
	// search would make ↵ / ⌘↵ act on it (Esc closes via closeTopOverlay).
	$effect.pre(() => {
		if (!app.paletteOpen) highlighted = '';
	});

	function openResource(view: View, pin: boolean) {
		close();
		if (pin) profiles.pin(view);
		app.navigate(view);
	}

	/** ⌘↵ (Ctrl+↵ elsewhere) on a type: open it and pin it to the active profile. */
	function onKeydownCapture(event: KeyboardEvent) {
		const mod = isMac ? event.metaKey : event.ctrlKey;
		// ↵ that confirms an IME composition is not a command.
		if (event.key !== 'Enter' || !mod || event.isComposing) return;
		const view = viewByValue.get(highlighted);
		if (!view) return;
		event.preventDefault();
		event.stopPropagation();
		openResource(view, true);
	}

	const pinHint = isMac ? '⌘↵' : 'Ctrl+↵';

	// A cluster's health is a shape and a word (Tonal §6, §9.3), as on the rail.
	const healthLook: Record<ConnectionState, { glyph: GlyphState; tone: string; word: string }> = {
		connected: { glyph: 'ok', tone: 'text-success', word: 'Connected' },
		unreachable: { glyph: 'err', tone: 'text-error', word: 'Unreachable' },
		unknown: { glyph: 'unknown', tone: 'text-text-subtle', word: 'Not connected' }
	};

	// Rows are menu items on the overlay: the highlight is a layer of the text
	// colour (`.palette-row`, app.css), which shows on every surface and tint.
	const row = 'palette-row flex min-h-9 items-center gap-3 rounded-md px-3 py-1.5 text-text';
	const heading = 'type-label px-3 pt-2 pb-1 text-text-subtle';

	function close() {
		app.paletteOpen = false;
	}

	function selectCluster(name: string) {
		close();
		if (name !== app.activeCluster) void clusters.switchCluster(name);
	}

	function selectAction(action: Action) {
		close();
		if (action.run) {
			action.run();
			return;
		}
		if (action.label === 'Preferences') {
			app.preferencesOpen = true;
			return;
		}
		if (action.view) app.navigate(action.view);
	}
</script>

{#if app.paletteOpen}
	<!-- Backdrop click closes; Esc handled by the global handler. -->
	<div class="animate-fadein fixed inset-0 z-40 bg-black/45" role="presentation" onclick={close}></div>
	<!-- 580 px (Tonal §8.6), narrower than a small window allows. -->
	<div class="fixed inset-x-0 top-[110px] z-50 mx-auto w-[580px] max-w-[calc(100vw-2rem)]">
		<Command.Root
			bind:value={highlighted}
			filter={paletteFilter}
			onkeydowncapture={onKeydownCapture}
			class="card animate-popin flex max-h-[calc(100vh-110px-1rem)] flex-col overflow-hidden rounded-xl bg-surface-overlay shadow-overlay"
			data-testid="command-palette"
		>
			<div class="flex shrink-0 items-center gap-3 border-b border-outline px-5">
				<Command.Input
					autofocus
					aria-describedby="palette-keys"
					data-bare
					placeholder="Search clusters, resources, actions…"
					class="type-title h-12 min-w-0 flex-1 bg-transparent font-normal text-text outline-none placeholder:text-text-subtle"
				/>
				<Kbd label="esc" />
			</div>
			<!-- A scroller is a Tab stop of its own (Chromium): it shows the ring inside. -->
			<Command.List class="focus-ring-inset max-h-80 min-h-0 overflow-y-auto rounded-b-xl p-2">
				<Command.Viewport>
					<Command.Empty class="type-body-sm py-6 text-center text-text-subtle">
						No results.
					</Command.Empty>

					<Command.Group>
						<Command.GroupHeading class={heading}>Switch cluster</Command.GroupHeading>
						<Command.GroupItems>
							{#each clusters.contexts as ctx, i (ctx.name)}
								{@const look =
									healthLook[ctx.name === app.activeCluster ? clusters.connectionState : health.for(ctx.name).state]}
								<!-- The row carries its own cluster's tint (Tonal §4.1), whichever cluster is active. -->
								<Command.Item
									value={ctx.name}
									onSelect={() => selectCluster(ctx.name)}
									data-cluster-row={ctx.name}
									data-tint
									style={tintStyle(clusters.identityFor(ctx.name))}
									class={row}
								>
									<span class="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-primary" data-testid="identity-mark"></span>
									<!-- Long context names (EKS ARNs) often differ only at the end: the name
									     wraps anywhere onto a second line rather than losing its end (§9.2). -->
									<span class="type-body line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]" title={ctx.name}
										>{ctx.name}</span
									>
									<span
										class="type-micro shrink-0 rounded-xs bg-primary-container px-1.5 py-px font-mono text-on-primary-container"
									>
										{providerOf(ctx.name, ctx.cluster_server)}
									</span>
									<!-- Connected is the circle alone, its word kept for screen readers; a state
									     that needs attention is written out. -->
									<span class="flex shrink-0 items-center gap-1.5 {look.tone}" data-testid="cluster-health">
										<StatusGlyph state={look.glyph} />
										<span class={look.glyph === 'ok' ? 'sr-only' : 'type-body-sm text-text-muted'}>{look.word}</span>
									</span>
									{#if i < 5}
										<Kbd label="{modLabel}{i + 1}" />
									{/if}
								</Command.Item>
							{/each}
						</Command.GroupItems>
					</Command.Group>

					<Command.Group>
						<Command.GroupHeading class={heading}>Actions</Command.GroupHeading>
						<Command.GroupItems>
							{#each actions as action (action.label)}
								<Command.Item value={action.label} onSelect={() => selectAction(action)} class={row}>
									<action.icon class="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
									<span class="type-body">{action.label}</span>
								</Command.Item>
							{/each}
						</Command.GroupItems>
					</Command.Group>

					<Command.Group>
						<Command.GroupHeading class={heading}>Go to resource</Command.GroupHeading>
						<Command.GroupItems>
							<!-- No section dot (Tonal §3 #6): the section is named in words. -->
							{#each resourceItems as item (item.view)}
								{@const count = countFor(item.view)}
								<Command.Item
									value={item.value}
									keywords={item.keywords}
									data-resource={item.view}
									onSelect={() => openResource(item.view, false)}
									class={row}
								>
									<span class="type-body min-w-0 shrink truncate">{item.label}</span>
									<span class="type-data-sm min-w-0 flex-1 truncate text-text-muted">{item.caption ?? ''}</span>
									{#if navigation.isHidden(item.view)}
										<span class="type-body-sm shrink-0 text-text-muted">Hidden in Preferences</span>
									{:else if profiles.isPinned(item.view)}
										<span class="type-body-sm shrink-0 font-semibold text-text-muted">Pinned</span>
									{/if}
									<span class="type-body-sm shrink-0 text-text-muted">{item.section}</span>
									{#if count}
										<span class="type-data-sm w-8 shrink-0 text-right text-text-muted"
											>{count.value}<span class="sr-only">&#32;objects</span></span
										>
									{/if}
								</Command.Item>
							{/each}
						</Command.GroupItems>
					</Command.Group>
				</Command.Viewport>
			</Command.List>
			<div
				id="palette-keys"
				class="type-body-sm flex shrink-0 justify-end gap-4 border-t border-outline px-5 py-2 text-text-muted"
			>
				<span>↵ open</span>
				<span>{pinHint} open and pin to {profiles.active.name}</span>
			</div>
		</Command.Root>
	</div>
{/if}
