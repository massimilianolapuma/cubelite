<script lang="ts">
	import { onMount } from 'svelte';
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
	import { matchShortcut } from '$lib/keyboard';
	import { isMac } from '$lib/platform';
	import { app } from '$lib/stores/app.svelte';
	import { clusters } from '$lib/stores/clusters.svelte';
	import { health } from '$lib/stores/health.svelte';
	import { resources } from '$lib/stores/resources.svelte';
	import { settings } from '$lib/stores/settings.svelte';

	const entry = $derived(viewRegistry[app.view]);
	const Current = $derived(entry.component);

	onMount(() => {
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
	<div class="flex min-h-0 flex-1">
		<ClusterRail />
		{#if app.view !== 'dashboard'}
			<Sidebar />
		{/if}
		<main class="relative flex min-w-0 flex-1 flex-col overflow-y-auto">
			{#if app.view !== 'dashboard' && clusters.connectionState === 'unreachable'}
				<UnreachableView />
			{:else}
				<Current {...entry.props ?? {}} />
			{/if}
		</main>
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
