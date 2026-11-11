<script lang="ts">
	import { linePath, maxValue } from '#lib/metrics.ts';
	import type { Point } from '#lib/tauri.ts';

	// Last hour of one value next to a list cell (#510); nothing without data.
	let { points, label }: { points: Point[] | null; label: string } = $props();

	const WIDTH = 48;
	const HEIGHT = 14;
	const path = $derived.by(() => {
		if (!points || points.length < 2) return '';
		const start = points[0][0];
		const end = points[points.length - 1][0];
		const yMax = maxValue([{ label: '', points }]) * 1.1 || 1;
		return linePath(points, { start, end, yMax, width: WIDTH, height: HEIGHT });
	});
</script>

{#if path}
	<svg
		class="shrink-0"
		width={WIDTH}
		height={HEIGHT}
		viewBox="0 0 {WIDTH} {HEIGHT}"
		role="img"
		aria-label={label}
	>
		<path d={path} fill="none" stroke="var(--color-primary)" stroke-width="1.25" vector-effect="non-scaling-stroke" />
	</svg>
{/if}
