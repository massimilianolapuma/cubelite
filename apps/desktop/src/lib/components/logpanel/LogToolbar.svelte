<script lang="ts">
	import { untrack } from 'svelte';
	import ArrowUpToLine from '@lucide/svelte/icons/arrow-up-to-line';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ListFilter from '@lucide/svelte/icons/list-filter';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
	import { ecsNdjson, type LogViewMode } from '#lib/log-ecs.ts';
	import { elastic } from '#lib/stores/elastic.svelte.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { canOpenKibana, kibanaBase, toastErrors } from '#lib/integration-links.ts';
	import { openKibanaDiscover } from '#lib/tauri.ts';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
	import FollowChip from './FollowChip.svelte';
	import {
		TOOLBAR_CHIP,
		TOOLBAR_CHIP_REST,
		TOOLBAR_FIELD_FLEX,
		TOOLBAR_ICON,
		TOOLBAR_MENU,
		TOOLBAR_MENU_ITEM,
		TOOLBAR_SELECT
	} from '#lib/ui-classes.ts';
	import HistoryControls from './HistoryControls.svelte';
	import LogSourceSwitch from './LogSourceSwitch.svelte';
	import Check from '@lucide/svelte/icons/check';
	import { logPanel } from '#lib/stores/logPanel.svelte.ts';
	import { logWindows } from '#lib/stores/logWindows.svelte.ts';
	import { ALL_CONTAINERS, type LogSession } from '#lib/stores/logSession.svelte.ts';
	import { exportLog } from '#lib/tauri.ts';
	import { toasts } from '#lib/stores/toasts.svelte.ts';
	import { errorMessage } from '#lib/errors.ts';
	import type { KeyedLogLine } from '#lib/stores/logs.svelte.ts';

	let { session, detached = false }: { session: LogSession; detached?: boolean } = $props();

	let pickerOpen = $state(false);
	let overflowOpen = $state(false);
	let searchInput = $state<HTMLInputElement | null>(null);

	const TAIL_PRESETS = [100, 500, 1000, 5000];
	// "Load 500 earlier" raises the tail past the presets: list the current
	// size too, so the select never shows a blank.
	const tailOptions = $derived(
		TAIL_PRESETS.includes(session.tailLines)
			? TAIL_PRESETS
			: [...TAIL_PRESETS, session.tailLines].sort((a, b) => a - b)
	);

	const selected = $derived(session.containers.find((c) => c.name === session.container) ?? null);
	const mains = $derived(session.containers.filter((c) => !c.init));
	const inits = $derived(session.containers.filter((c) => c.init));

	function pick(name: string) {
		pickerOpen = false;
		logPanel.rememberContainer(session.key, name);
		const changed = session.container !== name;
		void session.switchContainer(name).finally(() => {
			// History follows the container picker (#501), even if the live
			// stream fails to restart.
			if (changed && session.history.started) void session.history.reload();
		});
	}

	// Elasticsearch history is offered when the cluster has an endpoint (#501).
	const endpoint = $derived(elastic.endpointFor(app.activeCluster));
	$effect(() => {
		if (!endpoint && session.source === 'history') session.setSource('live');
	});

	const canOpen = $derived(canOpenKibana(endpoint));

	async function openKibana() {
		overflowOpen = false;
		const ep = endpoint;
		if (!ep) return;
		await toastErrors(async () => {
			const kibanaUrl = await kibanaBase(ep);
			if (!kibanaUrl) return;
			await openKibanaDiscover({
				kibanaUrl,
				preset: ep.preset,
				namespace: session.namespace,
				pod: session.pod,
				container: session.merged ? null : session.container,
				from: session.source === 'history' ? session.history.range : 'now-1h',
				to: 'now',
				clusterFilter: ep.clusterFilter ?? null
			});
		});
	}

	// The panel keeps one `LogSearch` for its active session; re-run the
	// match scan whenever the buffer grows so results follow the live tail.
	// `recompute()` reads `search.query`/`search.cursor` internally, so the
	// call is wrapped `untrack`ed — otherwise this effect would also fire on
	// every keystroke/cursor move, defeating `setQuery`'s own debounce.
	$effect(() => {
		// Identity too: a history reload can return as many lines with new ids.
		void session.lines;
		void session.lines.length;
		untrack(() => logPanel.search.recompute(session.lines));
	});

	$effect(() => {
		logPanel.registerSearchFocus(() => searchInput?.focus());
		return () => logPanel.registerSearchFocus(null);
	});

	function exportFilename(full: boolean): string {
		const container = session.merged ? 'all' : (session.container ?? 'unknown');
		const ext = logPanel.viewMode === 'ecs' ? 'ndjson' : 'log';
		return `${session.pod}_${container}${full ? '_full' : ''}.${ext}`;
	}

	async function doExport(lines: KeyedLogLine[], full: boolean) {
		overflowOpen = false;
		const filename = exportFilename(full);
		// ECS mode exports one ECS document per line (NDJSON, #492).
		const contents =
			logPanel.viewMode === 'ecs'
				? ecsNdjson(lines, session.merged ? null : session.container)
				: logPanel.serialize(lines);
		try {
			const path = await exportLog(filename, contents);
			toasts.push(`Exported to ${path}`, 'ok');
		} catch (e) {
			toasts.push(errorMessage(e), 'err');
		}
	}

	// Mirrors LogBody's rendered-set derivation: all lines, or only search
	// matches when filter mode is on.
	function exportVisible() {
		const lines = logPanel.search.filterMode
			? session.lines.filter((l) => logPanel.search.matchSet.has(l.id))
			: session.lines;
		void doExport(lines, false);
	}

	function exportFull() {
		void doExport(session.lines, true);
	}

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			if (event.shiftKey) logPanel.search.prev();
			else logPanel.search.next();
			event.preventDefault();
		} else if (event.key === 'Escape') {
			event.stopPropagation();
			if (logPanel.search.query) logPanel.search.clear();
			else (event.currentTarget as HTMLInputElement).blur();
		}
	}

	const VIEW_MODES: { value: LogViewMode; label: string }[] = [
		{ value: 'raw', label: 'Raw' },
		{ value: 'json', label: 'JSON' },
		{ value: 'ecs', label: 'ECS' }
	];
