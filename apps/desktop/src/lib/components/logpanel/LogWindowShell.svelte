<script lang="ts">
	import { onMount } from 'svelte';
	import { setMode } from 'mode-watcher';
	import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import SquareArrowOutDownLeft from '@lucide/svelte/icons/square-arrow-out-down-left';
	import LogBody from '#lib/components/logpanel/LogBody.svelte';
	import LogToolbar from '#lib/components/logpanel/LogToolbar.svelte';
	import Toaster from '#lib/components/ui/Toaster.svelte';
	import StreamState from './StreamState.svelte';
	import { TOOLBAR_ICON } from '#lib/ui-classes.ts';
	import { matchShortcut } from '#lib/keyboard.ts';
	import { isMac } from '#lib/platform.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { logPanel } from '#lib/stores/logPanel.svelte.ts';
	import { isSessionTransfer, serializeSession } from '#lib/stores/sessionTransfer.ts';
	import { settings } from '#lib/stores/settings.svelte.ts';

	let { windowKey }: { windowKey: string } = $props();

	const session = $derived(logPanel.active);

	/** The main window's shortcut handler is off in the pop-out; only log
	 * search applies here (#351). Everything else falls through untouched. */
	function onKeydown(event: KeyboardEvent): void {
		if (!session || matchShortcut(event, isMac)?.type !== 'log-search') return;
		event.preventDefault();
		logPanel.focusSearch();
	}

	/** Set when close-all arrived or a re-attach is in flight: the
	 * close-requested handler must destroy without re-attaching (again). */
	let leaving = false;

	async function reattach(): Promise<void> {
		if (leaving || !session) return;
		leaving = true;
		const transfer = serializeSession(session); // serialize BEFORE closing streams
		await session.close();
		await emit('log-window-reattach', transfer);
		await getCurrentWindow().destroy();
	}

	onMount(() => {
		setMode(settings.theme.value);
		const unlisteners: UnlistenFn[] = [];
		void (async () => {
			unlisteners.push(
				await listen<unknown>(`log-window-seed:${windowKey}`, (event) => {
					if (!isSessionTransfer(event.payload)) return;
					const transfer = event.payload;
					app.kubeconfigPath = transfer.kubeconfigPath;
					app.activeCluster = transfer.activeCluster;
					void logPanel.openSeeded(transfer);
				}),
				await listen('log-window-close-all', async () => {
					leaving = true;
					// Stop the Rust-side stream tasks: webview destruction alone
					// leaks them, only stop_logs (via closeAll -> session.close)
					// aborts them. Safe here: this window's onCloseAll is null,
					// so no re-broadcast loop.
					await logPanel.closeAll();
					await getCurrentWindow().destroy();
				}),
				await getCurrentWindow().onCloseRequested(async (event) => {
					if (leaving) return; // let the close proceed
					event.preventDefault();
					await reattach();
				})
			);
			await emit(`log-window-ready:${windowKey}`);
		})();
		return () => {
			for (const un of unlisteners) un();
		};
	});
</script>

<svelte:window onkeydown={onKeydown} />

<!-- The whole window is the log card (Tonal §8.5). Its tint is its pod's cluster's,
     set on <html> by the page (windowTint), and follows that cluster's colour. -->
<div class="flex h-screen flex-col overflow-hidden bg-surface-sunken">
	{#if session}
		<header class="flex h-11 shrink-0 items-center gap-2 px-3 pt-1">
			<span class="inline-flex shrink-0 items-center" data-testid="logwindow-state">
				<StreamState status={session.status} word />
			</span>
			<span class="type-data min-w-0 truncate font-semibold text-text" title={session.pod}>{session.pod}</span>
			{#if session.container}
				<span class="type-data-sm min-w-0 truncate text-text-muted">{session.container}</span>
			{/if}
			<div class="flex-1"></div>
			<button
				type="button"
				class={TOOLBAR_ICON}
				title="Return this session to the log panel"
				aria-label="Return to log panel"
				data-testid="logwindow-reattach"
				onclick={() => void reattach()}
			>
				<SquareArrowOutDownLeft class="h-4 w-4" aria-hidden="true" />
			</button>
		</header>
		<LogToolbar {session} detached />
		<LogBody {session} />
	{:else}
		<div class="flex flex-1 items-center justify-center">
			<span class="type-body-sm text-text-muted">Connecting…</span>
		</div>
	{/if}
</div>
<Toaster />
