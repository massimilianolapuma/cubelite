/** Human-readable CPU/memory formatting for metrics values. */

/**
 * Millicores → "250m" below 1 core, "1.25" cores above. The unit and the
 * decimals follow the value shown: 999.6m is "1", 15999.7m is "16".
 */
export function formatCpu(millis: number): string {
  const rounded = Math.round(millis);
  if (rounded < 1000) return `${rounded}m`;
  const cores = Math.round(millis / 10) / 100;
  return Number.isInteger(cores) ? String(cores) : cores.toFixed(2);
}

/** Bytes → binary units ("512Mi", "2.0Gi"). */
export function formatBytes(bytes: number): string {
  const units = ["B", "Ki", "Mi", "Gi", "Ti"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1);
  return `${rounded}${units[unit]}`;
}

/**
 * A length in bytes as a person reads it (#661): "12 B" below 1 KiB, then
 * one decimal in KiB or MiB ("1.8 KiB", "48.2 KiB"); a whole value drops its ".0".
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[unit]}`;
}

/** Safe percentage (0–100), null when the denominator is missing. */
export function percentOf(used: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(100, (used / total) * 100);
}
