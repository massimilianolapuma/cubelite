<script lang="ts">
	import { Command } from 'bits-ui';
	import House from '@lucide/svelte/icons/house';
	import Boxes from '@lucide/svelte/icons/boxes';
	import Layers from '@lucide/svelte/icons/layers';
	import FileText from '@lucide/svelte/icons/file-text';
	import Settings from '@lucide/svelte/icons/settings';
	import Kbd from '$lib/components/ui/Kbd.svelte';
	import { app, type View } from '$lib/stores/app.svelte';
	import { clusters } from '$lib/stores/clusters.svelte';
	import { modLabel } from '$lib/platform';
	import { providerOf } from '$lib/provider';
	import type { Component } from 'svelte';

	interface Action {
		label: string;
		icon: Component;
		view: View;
	}
	const actions: Action[] = [
		{ label: 'All Clusters dashboard', icon: House, view: 'dashboard' },
		{ label: 'Go to Overview', icon: Layers, view: 'overview' },
		{ label: 'Go to Pods', icon: Boxes, view: 'pods' },
		{ label: 'Go to Deployments', icon: Layers, view: 'deployments' },
		{ label: 'Tail logs', icon: FileText, view: 'logs' },
		{ label: 'Preferences', icon: Settings, view: 'overview' }
	];

	function close() {
		app.paletteOpen = false;
	}

	function selectCluster(name: string) {
		close();
		if (name !== app.activeCluster) void clusters.switchCluster(name);
	}

	function selectAction(action: Action) {
		close();
		if (action.label === 'Preferences') {
			app.preferencesOpen = true;
			return;
		}
		app.navigate(action.view);
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
			class="animate-popin overflow-hidden rounded-2xl border border-border-strong bg-surface-overlay shadow-overlay"
		>
			<div class="flex items-center gap-2 border-b border-border-faint px-3">
				<Command.Input
					autofocus
					placeholder="Search clusters, views, actions…"
					class="h-11 flex-1 bg-transparent text-[13.5px] text-text-primary outline-none placeholder:text-text-disabled"
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
										style="background: var(--color-cluster-{clusters.identityFor(ctx.name)});"
									></span>
									<span class="type-body flex-1 truncate text-text-primary">{ctx.name}</span>
									<span
										class="rounded-sm px-1.5 py-px font-mono text-[10px] font-medium"
										style="color: var(--color-cluster-{clusters.identityFor(ctx.name)}); background: color-mix(in srgb, var(--color-cluster-{clusters.identityFor(ctx.name)}) 12%, transparent);"
									>
										{providerOf(ctx.name, ctx.cluster_server)}
									</span>
									{#if ctx.name === app.activeCluster}
										<span
											class="h-1.5 w-1.5 rounded-full"
											style="background: {clusters.connectionState === 'connected'
												? 'var(--color-status-ok)'
												: clusters.connectionState === 'unreachable'
													? 'var(--color-status-err)'
													: 'var(--color-text-tertiary)'};"
										></span>
									{/if}
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
				</Command.Viewport>
			</Command.List>
		</Command.Root>
	</div>
{/if}
