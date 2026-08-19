<script lang="ts">
	import { onMount } from 'svelte';
	import { setMode } from 'mode-watcher';
	import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import SquareArrowOutDownLeft from '@lucide/svelte/icons/square-arrow-out-down-left';
	import LogBody from '$lib/components/logpanel/LogBody.svelte';
	import LogToolbar from '$lib/components/logpanel/LogToolbar.svelte';
	import Toaster from '$lib/components/ui/Toaster.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { logPanel } from '$lib/stores/logPanel.svelte';
	import { isSessionTransfer, serializeSession } from '$lib/stores/sessionTransfer';
	import { settings } from '$lib/stores/settings.svelte';

	let { windowKey }: { windowKey: string } = $props();

	const session = $derived(logPanel.active);

	function dot(status: string): string {
		if (status === 'streaming') return 'var(--color-status-ok)';
		if (status === 'error') return 'var(--color-status-err)';
		return 'var(--color-status-warn)';
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

<div class="flex h-screen flex-col overflow-hidden bg-surface-window">
	{#if session}
		<header
			class="flex min-h-[34px] items-center gap-2 border-b border-border-default bg-surface-raised px-3"
		>
			<span
				class="h-1.5 w-1.5 shrink-0 rounded-full"
				style="background: {dot(session.status)};"
				aria-hidden="true"
			></span>
			<span class="type-caption font-mono font-medium text-text-primary">{session.pod}</span>
			{#if session.container}
				<span class="type-caption font-mono text-text-tertiary">{session.container}</span>
			{/if}
			<div class="flex-1"></div>
			<button
				type="button"
				class="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:text-text-secondary"
				title="Return this session to the log panel"
				aria-label="Return to log panel"
				data-testid="logwindow-reattach"
				onclick={() => void reattach()}
			>
				<SquareArrowOutDownLeft size={14} strokeWidth={1.5} />
			</button>
		</header>
		<LogToolbar {session} detached />
		<LogBody {session} />
	{:else}
		<div class="flex flex-1 items-center justify-center">
			<span class="type-caption text-text-tertiary">Connecting…</span>
		</div>
	{/if}
</div>
<Toaster />
