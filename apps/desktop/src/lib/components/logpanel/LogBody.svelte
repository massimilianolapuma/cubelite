<script lang="ts">
	import { get } from 'svelte/store';
	import { untrack } from 'svelte';
	import { createVirtualizer, type SvelteVirtualizer } from '@tanstack/svelte-virtual';
	import LogLineRow from './LogLineRow.svelte';
	import HistoryStrip from './HistoryStrip.svelte';
	import { logPanel } from '#lib/stores/logPanel.svelte.ts';
	import type { LogSession } from '#lib/stores/logSession.svelte.ts';
	import { sourceIndex } from '#lib/log-sources.ts';
	import Button from '#lib/components/ui/Button.svelte';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';

	let { session }: { session: LogSession } = $props();

	let scrollEl = $state<HTMLDivElement | null>(null);

	let now = $state(Date.now());
	$effect(() => {
		if (session.status !== 'reconnecting') return;
		// Reset immediately: `now` may be stale by up to a full stream's
		// lifetime since mount, which would flash a huge countdown for up to
		// 1s until the first tick below corrects it.
		now = Date.now();
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});
	const retryIn = $derived(
		session.nextRetryAt ? Math.max(0, Math.ceil((session.nextRetryAt - now) / 1000)) : 0
	);

	// The rendered set: all lines, or only search matches when filter mode
	// is on. The virtualizer's index space always tracks this array, not
	// the raw ring buffer, so `scrollToIndex` stays in bounds either way.
	const lines = $derived(
		logPanel.search.filterMode
			? session.lines.filter((l) => logPanel.search.matchSet.has(l.id))
			: session.lines
	);

	const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => scrollEl,
		estimateSize: () => 18,
		overscan: 20
	});

	// Keep the virtualizer's item count (and scroll-element reference) in
	// sync with the reactive buffer — the scroller only mounts once there
	// are lines, so this also re-binds the virtualizer to the real element
	// the first time it appears.
	//
	// Reads `lines.length` / `scrollEl` (tracked deps) but takes
	// the virtualizer instance via `get()` rather than `$virtualizer` —
	// `setOptions()` unconditionally re-emits the store, so subscribing to it
	// here (`$virtualizer`) would re-run this same effect on every call and
	// blow the update-depth limit.
	$effect(() => {
		void lines.length;
		void scrollEl;
		const v = get(virtualizer);
		v.setOptions({
			count: lines.length,
			getScrollElement: () => scrollEl,
			estimateSize: () => 18,
			overscan: 20
		});
		v.measure();
	});

	const newLines = $derived(session.ring.totalAppended - session.seenCount);

	// Autoscroll to the newest line while following. Same `get()` rationale
	// as above — scrollToIndex() must not be re-triggered by its own scroll.
	$effect(() => {
		void lines.length;
		// History is browsed, not followed: Load older prepends and must keep
		// the user's place (#501).
		if (session.source === 'live' && session.following && scrollEl) {
			get(virtualizer).scrollToIndex(lines.length - 1, { align: 'end' });
		}
	});

	// History: show the newest lines after each (re)load, once.
	$effect(() => {
		void session.history.loads;
		if (session.source !== 'history' || !scrollEl) return;
		const n = untrack(() => lines.length);
		if (n > 0) get(virtualizer).scrollToIndex(n - 1, { align: 'end' });
	});

	// Expanding or collapsing a row while following re-measures it; once it
	// has, scroll to the end again so the newest row's tree stays in view.
	// follow is left untouched.
	$effect(() => {
		void session.expanded.size;
		if (!session.following || !scrollEl) return;
		const raf = requestAnimationFrame(() => {
			const n = untrack(() => lines.length);
			if (n > 0) get(virtualizer).scrollToIndex(n - 1, { align: 'end' });
		});
		return () => cancelAnimationFrame(raf);
	});

	// Jump to the active search match on n/N navigation and pause follow.
	// Depends only on `cursor` (not `activeId`/`matchIds`/`lines`, which are
	// read `untrack`ed) so recomputing matches while typing doesn't yank the
	// view — only an explicit next()/prev() cursor move does.
	$effect(() => {
		void logPanel.search.cursor;
		untrack(() => {
			const id = logPanel.search.activeId;
			if (id === null || !scrollEl) return;
			const idx = lines.findIndex((l) => l.id === id);
			if (idx === -1) return;
			if (session.following) session.toggleFollow();
			get(virtualizer).scrollToIndex(idx, { align: 'center' });
		});
	});

	function onWheel(event: WheelEvent) {
		if (session.source === 'live' && event.deltaY < 0 && session.following) {
			session.toggleFollow();
		}
	}

	function resume() {
		if (!session.following) session.toggleFollow();
	}

	/** Svelte action wiring measureElement for variable row heights (wrap on). */
	function measure(node: HTMLDivElement, v: SvelteVirtualizer<HTMLDivElement, HTMLDivElement>) {
		v.measureElement(node);
		return {
			update(next: SvelteVirtualizer<HTMLDivElement, HTMLDivElement>) {
				next.measureElement(node);
			}
		};
	}
