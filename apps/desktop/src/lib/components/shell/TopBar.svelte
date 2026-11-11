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
	import { lists } from '#lib/stores/lists.svelte.ts';
	import { resources } from '#lib/stores/resources.svelte.ts';
	import { toasts } from '#lib/stores/toasts.svelte.ts';
	import { modLabel } from '#lib/platform.ts';
	import { providerOf } from '#lib/provider.ts';
	import { beginWindowDrag } from '#lib/window-drag.ts';
	import { MENU_CONTENT, MENU_ITEM } from '#lib/ui-classes.ts';

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

	// Chips may shrink: a long context name truncates rather than pushing the bar
	// out of the window. What follows the name never shrinks.
	const chip =
		'focus-ring flex h-(--chip-h) min-w-0 items-center gap-2 rounded-full bg-surface-container-high px-4 hover:brightness-110';
</script>

<!-- The mousedown handler only begins a window drag — not an
     interactive control, so no ARIA role applies. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- -mt-3 pt-3: the header owns the gutter above it, so the window drags from its top edge. -->
<!-- One row at any width (@container): below 60rem the search field is its icon and the
     version goes; below 44rem the provider tag and the words beside a glyph go too. What
     is hidden stays in the accessible name. The namespace chip never takes more than a
     quarter of the row (a third once the labels are gone), so a long namespace cannot squeeze the cluster's name away, and
     the cluster chip is the one that gives way to a long context name. -->
<header
	data-tauri-drag-region
	onmousedown={beginWindowDrag}
	class="@container -mt-3 flex min-w-0 shrink-0 items-center gap-2 pt-3"
>
	{#if activeContext}
		<DropdownMenu.Root>
			<!-- The chip keeps its cluster's tint even where the window does not (dashboard). -->
			<DropdownMenu.Trigger class={chip} data-tint style={tintStyle(identity)}>
				<span class="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-primary" data-testid="identity-dot"></span>
				<span class="type-body truncate font-semibold text-text">{activeContext.name}</span>
				{#if provider}
					<span class="type-micro shrink-0 rounded-xs bg-primary-container px-1.5 py-px font-mono text-on-primary-container @max-[44rem]:hidden">
						{provider}
					</span>
				{/if}
				{#if version}
					<span class="type-data-sm shrink-0 text-text-subtle @max-[60rem]:hidden">{version}</span>
				{/if}
				<span class="flex shrink-0 items-center gap-1.5 {state.tone}" data-testid="connection-state">
					<StatusGlyph state={state.glyph} size={8} />
					<span class="type-body-sm text-text-muted @max-[44rem]:sr-only">{state.word}</span>
				</span>
				<ChevronDown class="h-3.5 w-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="start"
					sideOffset={6}
					class="{MENU_CONTENT} max-w-[90vw] min-w-64"
				>
					{#if server}
						<div class="px-3 pt-1.5 pb-2">
							<div class="type-label">Server</div>
							<div class="type-data-sm break-all text-text select-all">{server}</div>
						</div>
						<DropdownMenu.Item class={MENU_ITEM} onSelect={() => void copyServer(server)}>
							Copy server address
						</DropdownMenu.Item>
					{/if}
					<DropdownMenu.Item class={MENU_ITEM} onSelect={() => void clusters.retry()}>
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
			onclick={() => {
				app.navigate('events');
				// The chip counts warnings: show them, whatever was pressed there before.
				lists.setStatus('events', ['warning']);
			}}
		>
			<StatusGlyph state="warn" />
			<span>{warningCount} <span class="@max-[60rem]:sr-only">warning{warningCount === 1 ? '' : 's'}</span></span>
		</button>
	{/if}

	<button
		type="button"
		class="{chip} w-60 shrink-0 text-left @max-[60rem]:w-(--chip-h) @max-[60rem]:justify-center @max-[60rem]:px-0"
		onclick={() => (app.paletteOpen = true)}
	>
		<Search class="h-4 w-4 shrink-0 text-text-subtle" aria-hidden="true" />
		<span class="type-body-sm min-w-0 flex-1 truncate text-text-subtle @max-[60rem]:sr-only">Search &amp; switch…</span>
		<span class="flex shrink-0 @max-[60rem]:hidden"><Kbd label="{modLabel}K" /></span>
	</button>
</header>
