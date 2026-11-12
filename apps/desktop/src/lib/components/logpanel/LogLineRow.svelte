<script lang="ts">
	import type { KeyedLogLine } from '#lib/stores/logs.svelte.ts';
	import type { LogLevel } from '#lib/tauri.ts';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { parseJsonLine } from '#lib/log-json.ts';
	import { ecsRow, toEcs, type LogViewMode } from '#lib/log-ecs.ts';
	import JsonTree from './JsonTree.svelte';
	import EcsFieldTable from './EcsFieldTable.svelte';
	import { sourceClass } from '#lib/log-sources.ts';

	let {
		line,
		timestamps,
		wrap,
		search = null,
		source = null,
		mode = 'raw',
		container = null,
		expanded = false,
		ontoggle
	}: {
		line: KeyedLogLine;
		timestamps: boolean;
		wrap: boolean;
		search?: { query: string; active: boolean } | null;
		/**
		 * Where the line came from. `index` numbers the sources of a merged stream
		 * (their colour); `null` leaves it neutral. `wide` widens the column for
		 * pod names (aggregated Logs view).
		 */
		source?: { name: string; index: number | null; wide?: boolean } | null;
		/** Raw, JSON (#454) or ECS (#492) rendering. */
		mode?: LogViewMode;
		/** Container for the ECS `container.name` when the line carries no tag. */
		container?: string | null;
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
	// History lines carry the stored Elasticsearch document: JSON and ECS
	// modes render it rather than the plain message (#501).
	const structured = $derived(line.document ?? line.message);
	const view = $derived(mode === 'json' ? parseJsonLine(structured) : null);
	const ecs = $derived(mode === 'ecs' ? toEcs({ ...line, message: structured }, container) : null);
	const ecsSummary = $derived(ecs ? ecsRow(ecs) : null);
	const shownLevel = $derived(ecs?.level ?? view?.level ?? line.level);

	// Tonal §8.5: the level is a word in its own column; INFO is neutral, WARN
	// and ERROR rows get a faint wash of their container. Written in full so
	// Tailwind emits every class.
	const LEVEL_TONE: Record<LogLevel, string> = {
		debug: 'text-text-muted',
		info: 'text-text-muted',
		warn: 'text-warning',
		error: 'text-error'
	};
	const ROW_WASH: Record<LogLevel, string> = {
		debug: '',
		info: '',
		warn: 'bg-warning-container/35',
		error: 'bg-error-container/35'
	};

	// A match is marked by more than its fill, which barely differs from a washed
	// WARN or ERROR row in the light theme: an underline in the warning colour. The
	// match the cursor is on is boxed by a ring and set in a heavier weight.
	const MARK_FILL = 'bg-warning-container text-on-warning-container';
	const MARK = `${MARK_FILL} underline decoration-warning decoration-2 underline-offset-2`;
	const MARK_ACTIVE = `${MARK_FILL} font-semibold outline-2 outline-warning`;

	const tone = $derived(source ? (source.index === null ? 'text-text-muted' : sourceClass(source.index)) : '');

	function clock(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour12: false });
	}
</script>

{#snippet gutter()}
	{#if timestamps}
		<span class="w-16 shrink-0 whitespace-nowrap text-text-muted">{clock(line.time)}</span>
	{/if}
	{#if source}
		<span
			class="{source.wide ? 'w-36' : 'w-20'} shrink-0 truncate font-semibold {tone}"
			data-source={source.index === null ? undefined : source.index + 1}
			title={source.name}>{source.name}</span
		>
	{/if}
	<span class="w-12 shrink-0 font-semibold uppercase {LEVEL_TONE[shownLevel]}" data-level-word>
		{shownLevel}
	</span>
{/snippet}

{#snippet marks(segs: { text: string; hit: boolean }[])}
	{#each segs as seg, i (i)}
		{#if seg.hit}<mark class={search?.active ? MARK_ACTIVE : MARK} data-active={search?.active ? 'true' : 'false'}
				>{seg.text}</mark
			>{:else}{seg.text}{/if}
	{/each}
{/snippet}

{#snippet tail(items: { key: string; value: string }[])}
	{#each items as item, n (item.key)}
		<span class="whitespace-pre">{n === 0 ? ' ' : '  '}</span><span
			><span class="text-text-muted">{item.key}</span>=<span class="text-text">{@render marks(segmentsOf(item.value))}</span
			></span
		>
	{/each}
{/snippet}

<div class="type-log {ROW_WASH[shownLevel]}" data-level={shownLevel}>
	{#if ecs && ecsSummary}
		<div class="flex items-baseline gap-3 px-3 py-px">
			{@render gutter()}
			<button
				type="button"
				aria-expanded={expanded}
				data-testid="ecs-row"
				class="focus-ring-inset min-w-0 cursor-pointer rounded-xs text-left text-text {wrap
					? 'break-all whitespace-pre-wrap'
					: 'whitespace-pre'}"
				onclick={() => ontoggle?.()}
			>
				<ChevronRight size={10} class="inline-block align-baseline text-text-muted {expanded ? 'rotate-90' : ''}" />
				{#if ecsSummary.service}<span
						data-testid="ecs-service"
						class="mr-1.5 rounded-full bg-surface-container-high px-1.5 text-text-muted"
						>{ecsSummary.service}</span
					>{/if}{@render marks(segmentsOf(ecsSummary.message))}{@render tail(ecsSummary.tail)}
			</button>
		</div>
		{#if expanded}
			<div class="px-3 pt-1 pb-2">
				<div class="rounded-md bg-surface-container px-3 py-2">
					<EcsFieldTable doc={ecs} raw={structured} />
				</div>
			</div>
		{/if}
	{:else if view}
		<div class="flex items-baseline gap-3 px-3 py-px">
			{@render gutter()}
			<button
				type="button"
				aria-expanded={expanded}
				data-testid="json-row"
				class="focus-ring-inset min-w-0 cursor-pointer rounded-xs text-left text-text {wrap
					? 'break-all whitespace-pre-wrap'
					: 'whitespace-pre'}"
				onclick={() => ontoggle?.()}
			>
				<ChevronRight size={10} class="inline-block align-baseline text-text-muted {expanded ? 'rotate-90' : ''}" />
				{@render marks(segmentsOf(view.message))}{@render tail(view.tail)}
			</button>
		</div>
		{#if expanded}
			<div class="px-3 pt-1 pb-2">
				<div class="rounded-md bg-surface-container px-3 py-2">
					<JsonTree value={view.object} raw={structured} />
				</div>
			</div>
		{/if}
	{:else}
		<div class="flex items-baseline gap-3 px-3 py-px">
			{@render gutter()}
			<span class="text-text {wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'}"
				>{@render marks(segments)}</span
			>
		</div>
	{/if}
</div>
