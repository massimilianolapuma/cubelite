/**
 * Pure helpers of the Prometheus Metrics section and sparklines (#510,
 * spec docs/superpowers/specs/2026-11-03-prometheus-grafana-design.md §5).
 */
import type { Chart, ChartData, MetricsRange, Point, Series } from "#lib/tauri.ts";
import { formatBytes, formatCpu } from "#lib/units.ts";

export const METRICS_RANGES: { value: MetricsRange; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

/** Line colours, in order of first appearance (same tokens as cluster identity). */
export const SERIES_COLORS = [
  "var(--color-accent)",
  "var(--color-cluster-teal)",
  "var(--color-cluster-violet)",
  "var(--color-cluster-amber)",
  "var(--color-cluster-pink)",
  "var(--color-cluster-blue)",
];

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

/** One line of a chart; dashed for reference lines (requests, limits). */
export type ChartLine = { label: string; color: string; points: Point[]; dashed?: boolean };

export type Unit = "cores" | "bytes" | "bytes-per-second" | "count";

export function formatValue(value: number, unit: Unit): string {
  switch (unit) {
    case "cores":
      return formatCpu(value * 1000);
    case "bytes":
      return formatBytes(value);
    case "bytes-per-second":
      return `${formatBytes(value)}/s`;
    case "count":
      return String(Math.round(value));
  }
}

/** The data of `chart`, or null when the result does not have it. */
export function chartData(charts: ChartData[], chart: Chart): ChartData | null {
  return charts.find((c) => c.chart === chart) ?? null;
}

/** Last non-null value of a series. */
export function latest(points: Point[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i][1];
    if (v !== null) return v;
  }
  return null;
}

/** Sum of the latest values of every series (null when none has one). */
export function latestTotal(series: Series[]): number | null {
  const values = series.map((s) => latest(s.points)).filter((v): v is number => v !== null);
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
}

/**
 * Restarts in range from cumulative counters: the sum of every increase
 * (a counter dropping means a new pod started again from 0).
 */
export function restartsInRange(series: Series[]): number {
  let total = 0;
  for (const s of series) {
    let previous: number | null = null;
    for (const [, v] of s.points) {
      if (v === null) continue;
      if (previous !== null && v > previous) total += v - previous;
      previous = v;
    }
  }
  return Math.round(total);
}

/** Point-wise sum of series sharing timestamps (deployment sparklines). */
export function sumPoints(series: Point[][]): Point[] {
  const byTime = new Map<number, number>();
  for (const points of series) {
    for (const [t, v] of points) {
      if (v === null) continue;
      byTime.set(t, (byTime.get(t) ?? 0) + v);
    }
  }
  return [...byTime.entries()].sort(([a], [b]) => a - b).map(([t, v]) => [t, v]);
}

/** A round axis maximum (1, 2 or 5 × 10ⁿ) at or above `max`. */
export function niceMax(max: number): number {
  if (!(max > 0) || !Number.isFinite(max)) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) {
    if (max <= step * exp) return step * exp;
  }
  return 10 * exp;
}

/** Largest value across series (and reference lines), or 0. */
export function maxValue(series: Series[]): number {
  let max = 0;
  for (const s of series) for (const [, v] of s.points) if (v !== null && v > max) max = v;
  return max;
}

/**
 * SVG path of `points` in a `width`×`height` box over `[start, end]` and
 * `[0, yMax]`; a null value breaks the line (a new `M`).
 */
export function linePath(
  points: Point[],
  box: { start: number; end: number; yMax: number; width: number; height: number },
): string {
  const { start, end, yMax, width, height } = box;
  const span = end - start || 1;
  const top = yMax || 1;
  let path = "";
  let pen = false;
  for (const [t, v] of points) {
    if (v === null) {
      pen = false;
      continue;
    }
    const x = ((t - start) / span) * width;
    const y = height - (Math.min(v, top) / top) * height;
    path += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  return path;
}

/** Index of the point nearest to time `t` (hover crosshair). */
export function nearestIndex(points: Point[], t: number): number {
  let best = -1;
  let distance = Infinity;
  points.forEach(([pt], i) => {
    const d = Math.abs(pt - t);
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return best;
}

/** "14:05" for ranges up to a day, "Mon 14:05" beyond. */
export function formatTime(seconds: number, range: MetricsRange): string {
  const date = new Date(seconds * 1000);
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return range === "7d" ? `${date.toLocaleDateString("en-GB", { weekday: "short" })} ${time}` : time;
}