</script>

<!-- Toolbar of chips and pill fields on the card (Tonal §8.5). One row from the
     default window down to 1280 px: words of chips give way to their icons as the
     row narrows (they stay in the accessible names), the search field takes what is
     left. Below that it wraps, at most in two rows at 800 px; a horizontal scroller
     would clip the menus that open upwards. Nothing moves into a menu. -->
<div class="@container shrink-0 px-3 py-1.5">
<div class="flex flex-wrap items-center gap-1" data-testid="log-toolbar">
	<!-- container picker -->
	<div class="relative min-w-0">
		<button
			type="button"
			class="{TOOLBAR_CHIP_REST} type-data-sm max-w-40"
			aria-expanded={pickerOpen}
			onclick={() => (pickerOpen = !pickerOpen)}
		>
			<span class="truncate">{session.merged ? 'all containers' : (session.container ?? '…')}</span>
			<ChevronDown class="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
		</button>
		{#if pickerOpen}
			<div class="{TOOLBAR_MENU} left-0 w-max max-w-[80vw] min-w-64">
				{#each mains as c (c.name)}
					<button type="button" class={TOOLBAR_MENU_ITEM} onclick={() => pick(c.name)}>
						<span class="type-data-sm min-w-0 flex-1 truncate">{c.name}</span>
						<span class="type-body-sm flex shrink-0 items-center gap-1 text-text-muted">
							{c.state}
							{#if c.restarts > 0}
								<span aria-hidden="true">·</span>
								<RotateCcw class="h-3 w-3" aria-label="restarts" />{c.restarts}
							{/if}
						</span>
					</button>
				{/each}
				{#if inits.length > 0}
					<div class="mx-3 my-1 border-t border-outline"></div>
					{#each inits as c (c.name)}
						<button type="button" class={TOOLBAR_MENU_ITEM} onclick={() => pick(c.name)}>
							<span class="type-data-sm min-w-0 flex-1 truncate text-text-muted">{c.name}</span>
							<span class="type-body-sm shrink-0 text-text-muted">init</span>
						</button>
					{/each}
				{/if}
				<div class="mx-3 my-1 border-t border-outline"></div>
				<button type="button" class={TOOLBAR_MENU_ITEM} onclick={() => pick(ALL_CONTAINERS)}>
					<span class="type-data-sm min-w-0 flex-1 whitespace-nowrap">all containers</span>
					<span class="type-body-sm shrink-0 text-text-muted">merged stream, color-tagged</span>
				</button>
			</div>
		{/if}
	</div>

	<!-- previous-instance chip: only when not merged and the selected container has restarts -->
	{#if session.source === 'live' && !session.merged && (selected?.restarts ?? 0) > 0}
		<button
			type="button"
			class="{TOOLBAR_CHIP} {session.previous
				? 'bg-primary-container font-semibold text-on-primary-container'
				: 'bg-surface-container-high text-text-muted hover:brightness-110'}"
			title="Previous instance"
			aria-pressed={session.previous}
			onclick={() => void session.setPrevious(!session.previous)}
		>
			<RotateCcw class="h-3.5 w-3.5" aria-hidden="true" /><span class="@max-[72rem]:sr-only">prev</span>
		</button>
	{/if}

	<!-- live stream or Elasticsearch history (#501) -->
	<LogSourceSwitch value={session.source} onChange={(v) => session.setSource(v)} setup={!detached} dense />

	<!-- search: takes the room the row has left -->
	<input
		bind:this={searchInput}
		type="text"
		placeholder="Search… (⌘F)"
		value={logPanel.search.query}
		oninput={(e) => logPanel.search.setQuery(e.currentTarget.value)}
		onkeydown={onSearchKeydown}
		class={TOOLBAR_FIELD_FLEX}
	/>
	{#if logPanel.search.query}
		<span class="type-data-sm shrink-0 text-text-muted">
			{logPanel.search.count === 0
				? '0 results'
				: `${logPanel.search.cursor + 1}/${logPanel.search.count}`}
		</span>
		<button
			type="button"
			aria-pressed={logPanel.search.filterMode}
			title="Show only matching lines"
			class="{TOOLBAR_CHIP} {logPanel.search.filterMode
				? 'bg-primary-container font-semibold text-on-primary-container'
				: 'bg-surface-container-high text-text-muted hover:brightness-110'}"
			onclick={() => (logPanel.search.filterMode = !logPanel.search.filterMode)}
		>
			<ListFilter class="h-3.5 w-3.5" aria-hidden="true" /><span class="@max-[72rem]:sr-only">filter</span>
		</button>
	{/if}

	{#if session.source === 'history'}
		<HistoryControls history={session.history} />
	{:else}
		<!-- tail size: a pill select keeps the toolbar on one row where it fits -->
		<select
			aria-label="Tail lines"
			class={TOOLBAR_SELECT}
			value={String(session.tailLines)}
			onchange={(e) => void session.setTail(Number(e.currentTarget.value))}
		>
			{#each tailOptions as n (n)}
				<option value={String(n)}>{n} lines</option>
			{/each}
		</select>
		<button
			type="button"
			class={TOOLBAR_ICON}
			aria-label="Load 500 earlier"
			title="Load 500 earlier"
			onclick={() => void session.loadEarlier()}
		>
			<ArrowUpToLine class="h-4 w-4" aria-hidden="true" />
		</button>

		<FollowChip following={session.following} onToggle={() => session.toggleFollow()} />
	{/if}

	<!-- view mode: raw / JSON / ECS (#492); a pill select where three segments do not fit -->
	<span
		class="hidden @min-[44rem]:inline-flex"
		data-testid="logpanel-view-mode"
		title="Log view: raw text, humanised JSON or Elastic Common Schema"
	>
		<SegmentedControl segments={VIEW_MODES} bind:value={logPanel.viewMode} label="Log view" dense />
	</span>
	<select
		aria-label="Log view"
		title="Log view: raw text, humanised JSON or Elastic Common Schema"
		class="{TOOLBAR_SELECT} @min-[44rem]:hidden"
		bind:value={logPanel.viewMode}
	>
		{#each VIEW_MODES as mode (mode.value)}
			<option value={mode.value}>{mode.label}</option>
		{/each}
	</select>

	<!-- pop out to separate window -->
	{#if !detached}
		<button
			type="button"
			class={TOOLBAR_ICON}
			title="Open this session in a separate window"
			aria-label="Pop out log session"
			data-testid="logpanel-detach"
			onclick={() => void logWindows.detach(session.key)}
		>
			<SquareArrowOutUpRight class="h-4 w-4" aria-hidden="true" />
		</button>
	{/if}

	<!-- overflow -->
	<div class="relative">
		<button
			type="button"
			class={TOOLBAR_ICON}
			aria-label="More log options"
			aria-expanded={overflowOpen}
			onclick={() => (overflowOpen = !overflowOpen)}
		>
			<Ellipsis class="h-4 w-4" aria-hidden="true" />
		</button>
		{#if overflowOpen}
			<div class="{TOOLBAR_MENU} right-0 min-w-52">
				<button
					type="button"
					role="menuitemcheckbox"
					aria-checked={logPanel.timestamps}
					class={TOOLBAR_MENU_ITEM}
					onclick={() => {
						logPanel.timestamps = !logPanel.timestamps;
						overflowOpen = false;
					}}
				>
					<Check class="h-4 w-4 {logPanel.timestamps ? '' : 'invisible'}" aria-hidden="true" />Timestamps
				</button>
				<button
					type="button"
					role="menuitemcheckbox"
					aria-checked={logPanel.wrap}
					class={TOOLBAR_MENU_ITEM}
					onclick={() => {
						logPanel.wrap = !logPanel.wrap;
						overflowOpen = false;
					}}
				>
					<Check class="h-4 w-4 {logPanel.wrap ? '' : 'invisible'}" aria-hidden="true" />Wrap lines
				</button>
				{#if canOpen}
					<div class="mx-3 my-1 border-t border-outline"></div>
					<button type="button" class={TOOLBAR_MENU_ITEM} onclick={() => void openKibana()}>
						Open in Kibana
					</button>
				{/if}
				<div class="mx-3 my-1 border-t border-outline"></div>
				<button type="button" class={TOOLBAR_MENU_ITEM} onclick={exportVisible}>Export visible…</button>
				<button type="button" class={TOOLBAR_MENU_ITEM} onclick={exportFull}>Export full buffer…</button>
				<div class="mx-3 my-1 border-t border-outline"></div>
				<button
					type="button"
					class={TOOLBAR_MENU_ITEM}
					onclick={() => {
						session.clear();
						overflowOpen = false;
					}}
				>
					Clear buffer
				</button>
			</div>
		{/if}
	</div>
</div>
</div>
