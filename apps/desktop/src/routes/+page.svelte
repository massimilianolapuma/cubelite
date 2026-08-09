<script lang="ts">
	import { onMount } from 'svelte';
	import { setMode } from 'mode-watcher';
	import { homeDir } from '@tauri-apps/api/path';
	import Titlebar from '$lib/components/shell/Titlebar.svelte';
	import ClusterRail from '$lib/components/shell/ClusterRail.svelte';
	import Sidebar from '$lib/components/shell/Sidebar.svelte';
	import StatusBar from '$lib/components/shell/StatusBar.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import OnboardingModal from '$lib/components/OnboardingModal.svelte';
	import PreferencesModal from '$lib/components/PreferencesModal.svelte';
	import ConnectingOverlay from '$lib/components/ui/ConnectingOverlay.svelte';
	import Toaster from '$lib/components/ui/Toaster.svelte';
	import UnreachableView from '$lib/components/views/UnreachableView.svelte';
	import { viewRegistry } from '$lib/components/views';
	import LogPanel from '$lib/components/logpanel/LogPanel.svelte';
	import { matchShortcut } from '$lib/keyboard';
	import { isMac } from '$lib/platform';
	import { app } from '$lib/stores/app.svelte';
	import { clusters } from '$lib/stores/clusters.svelte';
	import { health } from '$lib/stores/health.svelte';
	import { logPanel } from '$lib/stores/logPanel.svelte';
	import { resources } from '$lib/stores/resources.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { updater } from '$lib/stores/updater.svelte';

	const entry = $derived(viewRegistry[app.view]);
	const Current = $derived(entry.component);

	onMount(() => {
		setMode(settings.theme.value);
		void (async () => {
			const dir = await homeDir();
			app.kubeconfigPath = `${dir}/.kube/config`;
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
		})();

		return () => {
			void resources.stopWatching();
			resources.stopAutoRefresh();
			health.stop();
		};
	});

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && app.closeTopOverlay()) {
			event.preventDefault();
			return;
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
			<main class="relative flex min-w-0 flex-1 flex-col overflow-y-auto">
				{#if app.view !== 'dashboard' && clusters.connectionState === 'unreachable'}
					<UnreachableView />
				{:else}
					<Current {...entry.props ?? {}} />
				{/if}
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
