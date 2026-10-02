<script lang="ts">
	import { onMount } from 'svelte';
	import { setMode } from 'mode-watcher';
	import { homeDir } from '@tauri-apps/api/path';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import Titlebar from '#lib/components/shell/Titlebar.svelte';
	import ClusterRail from '#lib/components/shell/ClusterRail.svelte';
	import Sidebar from '#lib/components/shell/Sidebar.svelte';
	import StatusBar from '#lib/components/shell/StatusBar.svelte';
	import CommandPalette from '#lib/components/CommandPalette.svelte';
	import OnboardingModal from '#lib/components/OnboardingModal.svelte';
	import PreferencesModal from '#lib/components/PreferencesModal.svelte';
	import ConnectingOverlay from '#lib/components/ui/ConnectingOverlay.svelte';
	import Toaster from '#lib/components/ui/Toaster.svelte';
	import UnreachableView from '#lib/components/views/UnreachableView.svelte';
	import { viewRegistry } from '#lib/components/views/index.ts';
	import LogPanel from '#lib/components/logpanel/LogPanel.svelte';
	import LogWindowShell from '#lib/components/logpanel/LogWindowShell.svelte';
	import { applyAccent, applyDensity } from '#lib/appearance.ts';
	import { kubeconfigSources } from '#lib/tauri.ts';
	import { matchShortcut } from '#lib/keyboard.ts';
	import { isMac } from '#lib/platform.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { clusters } from '#lib/stores/clusters.svelte.ts';
	import { health } from '#lib/stores/health.svelte.ts';
	import { logPanel } from '#lib/stores/logPanel.svelte.ts';
	import { logWindows } from '#lib/stores/logWindows.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { settings } from '#lib/stores/settings.svelte.ts';
	import { updater } from '#lib/stores/updater.svelte.ts';

	const entry = $derived(viewRegistry[app.view]);
	const Current = $derived(entry.component);

	const logWindowKey =
		typeof window !== 'undefined'
			? new URLSearchParams(window.location.search).get('logWindow')
			: null;

	onMount(() => {
		// Pop-out log windows share the appearance preferences.
		applyDensity(settings.density.value);
		applyAccent(settings.accent.value);
		if (logWindowKey) return;
		setMode(settings.theme.value);
		let unCloseRequested: (() => void) | null = null;
		void (async () => {
			try {
				// KUBECONFIG list (or ~/.kube/config) resolved like kubectl.
				const { spec, sources } = await kubeconfigSources();
				app.kubeconfigPath = spec;
				app.kubeconfigSources = sources;
			} catch {
				// No readable kubeconfig yet: keep the default path so onboarding can explain it.
				app.kubeconfigPath = `${await homeDir()}/.kube/config`;
			}
			await clusters.refresh();
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
			unCloseRequested = await getCurrentWindow().onCloseRequested(async () => {
				await logWindows.closeAll();
			});
		})();

		return () => {
			unCloseRequested?.();
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
<div class="flex h-screen flex-col overflow-hidden bg-surface-window">
	<Titlebar />
	{#if updater.status === 'available' || updater.status === 'downloading' || updater.status === 'ready'}
		<div
			class="relative z-10 flex items-center justify-center gap-2 border-b border-border-default px-2.5 py-1"
			style="background: var(--alpha-pill-ok);"
		>
			<span class="type-caption" style="color: var(--color-status-ok);">
				Update {updater.version} available
			</span>
			<button
				type="button"
				class="type-caption underline"
				style="color: var(--color-status-ok);"
				disabled={updater.status === 'downloading'}
				onclick={() => updater.installAndRestart()}
			>
				{updater.status === 'downloading' ? 'Downloading…' : 'Restart to update'}
			</button>
			<button
				type="button"
				class="type-caption underline"
				style="color: var(--color-status-ok);"
				onclick={() => updater.dismiss()}
			>
				Later
			</button>
		</div>
	{/if}
	<div class="flex min-h-0 flex-1">
		<ClusterRail />
		{#if app.view !== 'dashboard'}
			<Sidebar />
		{/if}
		<div class="flex min-w-0 flex-1 flex-col">
			<!-- Drawers portal into <main> (data-drawer-host), outside the scroller,
			     so they stay pinned to the right edge while the view scrolls. -->
			<main class="relative flex min-h-0 min-w-0 flex-1 flex-col" data-drawer-host>
				<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
					{#if app.view !== 'dashboard' && clusters.connectionState === 'unreachable'}
						<UnreachableView />
					{:else}
						<Current {...entry.props ?? {}} />
					{/if}
				</div>
			</main>
			<LogPanel />
		</div>
	</div>
	<StatusBar />
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