</script>

<!-- Lines in the log type on surface-sunken (Tonal §8.5). The bottom corners
     follow the log panel card, which does not clip: its menus open upwards. -->
<div class="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-xl bg-surface-sunken">
	{#if session.source === 'history'}
		<HistoryStrip history={session.history} />
	{:else if session.status === 'reconnecting'}
		<div
			class="absolute inset-x-3 top-2 z-10 flex items-center justify-center gap-2 rounded-full bg-warning-container px-4 py-1 text-on-warning-container"
			role="status"
		>
			<StatusGlyph state="warn" />
			<span class="type-body-sm">
				Reconnecting — attempt {session.reconnectAttempt} · retrying in {retryIn}s
			</span>
			<button
				type="button"
				class="focus-ring type-body-sm rounded-full px-1 font-semibold underline underline-offset-2"
				onclick={() => session.retryNow()}
			>
				Retry now
			</button>
		</div>
	{/if}

	{#if session.source === 'live' && !session.following && newLines > 0}
		<div class="pointer-events-auto absolute inset-x-0 bottom-2 z-10 flex justify-center">
			<button
				type="button"
				class="focus-ring type-body-sm rounded-full bg-warning-container px-3 py-1 font-semibold text-on-warning-container shadow-overlay hover:brightness-105"
				onclick={resume}
			>
				↓ {newLines} new {newLines === 1 ? 'line' : 'lines'}
			</button>
		</div>
	{/if}

	{#if session.source === 'live' && session.status === 'error'}
		<div class="flex flex-1 flex-col items-center justify-center gap-2 px-4" role="alert">
			<p class="type-body-sm flex items-center gap-2 text-text">
				<StatusGlyph state="err" class="text-error" />{session.error}
			</p>
			<Button variant="tonal" size="inline" onclick={() => void session.open()}>Retry</Button>
		</div>
	{:else if lines.length === 0}
		<p class="type-body-sm py-8 text-center text-text-muted">
			{#if logPanel.search.filterMode && logPanel.search.query}
				No matches for "{logPanel.search.query}" — esc clears search
			{:else if session.source === 'history'}
				{session.history.loading ? 'Loading history…' : session.history.error ? '' : 'No lines in Elasticsearch for this pod and range.'}
			{:else if session.ring.totalAppended > 0}
				Buffer cleared — waiting for new lines…
			{:else}
				Waiting for log lines…
			{/if}
		</p>
	{:else}
		<div bind:this={scrollEl} onwheel={onWheel} class="min-h-0 flex-1 overflow-y-auto py-1">
			<div style="height: {$virtualizer.getTotalSize()}px; position: relative;">
				{#each $virtualizer.getVirtualItems() as item (item.key)}
					{@const line = lines[item.index]}
					<div
						data-index={item.index}
						use:measure={$virtualizer}
						style="position: absolute; top: 0; left: 0; width: 100%; transform: translateY({item.start}px);"
					>
						<LogLineRow
							{line}
							timestamps={logPanel.timestamps}
							wrap={logPanel.wrap}
							search={logPanel.search.query
								? { query: logPanel.search.query, active: line.id === logPanel.search.activeId }
								: null}
							source={session.merged && line.container
								? { name: line.container, index: sourceIndex(session.containers, line.container) }
								: null}
							mode={logPanel.viewMode}
							container={session.merged ? null : session.container}
							expanded={session.expanded.has(line.id)}
							ontoggle={() => session.toggleExpanded(line.id)}
						/>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
