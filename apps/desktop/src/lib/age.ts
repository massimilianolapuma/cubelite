/** kubectl-style relative age from an RFC 3339 timestamp (e.g. "3d", "5h12m"). */
export function formatAge(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";

  let seconds = Math.floor((now.getTime() - then) / 1000);
  if (seconds < 0) seconds = 0;

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days >= 10) return `${days}d`;
  if (days >= 1) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours >= 10) return `${hours}h`;
  if (hours >= 1) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes >= 1) return `${minutes}m`;
  return `${seconds}s`;
}
