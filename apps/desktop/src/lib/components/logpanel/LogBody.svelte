<script lang="ts">
	import { get } from 'svelte/store';
	import { createVirtualizer, type SvelteVirtualizer } from '@tanstack/svelte-virtual';
	import LogLineRow from './LogLineRow.svelte';
	import { logPanel } from '$lib/stores/logPanel.svelte';
	import type { LogSession } from '$lib/stores/logSession.svelte';

	let { session }: { session: LogSession } = $props();

	let scrollEl = $state<HTMLDivElement | null>(null);

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
	// Reads `session.ring.lines.length` / `scrollEl` (tracked deps) but takes
	// the virtualizer instance via `get()` rather than `$virtualizer` —
	// `setOptions()` unconditionally re-emits the store, so subscribing to it
	// here (`$virtualizer`) would re-run this same effect on every call and
	// blow the update-depth limit.
	$effect(() => {
		void session.ring.lines.length;
		void scrollEl;
		const v = get(virtualizer);
		v.setOptions({
			count: session.ring.lines.length,
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
		void session.ring.lines.length;
		if (session.following && scrollEl) {
			get(virtualizer).scrollToIndex(session.ring.lines.length - 1, { align: 'end' });
		}
	});

	function onWheel(event: WheelEvent) {
		if (event.deltaY < 0 && session.following) {
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

<div class="relative min-h-0 flex-1 overflow-hidden bg-surface-sunken">
	{#if !session.following && newLines > 0}
		<div class="pointer-events-auto absolute inset-x-0 bottom-2 z-10 flex justify-center">
			<button
				type="button"
				class="type-caption rounded-full px-2.5 py-1"
				style="background: var(--alpha-pill-warn); color: var(--color-status-warn);"
				onclick={resume}
			>
				↓ {newLines} new {newLines === 1 ? 'line' : 'lines'}
			</button>
		</div>
	{/if}

	{#if session.status === 'error'}
		<div class="flex h-full flex-col items-center justify-center gap-2">
			<p class="type-caption text-text-secondary">{session.error}</p>
			<button
				type="button"
				class="focus-ring type-caption rounded-md border border-border-default bg-surface-raised px-2.5 py-1 text-text-secondary hover:brightness-110"
				onclick={() => void session.open()}
			>
				Retry
			</button>
		</div>
	{:else if session.ring.lines.length === 0}
		<p class="py-8 text-center text-xs text-text-disabled">
			{session.ring.totalAppended > 0
				? 'Buffer cleared — waiting for new lines…'
				: 'Waiting for log lines…'}
		</p>
	{:else}
		<div bind:this={scrollEl} onwheel={onWheel} class="h-full overflow-y-auto py-1">
			<div style="height: {$virtualizer.getTotalSize()}px; position: relative;">
				{#each $virtualizer.getVirtualItems() as item (item.key)}
					{@const line = session.ring.lines[item.index]}
					<div
						data-index={item.index}
						use:measure={$virtualizer}
						style="position: absolute; top: 0; left: 0; width: 100%; transform: translateY({item.start}px);"
					>
						<LogLineRow {line} timestamps={logPanel.timestamps} wrap={logPanel.wrap} />
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
