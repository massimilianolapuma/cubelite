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
	import { CUSTOM_DOT } from '#lib/components/shell/CustomResources.svelte';
	import { searchKeywords } from '#lib/resource-kinds.ts';
	import { RESOURCE_PREFIX, paletteFilter } from '#lib/palette-filter.ts';
	import { identityVar } from '#lib/cluster-identity.ts';
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
		{ view: View; label: string; caption: string | null; section: string; dot: string; value: string; keywords: string[] }[]
	>([
		...navigation.arranged.flatMap((section) =>
			section.items.map((item) => ({
				view: item.view,
				label: item.label,
				caption: null,
				section: section.label,
				dot: section.dot,
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
				dot: CUSTOM_DOT,
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
	<div
		class="animate-fadein fixed inset-0 z-40"
		style="background: color-mix(in srgb, black 45%, transparent);"
		role="presentation"
		onclick={close}
	></div>
	<div class="fixed inset-x-0 top-[110px] z-50 mx-auto w-[580px]">
		<Command.Root
			bind:value={highlighted}
			filter={paletteFilter}
			onkeydowncapture={onKeydownCapture}
			class="animate-popin overflow-hidden rounded-2xl border border-border-strong bg-surface-overlay shadow-overlay"
		>
			<div class="flex items-center gap-2 border-b border-border-faint px-3">
				<Command.Input
					autofocus
					aria-describedby="palette-keys"
					placeholder="Search clusters, resources, actions…"
					class="h-11 flex-1 bg-transparent type-subtitle font-normal text-text-primary outline-none placeholder:text-text-disabled"
				/>
				<Kbd label="esc" />
			</div>
			<Command.List class="max-h-80 overflow-y-auto p-1.5">
				<Command.Viewport>
					<Command.Empty class="py-6 text-center text-xs text-text-disabled">
						No results.
					</Command.Empty>

					<Command.Group>
						<Command.GroupHeading class="type-section px-2 pt-1.5 pb-1 text-text-tertiary">
							Switch cluster
						</Command.GroupHeading>
						<Command.GroupItems>
							{#each clusters.contexts as ctx, i (ctx.name)}
								<Command.Item
									value={ctx.name}
									onSelect={() => selectCluster(ctx.name)}
									class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 data-selected:bg-(--alpha-active-nav-bg)"
								>
									<span
										class="h-2 w-2 shrink-0 rounded-full"
										style="background: {identityVar(clusters.identityFor(ctx.name))};"
									></span>
									<span class="type-body flex-1 truncate text-text-primary">{ctx.name}</span>
									<span
										class="rounded-sm px-1.5 py-px type-micro font-mono"
										style="color: {identityVar(clusters.identityFor(ctx.name))}; background: color-mix(in srgb, {identityVar(clusters.identityFor(ctx.name))} 12%, transparent);"
									>
										{providerOf(ctx.name, ctx.cluster_server)}
									</span>
									{@const state = ctx.name === app.activeCluster
										? clusters.connectionState
										: health.for(ctx.name).state}
									<span
										class="h-1.5 w-1.5 rounded-full"
										style="background: {state === 'connected'
											? 'var(--color-status-ok)'
											: state === 'unreachable'
												? 'var(--color-status-err)'
												: 'var(--color-text-tertiary)'};"
									></span>
									{#if i < 5}
										<Kbd label="{modLabel}{i + 1}" />
									{/if}
								</Command.Item>
							{/each}
						</Command.GroupItems>
					</Command.Group>

					<Command.Group>
						<Command.GroupHeading class="type-section px-2 pt-2.5 pb-1 text-text-tertiary">
							Actions
						</Command.GroupHeading>
						<Command.GroupItems>
							{#each actions as action (action.label)}
								<Command.Item
									value={action.label}
									onSelect={() => selectAction(action)}
									class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 data-selected:bg-(--alpha-active-nav-bg)"
								>
									<action.icon class="h-3.5 w-3.5 text-text-tertiary" />
									<span class="type-body text-text-secondary">{action.label}</span>
								</Command.Item>
							{/each}
						</Command.GroupItems>
					</Command.Group>

					<Command.Group>
						<Command.GroupHeading class="type-section px-2 pt-2.5 pb-1 text-text-tertiary">
							Go to resource
						</Command.GroupHeading>
						<Command.GroupItems>
							{#each resourceItems as item (item.view)}
								{@const count = countFor(item.view)}
								<Command.Item
									value={item.value}
									keywords={item.keywords}
									data-resource={item.view}
									onSelect={() => openResource(item.view, false)}
									class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 data-selected:bg-(--alpha-active-nav-bg)"
								>
									<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {item.dot};"></span>
									<span class="type-body truncate text-text-secondary">{item.label}</span>
									<span class="type-caption flex-1 truncate font-mono text-text-disabled">{item.caption ?? ''}</span>
									{#if navigation.isHidden(item.view)}
										<span class="type-caption text-text-disabled">Hidden in Preferences</span>
									{:else if profiles.isPinned(item.view)}
										<span class="type-caption text-text-tertiary">Pinned</span>
									{/if}
									<span class="type-caption text-text-tertiary">{item.section}</span>
									{#if count}
										<span class="type-micro w-8 text-right font-mono text-text-tertiary"
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
				class="type-caption flex justify-end gap-3 border-t border-border-faint px-3 py-1.5 text-text-tertiary"
			>
				<span>↵ open</span>
				<span>{pinHint} open and pin to {profiles.active.name}</span>
			</div>
		</Command.Root>
	</div>
{/if}
