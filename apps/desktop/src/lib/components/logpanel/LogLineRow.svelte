<script lang="ts">
	import type { KeyedLogLine } from '#lib/stores/logs.svelte.ts';
	import type { LogLevel } from '#lib/tauri.ts';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { parseJsonLine } from '#lib/log-json.ts';
	import JsonTree from './JsonTree.svelte';

	let {
		line,
		timestamps,
		wrap,
		search = null,
		source = null,
		jsonView = false,
		expanded = false,
		ontoggle
	}: {
		line: KeyedLogLine;
		timestamps: boolean;
		wrap: boolean;
		search?: { query: string; active: boolean } | null;
		source?: { name: string; color: string } | null;
		jsonView?: boolean;
		expanded?: boolean;
		ontoggle?: () => void;
	} = $props();

	/** Split `src` into plain / search-hit segments for the active query. */
	function segmentsOf(src: string): { text: string; hit: boolean }[] {
		if (!search || !search.query) return [{ text: src, hit: false }];
		const q = search.query.toLowerCase();
		const out: { text: string; hit: boolean }[] = [];
		let i = 0;
		for (;;) {
			const at = src.toLowerCase().indexOf(q, i);
			if (at === -1) {
				out.push({ text: src.slice(i), hit: false });
				return out;
			}
			if (at > i) out.push({ text: src.slice(i, at), hit: false });
			out.push({ text: src.slice(at, at + q.length), hit: true });
			i = at + q.length;
		}
	}

	const segments = $derived(segmentsOf(line.message));
	const view = $derived(jsonView ? parseJsonLine(line.message) : null);
	const shownLevel = $derived(view?.level ?? line.level);

	const levelColor: Record<LogLevel, string> = {
		debug: 'var(--color-text-tertiary)',
		info: 'var(--color-status-info)',
		warn: 'var(--color-status-warn)',
		error: 'var(--color-status-err)'
	};

	function rowStyle(level: LogLevel): string {
		if (level === 'error')
			return 'border-left: 2px solid var(--color-status-err); background: var(--alpha-log-error-row);';
		if (level === 'warn')
			return 'border-left: 2px solid color-mix(in srgb, var(--color-status-warn) 50%, transparent); background: var(--alpha-log-warn-row);';
		return 'border-left: 2px solid transparent;';
	}

	function clock(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour12: false });
	}
</script>

{#snippet gutter()}
	{#if timestamps}
		<span class="w-[94px] shrink-0 type-micro font-mono text-text-disabled">{clock(line.time)}</span>
	{/if}
	{#if source}
		<span
			class="w-[52px] shrink-0 truncate type-micro font-mono font-semibold"
			style="color: {source.color};">{source.name}</span
		>
	{/if}
	<span
		class="w-[38px] shrink-0 type-micro font-mono font-semibold uppercase"
		style="color: {levelColor[shownLevel]};"
	>
		{shownLevel}
	</span>
{/snippet}

{#snippet marks(segs: { text: string; hit: boolean }[])}
	{#each segs as seg, i (i)}
		{#if seg.hit}<mark
				style={search?.active
					? 'background: var(--color-status-warn); color: var(--color-surface-window);'
					: 'background: var(--alpha-pill-warn); color: inherit;'}>{seg.text}</mark>
		{:else}{seg.text}{/if}
	{/each}
{/snippet}

{#if view}
	<div style={rowStyle(shownLevel)}>
		<div class="flex items-baseline gap-2.5 px-2.5 py-px">
			{@render gutter()}
			<button
				type="button"
				aria-expanded={expanded}
				data-testid="json-row"
				class="focus-ring min-w-0 cursor-pointer text-left type-log text-text-log {wrap
					? 'break-all whitespace-pre-wrap'
					: 'whitespace-pre'}"
				onclick={() => ontoggle?.()}
			>
				<ChevronRight size={10} class="inline-block align-baseline {expanded ? 'rotate-90' : ''}" />
				{@render marks(segmentsOf(view.message))}
				{#each view.tail as item, n (item.key)}
					<span class="whitespace-pre">{n === 0 ? ' ' : '  '}</span><span class="type-micro font-mono"
						><span class="text-text-tertiary">{item.key}</span>=<span class="text-text-secondary"
							>{@render marks(segmentsOf(item.value))}</span
						></span
					>
				{/each}
			</button>
		</div>
		{#if expanded}
			<div class="bg-surface-raised px-2.5 py-1">
				<JsonTree value={view.object} raw={line.message} />
			</div>
		{/if}
	</div>
{:else}
<div class="flex items-baseline gap-2.5 px-2.5 py-px" style={rowStyle(line.level)}>
	{@render gutter()}
	<span class="type-log text-text-log {wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'}">
		{#each segments as seg, i (i)}
			{#if seg.hit}<mark
					style={search?.active
						? 'background: var(--color-status-warn); color: var(--color-surface-window);'
						: 'background: var(--alpha-pill-warn); color: inherit;'}>{seg.text}</mark>
			{:else}{seg.text}{/if}
		{/each}
	</span>
</div>
{/if}
