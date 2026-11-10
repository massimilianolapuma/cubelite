<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Search from '@lucide/svelte/icons/search';
	import Kbd from '#lib/components/ui/Kbd.svelte';
	import NamespaceDropdown from '#lib/components/ui/NamespaceDropdown.svelte';
	import StatusGlyph, { type GlyphState } from '#lib/components/ui/StatusGlyph.svelte';
	import { tintStyle } from '#lib/appearance.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { clusters, type ConnectionState } from '#lib/stores/clusters.svelte.ts';
	import { health } from '#lib/stores/health.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { toasts } from '#lib/stores/toasts.svelte.ts';
	import { modLabel } from '#lib/platform.ts';
	import { providerOf } from '#lib/provider.ts';
	import { beginWindowDrag } from '#lib/window-drag.ts';

	// Top bar (Tonal §5): the cluster chip, the namespace chip, warnings and
	// search. It is also the window's drag region; the chips are not. What the
	// status bar used to show lives here: the Kubernetes version on the chip, the
	// server address in its menu, the warnings count on the right.

	const activeContext = $derived(clusters.contexts.find((c) => c.name === app.activeCluster) ?? null);
	const identity = $derived(app.activeCluster ? clusters.identityFor(app.activeCluster) : 'blue');
	const provider = $derived(
		activeContext ? providerOf(activeContext.name, activeContext.cluster_server) : null
	);
	const server = $derived(activeContext?.cluster_server ?? null);
	const version = $derived(app.activeCluster ? health.for(app.activeCluster).version : null);
	const warningCount = $derived(resources.warningEvents.length);

	// The connection state is a shape and a word, never a colour alone.
	const connection: Record<ConnectionState, { glyph: GlyphState; tone: string; word: string }> = {
		connected: { glyph: 'ok', tone: 'text-success', word: 'Connected' },
		unreachable: { glyph: 'err', tone: 'text-error', word: 'Unreachable' },
		unknown: { glyph: 'unknown', tone: 'text-text-subtle', word: 'Not connected' }
	};
	const state = $derived(connection[clusters.connectionState]);

	async function copyServer(server: string) {
		try {
			await navigator.clipboard.writeText(server);
			toasts.push('Server address copied');
		} catch {
			toasts.push('Could not copy the server address', 'err');
		}
	}

	const chip =
		'focus-ring flex h-(--chip-h) shrink-0 items-center gap-2 rounded-full bg-surface-container-high px-4 hover:brightness-110';
	const menuItem =
		'flex cursor-default items-center gap-3 rounded-md px-3 py-2 type-body text-text-muted data-highlighted:bg-surface-container-high data-highlighted:text-text';
</script>

<!-- The mousedown handler only begins a window drag — not an
     interactive control, so no ARIA role applies. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<header data-tauri-drag-region onmousedown={beginWindowDrag} class="flex shrink-0 flex-wrap items-center gap-2">
	{#if activeContext}
		<DropdownMenu.Root>
			<!-- The chip keeps its cluster's tint even where the window does not (dashboard). -->
			<DropdownMenu.Trigger class="{chip} min-w-0" data-tint style={tintStyle(identity)}>
				<span class="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-primary" data-testid="identity-dot"></span>
				<span class="type-body truncate font-semibold text-text">{activeContext.name}</span>
				{#if provider}
					<span class="type-micro rounded-xs bg-primary-container px-1.5 py-px font-mono text-on-primary-container">
						{provider}
					</span>
				{/if}
				{#if version}
					<span class="type-data-sm text-text-subtle">{version}</span>
				{/if}
				<span class="flex items-center gap-1.5 {state.tone}" data-testid="connection-state">
					<StatusGlyph state={state.glyph} size={8} />
					<span class="type-body-sm text-text-muted">{state.word}</span>
				</span>
				<ChevronDown class="h-3.5 w-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="start"
					sideOffset={6}
					class="animate-popin z-50 max-w-[90vw] min-w-64 rounded-lg bg-surface-overlay p-1.5 shadow-overlay"
				>
					{#if server}
						<div class="px-3 pt-1.5 pb-2">
							<div class="type-label">Server</div>
							<div class="type-data-sm break-all text-text select-all">{server}</div>
						</div>
						<DropdownMenu.Item class={menuItem} onSelect={() => void copyServer(server)}>
							Copy server address
						</DropdownMenu.Item>
					{/if}
					<DropdownMenu.Item class={menuItem} onSelect={() => void clusters.retry()}>
						Reconnect
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	{/if}

	<NamespaceDropdown />

	<div class="h-(--chip-h) min-w-4 flex-1" data-tauri-drag-region></div>

	{#if warningCount > 0}
		<button
			type="button"
			class="focus-ring type-body flex h-(--chip-h) shrink-0 items-center gap-2 rounded-full bg-warning-container px-4 font-semibold text-on-warning-container hover:brightness-110"
			onclick={() => app.navigate('events')}
		>
			<StatusGlyph state="warn" />
			{warningCount} warning{warningCount === 1 ? '' : 's'}
		</button>
	{/if}

	<button type="button" class="{chip} w-60 text-left" onclick={() => (app.paletteOpen = true)}>
		<Search class="h-4 w-4 shrink-0 text-text-subtle" aria-hidden="true" />
		<span class="type-body-sm flex-1 text-text-subtle">Search &amp; switch…</span>
		<Kbd label="{modLabel}K" />
	</button>
</header>
