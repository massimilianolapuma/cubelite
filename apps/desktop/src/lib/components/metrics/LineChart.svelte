<script lang="ts">
	import { EMPTY } from '#lib/empty.ts';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import {
		formatTime,
		formatValue,
		linePath,
		maxValue,
		nearestIndex,
		niceMax,
		type ChartLine,
		type Unit
	} from '#lib/metrics.ts';
	import StatusGlyph from '#lib/components/ui/StatusGlyph.svelte';
	import type { MetricsRange } from '#lib/tauri.ts';
	import { PANEL_CARD } from '#lib/ui-classes.ts';

	// One Metrics chart (#510): lines over the range, dashed reference lines
	// (requests, limits), a hover crosshair with every line's value.
	let {
		title,
		summary,
		unit,
		lines,
		start,
		end,
		range,
		error,
		emptyText,
		note,
		onGrafana
	}: {
		title: string;
		summary: string;
		unit: Unit;
		lines: ChartLine[];
		start: number;
		end: number;
		range: MetricsRange;
		error: string | null;
		emptyText: string;
		/** Small text after the title (the exporter of a node chart, #530). */
		note?: string | null;
		onGrafana?: () => void;
	} = $props();

	const WIDTH = 300;
	const HEIGHT = 64;
	const yMax = $derived(niceMax(maxValue(lines) * 1.05));
	const box = $derived({ start, end, yMax, width: WIDTH, height: HEIGHT });
	const hasData = $derived(lines.some((l) => l.points.some(([, v]) => v !== null)));

	let hoverT = $state<number | null>(null);
	const hover = $derived.by(() => {
		if (hoverT === null) return null;
		const t = hoverT;
		const values = lines
			.map((l) => {
				const i = nearestIndex(l.points, t);
				return i < 0 ? null : { line: l, value: l.points[i][1] };
			})
			.filter((v): v is { line: ChartLine; value: number | null } => v !== null);
		return { t, x: ((t - start) / (end - start || 1)) * WIDTH, values };
	});

	// Reference lines (requests, limits) are short dashes; a series that repeats a colour has its own pattern.
	const dashOf = (line: ChartLine) => (line.dashed ? '3 3' : line.dash);

	function move(event: PointerEvent) {
		const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
		if (rect.width === 0) return;
		const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
		hoverT = start + ratio * (end - start);
	}
</script>

{#snippet swatch(line: ChartLine)}
	<!-- The legend draws each line as the chart does: a dashed line has a dashed key. -->
	<svg width="14" height="4" viewBox="0 0 14 4" aria-hidden="true" class="shrink-0">
		<line x1="0" y1="2" x2="14" y2="2" stroke={line.color} stroke-width="2" stroke-dasharray={dashOf(line)} />
	</svg>
{/snippet}

<div class="{PANEL_CARD} px-3 py-2.5" data-testid="metrics-chart">
	<div class="mb-1.5 flex items-baseline gap-2">
		<span class="type-label text-text-muted">{title}</span>
		{#if note}
			<span class="type-micro text-text-subtle">{note}</span>
		{/if}
		{#if onGrafana}
			<button
				type="button"
				class="focus-ring rounded-xs text-text-muted hover:text-text"
				aria-label="Open {title} in Grafana"
				title="Open in Grafana"
				onclick={onGrafana}
			>
				<ExternalLink class="h-3 w-3" aria-hidden="true" />
			</button>
		{/if}
		<span class="type-data-sm ml-auto truncate text-text">{summary}</span>
	</div>
	{#if error}
		<p class="type-body-sm flex items-start gap-1.5 text-text" role="alert">
			<StatusGlyph state="err" class="mt-1 text-error" />
			{error}
		</p>
	{:else if !hasData}
		<p class="type-body-sm text-text-muted">{emptyText}</p>
	{:else}
		<svg
			class="block h-16 w-full touch-none"
			viewBox="0 0 {WIDTH} {HEIGHT}"
			preserveAspectRatio="none"
			role="img"
			aria-label="{title}: {summary}"
			onpointermove={move}
			onpointerleave={() => (hoverT = null)}
		>
			<line data-chart-guide x1="0" y1={HEIGHT} x2={WIDTH} y2={HEIGHT} stroke="var(--color-outline)" vector-effect="non-scaling-stroke" />
			{#each lines as line (line.label + (line.dashed ? '-ref' : ''))}
				<path
					d={linePath(line.points, box)}
					fill="none"
					stroke={line.color}
					stroke-width="1.5"
					stroke-dasharray={dashOf(line)}
					vector-effect="non-scaling-stroke"
				/>
			{/each}
			{#if hover}
				<line data-chart-guide x1={hover.x} y1="0" x2={hover.x} y2={HEIGHT} stroke="var(--color-outline-strong)" vector-effect="non-scaling-stroke" />
			{/if}
		</svg>
		<!-- Legend and hover values are in the text colour: the key carries the line's colour.
		     Hovering adds each line's value to its legend entry, so the chart keeps its height. -->
		<div class="mt-1 flex min-h-4 flex-wrap items-center gap-x-3 gap-y-0.5">
			{#each lines as line (line.label + (line.dashed ? '-ref' : ''))}
				{@const at = hover?.values.find((v) => v.line === line)}
				<span class="type-micro flex items-center gap-1 {at ? 'font-mono text-text' : 'text-text-muted'}">
					{@render swatch(line)}
					{line.label || title}{#if at}&nbsp;{at.value === null ? EMPTY : formatValue(at.value, unit)}{/if}
				</span>
			{/each}
			<span class="type-micro ml-auto font-mono text-text-subtle">
				{hover ? formatTime(hover.t, range) : `max ${formatValue(yMax, unit)}`}
			</span>
		</div>
	{/if}
</div>
