<script lang="ts">
	import { untrack } from 'svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
	import { ecsNdjson, type LogViewMode } from '#lib/log-ecs.ts';
	import { elastic } from '#lib/stores/elastic.svelte.ts';
	import { app } from '#lib/stores/app.svelte.ts';
	import { canOpenKibana, kibanaBase, toastErrors } from '#lib/integration-links.ts';
	import { openKibanaDiscover } from '#lib/tauri.ts';
	import SegmentedControl from '#lib/components/ui/SegmentedControl.svelte';
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

	const TAIL_OPTIONS = [100, 500, 1000, 5000] as const;

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
				to: 'now'
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

<div class="flex h-9 shrink-0 items-center gap-2 border-b border-border-default bg-surface-raised px-2.5">
	<!-- container picker -->
	<div class="relative">
		<button
			type="button"
			class="focus-ring type-caption flex h-7 items-center gap-1.5 rounded-md border border-border-default bg-surface-window px-2.5 font-mono text-text-primary"
			onclick={() => (pickerOpen = !pickerOpen)}
		>
			{session.merged ? 'all containers' : (session.container ?? '…')}
			<ChevronDown size={12} strokeWidth={1.5} />
		</button>
		{#if pickerOpen}
			<div
				class="absolute bottom-full left-0 z-20 mb-1 min-w-56 rounded-md border border-border-strong bg-surface-overlay py-1 shadow-overlay"
			>
				{#each mains as c (c.name)}
					<button
						type="button"
						class="flex w-full items-center gap-2 px-2.5 py-1 text-left hover:bg-surface-raised"
						onclick={() => pick(c.name)}
					>
						<span class="type-caption flex-1 font-mono text-text-primary">{c.name}</span>
						<span class="type-caption flex items-center gap-1 text-text-tertiary">
							{c.state}
							{#if c.restarts > 0}
								<span aria-hidden="true">·</span>
								<RotateCcw size={10} strokeWidth={1.5} aria-label="restarts" />{c.restarts}
							{/if}
						</span>
					</button>
				{/each}
				{#if inits.length > 0}
					<div class="my-1 border-t border-border-default"></div>
					{#each inits as c (c.name)}
						<button
							type="button"
							class="flex w-full items-center gap-2 px-2.5 py-1 text-left hover:bg-surface-raised"
							onclick={() => pick(c.name)}
						>
							<span class="type-caption flex-1 font-mono text-text-secondary">{c.name}</span>
							<span class="type-caption text-text-tertiary">init</span>
						</button>
					{/each}
				{/if}
				<div class="my-1 border-t border-border-default"></div>
				<button
					type="button"
					class="flex w-full items-center gap-2 px-2.5 py-1 text-left hover:bg-surface-raised"
					onclick={() => pick(ALL_CONTAINERS)}
				>
					<span class="type-caption flex-1 font-mono text-text-primary">all containers</span>
					<span class="type-caption text-text-tertiary">merged stream, color-tagged</span>
				</button>
			</div>
		{/if}
	</div>

	<!-- previous-instance chip: only when not merged and the selected container has restarts -->
	{#if session.source === 'live' && !session.merged && (selected?.restarts ?? 0) > 0}
		<button
			type="button"
			class="focus-ring type-caption flex h-7 items-center gap-1 rounded-md px-2 {session.previous
				? 'bg-surface-sunken text-text-primary'
				: 'text-text-tertiary'}"
			title="Previous instance"
			onclick={() => void session.setPrevious(!session.previous)}
		>
			<RotateCcw size={12} strokeWidth={1.5} /> prev
		</button>
	{/if}

	<!-- live stream or Elasticsearch history (#501) -->
	<LogSourceSwitch value={session.source} onChange={(v) => session.setSource(v)} setup={!detached} />

	<span class="flex-1"></span>

	<!-- search -->
	<div class="flex items-center gap-1">
		<input
			bind:this={searchInput}
			type="text"
			placeholder="Search… (⌘F)"
			value={logPanel.search.query}
			oninput={(e) => logPanel.search.setQuery(e.currentTarget.value)}
			onkeydown={onSearchKeydown}
			class="focus-ring h-7 w-44 rounded-md border border-border-default bg-surface-window px-2.5 type-caption text-text-primary placeholder:text-text-disabled"
		/>
		{#if logPanel.search.query}
			<span class="type-caption text-text-tertiary">
				{logPanel.search.count === 0
					? '0 results'
					: `${logPanel.search.cursor + 1}/${logPanel.search.count}`}
			</span>
			<button
				type="button"
				class="type-caption h-7 rounded-md px-2 {logPanel.search.filterMode
					? 'bg-surface-sunken text-text-primary'
					: 'text-text-tertiary'}"
				onclick={() => (logPanel.search.filterMode = !logPanel.search.filterMode)}
			>
				filter
			</button>
		{/if}
	</div>

	{#if session.source === 'history'}
		<HistoryControls history={session.history} />
	{:else}
	<!-- tail size -->
	<div class="flex overflow-hidden rounded-md border border-border-default">
		{#each TAIL_OPTIONS as n (n)}
			<button
				type="button"
				class="type-section h-7 border-r border-border-default px-2 last:border-r-0"
				style={session.tailLines === n
					? 'background: var(--color-text-secondary); color: var(--color-surface-window);'
					: 'color: var(--color-text-tertiary);'}
				onclick={() => void session.setTail(n)}
			>
				{n}
			</button>
		{/each}
	</div>
	<button
		type="button"
		class="focus-ring type-caption h-7 rounded-md px-2 text-text-tertiary hover:text-text-secondary"
		onclick={() => void session.loadEarlier()}
	>
		Load 500 earlier
	</button>

	<!-- follow/pause -->
	<button
		type="button"
		class="type-caption flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium"
		style={session.following
			? 'background: var(--color-status-ok); color: var(--color-surface-window);'
			: 'background: var(--alpha-pill-warn); color: var(--color-status-warn);'}
		onclick={() => session.toggleFollow()}
	>
		{session.following ? '● Following' : '⏸ Paused'}
	</button>
	{/if}

	<!-- view mode: raw / JSON / ECS (#492) -->
	<span data-testid="logpanel-view-mode" title="Log view: raw text, humanised JSON or Elastic Common Schema">
		<SegmentedControl segments={VIEW_MODES} bind:value={logPanel.viewMode} />
	</span>

	<!-- pop out to separate window -->
	{#if !detached}
		<button
			type="button"
			class="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:text-text-secondary"
			title="Open this session in a separate window"
			aria-label="Pop out log session"
			data-testid="logpanel-detach"
			onclick={() => void logWindows.detach(session.key)}
		>
			<SquareArrowOutUpRight size={14} strokeWidth={1.5} />
		</button>
	{/if}

	<!-- overflow -->
	<div class="relative">
		<button
			type="button"
			class="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:text-text-secondary"
			aria-label="More log options"
			onclick={() => (overflowOpen = !overflowOpen)}
		>
			<Ellipsis size={14} strokeWidth={1.5} />
		</button>
		{#if overflowOpen}
			<div
				class="absolute right-0 bottom-full z-20 mb-1 min-w-44 rounded-md border border-border-strong bg-surface-overlay py-1 shadow-overlay"
			>
				<button
					type="button"
					role="menuitemcheckbox"
					aria-checked={logPanel.timestamps}
					class="type-caption flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-text-primary hover:bg-surface-raised"
					onclick={() => {
						logPanel.timestamps = !logPanel.timestamps;
						overflowOpen = false;
					}}
				>
					<Check size={12} strokeWidth={2} class={logPanel.timestamps ? '' : 'invisible'} />Timestamps
				</button>
				<button
					type="button"
					role="menuitemcheckbox"
					aria-checked={logPanel.wrap}
					class="type-caption flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-text-primary hover:bg-surface-raised"
					onclick={() => {
						logPanel.wrap = !logPanel.wrap;
						overflowOpen = false;
					}}
				>
					<Check size={12} strokeWidth={2} class={logPanel.wrap ? '' : 'invisible'} />Wrap lines
				</button>
				{#if canOpen}
					<div class="my-1 border-t border-border-default"></div>
					<button
						type="button"
						class="type-caption block w-full px-2.5 py-1 text-left text-text-primary hover:bg-surface-raised"
						onclick={() => void openKibana()}
					>
						Open in Kibana
					</button>
				{/if}
				<div class="my-1 border-t border-border-default"></div>
				<button
					type="button"
					class="type-caption block w-full px-2.5 py-1 text-left text-text-primary hover:bg-surface-raised"
					onclick={exportVisible}
				>
					Export visible…
				</button>
				<button
					type="button"
					class="type-caption block w-full px-2.5 py-1 text-left text-text-primary hover:bg-surface-raised"
					onclick={exportFull}
				>
					Export full buffer…
				</button>
				<div class="my-1 border-t border-border-default"></div>
				<button
					type="button"
					class="type-caption block w-full px-2.5 py-1 text-left text-text-primary hover:bg-surface-raised"
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
