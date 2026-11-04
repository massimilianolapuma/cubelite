<script lang="ts">
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
	import type { MetricsRange } from '#lib/tauri.ts';

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

	function move(event: PointerEvent) {
		const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
		if (rect.width === 0) return;
		const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
		hoverT = start + ratio * (end - start);
	}
</script>

<div class="rounded-lg border border-border-faint bg-surface-surface px-2.5 py-2" data-testid="metrics-chart">
	<div class="mb-1 flex items-baseline gap-2">
		<span class="type-section text-text-tertiary">{title}</span>
		{#if note}
			<span class="type-micro text-text-disabled">{note}</span>
		{/if}
		{#if onGrafana}
			<button
				type="button"
				class="focus-ring rounded-sm text-text-tertiary hover:text-text-secondary"
				aria-label="Open {title} in Grafana"
				title="Open in Grafana"
				onclick={onGrafana}
			>
				<ExternalLink class="h-3 w-3" />
			</button>
		{/if}
		<span class="type-data-sm ml-auto truncate text-text-secondary">{summary}</span>
	</div>
	{#if error}
		<p class="type-caption text-status-err" role="alert">{error}</p>
	{:else if !hasData}
		<p class="type-caption text-text-disabled">{emptyText}</p>
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
			<line x1="0" y1={HEIGHT} x2={WIDTH} y2={HEIGHT} stroke="var(--color-border-faint)" vector-effect="non-scaling-stroke" />
			{#each lines as line (line.label + (line.dashed ? '-ref' : ''))}
				<path
					d={linePath(line.points, box)}
					fill="none"
					stroke={line.color}
					stroke-width="1.25"
					stroke-dasharray={line.dashed ? '3 3' : undefined}
					vector-effect="non-scaling-stroke"
				/>
			{/each}
			{#if hover}
				<line x1={hover.x} y1="0" x2={hover.x} y2={HEIGHT} stroke="var(--color-border-strong)" vector-effect="non-scaling-stroke" />
			{/if}
		</svg>
		<div class="mt-0.5 flex min-h-4 flex-wrap items-center gap-x-2.5 gap-y-0.5">
			{#if hover}
				<span class="type-micro font-mono text-text-tertiary">{formatTime(hover.t, range)}</span>
				{#each hover.values as { line, value } (line.label + (line.dashed ? '-ref' : ''))}
					<span class="type-micro font-mono" style="color: {line.color};">
						{line.label || title} {value === null ? '—' : formatValue(value, unit)}
					</span>
				{/each}
			{:else}
				{#each lines as line (line.label + (line.dashed ? '-ref' : ''))}
					<span class="type-micro flex items-center gap-1 text-text-tertiary">
						<span class="inline-block h-0.5 w-2.5" style="background: {line.color};"></span>
						{line.label || title}
					</span>
				{/each}
				<span class="type-micro ml-auto font-mono text-text-disabled">max {formatValue(yMax, unit)}</span>
			{/if}
		</div>
	{/if}
</div>
