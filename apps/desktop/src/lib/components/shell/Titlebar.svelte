<script lang="ts">
	import Search from '@lucide/svelte/icons/search';
	import Kbd from '$lib/components/ui/Kbd.svelte';
	import NamespaceDropdown from '$lib/components/ui/NamespaceDropdown.svelte';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { app } from '$lib/stores/app.svelte';
	import { clusters } from '$lib/stores/clusters.svelte';
	import { isMac, modLabel } from '$lib/platform';
	import { providerOf } from '$lib/provider';
	import { isDragSurface } from '$lib/window-drag';

	// Explicit drag fallback: Tauri's injected data-tauri-drag-region
	// handler is unreliable with the Overlay title bar on macOS (#317).
	function beginDrag(event: MouseEvent) {
		if (event.button !== 0) return;
		if (!isDragSurface(event.target as Element | null)) return;
		const window = getCurrentWindow();
		if (event.detail === 2) {
			void window.toggleMaximize();
		} else {
			void window.startDragging();
		}
	}

	const activeContext = $derived(
		clusters.contexts.find((c) => c.name === app.activeCluster) ?? null
	);
	const identity = $derived(
		app.activeCluster ? clusters.identityFor(app.activeCluster) : 'blue'
	);
	const provider = $derived(
		activeContext ? providerOf(activeContext.name, activeContext.cluster_server) : null
	);
</script>

<!-- The mousedown handler only begins a window drag — not an
     interactive control, so no ARIA role applies. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<header
	data-tauri-drag-region
	onmousedown={beginDrag}
	class="flex h-[42px] shrink-0 items-center gap-3 border-b border-border-default bg-surface-surface pr-3"
	style="padding-left: {isMac ? '78px' : '12px'};"
>
	{#if activeContext}
		<div class="flex min-w-0 items-center gap-2" data-tauri-drag-region>
			<span
				class="h-2 w-2 shrink-0 rounded-full"
				style="background: var(--color-cluster-{identity});"
				data-testid="identity-dot"
			></span>
			<span class="type-subtitle truncate">{activeContext.name}</span>
			{#if provider}
				<span
					class="rounded-sm px-1.5 py-px font-mono text-[10px] font-medium"
					style="color: var(--color-cluster-{identity}); background: color-mix(in srgb, var(--color-cluster-{identity}) 12%, transparent);"
				>
					{provider}
				</span>
			{/if}
			<span class="flex items-center gap-1.5">
				<span
					class="h-1.5 w-1.5 rounded-full"
					style="background: {clusters.connectionState === 'connected'
						? 'var(--color-status-ok)'
						: clusters.connectionState === 'unreachable'
							? 'var(--color-status-err)'
							: 'var(--color-text-tertiary)'};"
				></span>
				<span class="type-caption text-text-tertiary">
					{clusters.connectionState === 'connected'
						? 'Connected'
						: clusters.connectionState === 'unreachable'
							? 'Unreachable'
							: '—'}
				</span>
			</span>
		</div>
	{/if}

	<div class="flex-1" data-tauri-drag-region></div>

	<button
		type="button"
		class="focus-ring flex h-7 w-60 items-center gap-2 rounded-md border border-border-default bg-surface-window px-2.5 text-left hover:border-border-strong"
		onclick={() => (app.paletteOpen = true)}
	>
		<Search class="h-3 w-3 text-text-tertiary" />
		<span class="type-caption flex-1 text-text-disabled">Search &amp; switch…</span>
		<Kbd label="{modLabel}K" />
	</button>

	<NamespaceDropdown />
</header>
