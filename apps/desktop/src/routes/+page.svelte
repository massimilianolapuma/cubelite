<script lang="ts">
	import { onMount } from 'svelte';
	import { setMode } from 'mode-watcher';
	import { listen } from '@tauri-apps/api/event';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import ClusterRail from '#lib/components/shell/ClusterRail.svelte';
	import Sidebar from '#lib/components/shell/Sidebar.svelte';
	import CommandPalette from '#lib/components/CommandPalette.svelte';
	import OnboardingModal from '#lib/components/OnboardingModal.svelte';
	import PreferencesModal from '#lib/components/PreferencesModal.svelte';
	import IntegrationsBanner from '#lib/components/IntegrationsBanner.svelte';
	import ConnectingOverlay from '#lib/components/ui/ConnectingOverlay.svelte';
	import Toaster from '#lib/components/ui/Toaster.svelte';
	import UnreachableView from '#lib/components/views/UnreachableView.svelte';
	import { viewEntry } from '#lib/components/views/index.ts';
	import LogPanel from '#lib/components/logpanel/LogPanel.svelte';
	import LogWindowShell from '#lib/components/logpanel/LogWindowShell.svelte';
	import { applyDensity, applyTint, tintFor } from '#lib/appearance.ts';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import { beginWindowDrag } from '#lib/window-drag.ts';
	import { KUBECONFIG_CHANGED } from '#lib/tauri.ts';
	import { matchShortcut } from '#lib/keyboard.ts';
	import { profiles } from '#lib/stores/profiles.svelte.ts';
	import { isMac } from '#lib/platform.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { layout } from '#lib/stores/layout.svelte.ts';
	import { clusters } from '#lib/stores/clusters.svelte.ts';
	import { health } from '#lib/stores/health.svelte.ts';
	import { logPanel } from '#lib/stores/logPanel.svelte.ts';
	import { logWindows } from '#lib/stores/logWindows.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { settings } from '#lib/stores/settings.svelte.ts';
	import { updater } from '#lib/stores/updater.svelte.ts';

	const entry = $derived(viewEntry(app.view));
	const Current = $derived(entry.component);

	const logWindowKey =
		typeof window !== 'undefined'
			? new URLSearchParams(window.location.search).get('logWindow')
			: null;

	// The window takes the tint of the cluster it is on. A pop-out log window keeps
	// its pod's cluster; the All Clusters dashboard and onboarding belong to none.
	$effect(() => {
		const neutral = !logWindowKey && (app.view === 'dashboard' || app.onboardingOpen);
		applyTint(tintFor(neutral, app.activeCluster, (name) => clusters.identityFor(name)));
	});

	/**
	 * Marks the end of startup on <html data-app-ready>. The e2e suite waits for it:
	 * clicking while the top bar and rail still change size made a mousedown and
	 * its mouseup land on different elements, so the click was lost (#584).
	 */
	function markReady() {
		document.documentElement.dataset.appReady = 'true';
	}

	onMount(() => {
		// Pop-out log windows share the appearance preferences.
		applyDensity(settings.density.value);
		if (logWindowKey) {
			markReady();
			return;
		}
		setMode(settings.theme.value);
		let unCloseRequested: (() => void) | null = null;
		let unKubeconfigChanged: (() => void) | null = null;
		void (async () => {
			try {
				await clusters.reloadKubeconfig('startup');
				unKubeconfigChanged = await listen(KUBECONFIG_CHANGED, () => {
					void clusters.reloadKubeconfig('file-change');
				});
				const active =
					clusters.contexts.find((c) => c.is_active)?.name ?? clusters.contexts[0]?.name ?? null;
				app.activeCluster = active;
				if (active) {
					app.view = 'overview';
					await clusters.retry();
				}
				if (!settings.onboardingSeen.value) {
					app.onboardingOpen = true;
				}
				health.start();
				void updater.checkForUpdates(true);
				void logWindows.init();
			} finally {
				// Startup has settled the layout (cluster name, connection state, rail
				// avatars), or failed: either way the UI is final.
				markReady();
			}
			unCloseRequested = await getCurrentWindow().onCloseRequested(async () => {
				await logWindows.closeAll();
			});
		})();

		return () => {
			unCloseRequested?.();
			unKubeconfigChanged?.();
			void clusters.stopKubeconfigWatch();
			void resources.stopWatching();
			resources.stopAutoRefresh();
			health.stop();
		};
	});

	function onKeydown(event: KeyboardEvent) {
		if (logWindowKey) return;
		if (event.key === 'Escape') {
			// The connecting overlay sits above everything else; Esc cancels the switch.
			if (app.connecting !== null) {
				event.preventDefault();
				clusters.cancelSwitch();
				return;
			}
			if (app.closeTopOverlay()) {
				event.preventDefault();
				return;
			}
		}
		const action = matchShortcut(event, isMac);
		if (!action) return;
		// log-panel/log-search are no-ops while the panel is closed — only
		// swallow the keystroke (preventDefault) when it actually does something,
		// so the shortcut falls through to the browser/OS otherwise.
		if (action.type === 'log-panel' || action.type === 'log-search') {
			if (!logPanel.open) return;
			event.preventDefault();
			if (action.type === 'log-panel') logPanel.toggleCollapsed();
			else logPanel.focusSearch();
			return;
		}
		event.preventDefault();
		if (action.type === 'palette') {
			app.paletteOpen = !app.paletteOpen;
		} else if (action.type === 'preferences') {
			app.preferencesOpen = true;
		} else if (action.type === 'switch-profile') {
			profiles.activateIndex(action.index);
		} else {
			const target = clusters.contexts[action.index];
			if (target && target.name !== app.activeCluster) {
				void clusters.switchCluster(target.name);
			}
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if logWindowKey}
	<LogWindowShell windowKey={logWindowKey} />
{:else}
<div class="flex h-screen overflow-hidden bg-surface-window">
	<!-- Rail and sidebar sit on the window ground (Tonal §5). On macOS a strip above
	     the rail leaves room for the window controls; the sidebar starts beside them,
	     so it has the same height on every platform. Both gaps drag the window. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="flex shrink-0 flex-col">
		<div class="{isMac ? 'h-9' : 'h-2'} shrink-0" data-tauri-drag-region onmousedown={beginWindowDrag}></div>
		<ClusterRail />
	</div>
	{#if app.view !== 'dashboard'}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="flex shrink-0 flex-col">
			<div class="h-2 shrink-0" data-tauri-drag-region onmousedown={beginWindowDrag}></div>
			<Sidebar />
		</div>
	{/if}
	<!-- Without the sidebar the top bar would start under the macOS window controls. -->
	<div class="flex min-w-0 flex-1 flex-col gap-3 py-3 pr-3 {isMac && app.view === 'dashboard' ? 'pl-3' : 'pl-1'}">
		<TopBar />
		{#if updater.status === 'available' || updater.status === 'downloading' || updater.status === 'ready'}
			<div
				class="flex min-h-(--chip-h) shrink-0 items-center gap-3 rounded-full bg-success-container px-4 text-on-success-container"
				role="status"
			>
				<StatusGlyph state="ok" />
				<span class="type-body-sm min-w-0 flex-1 truncate">Update {updater.version} available</span>
				<button
					type="button"
					class="focus-ring type-body rounded-full px-2 font-semibold underline-offset-2 hover:underline disabled:opacity-45"
					disabled={updater.status === 'downloading'}
					onclick={() => updater.installAndRestart()}
				>
					{updater.status === 'downloading' ? 'Downloading…' : 'Restart to update'}
				</button>
				<button
					type="button"
					class="focus-ring type-body rounded-full px-2 underline-offset-2 hover:underline"
					onclick={() => updater.dismiss()}
				>
					Later
				</button>
			</div>
		{/if}
		{#if app.view !== 'dashboard' && clusters.connectionState === 'connected'}
			<IntegrationsBanner />
		{/if}
		<!-- The content card and the detail panel (Tonal §5). The panel renders into
		     the host beside the card: docked it is a card of its own there, and when this
		     row is narrower than 1000 px it lies over the card instead. The row's width is
		     what decides, so the rule follows the sidebar and the rail, not the window. -->
		<div class="relative flex min-h-0 min-w-0 flex-1" bind:clientWidth={layout.contentWidth}>
			<main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-surface-container">
				<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
					{#if app.view !== 'dashboard' && clusters.connectionState === 'unreachable'}
						<UnreachableView />
					{:else}
						<Current {...entry.props ?? {}} />
					{/if}
				</div>
			</main>
			<div class="flex shrink-0" data-drawer-host></div>
		</div>
		<LogPanel />
	</div>
</div>

<CommandPalette />
{#if app.preferencesOpen}
	<PreferencesModal />
{/if}
{#if app.onboardingOpen}
	<OnboardingModal />
{/if}
<Toaster />
<ConnectingOverlay />
{/if}
