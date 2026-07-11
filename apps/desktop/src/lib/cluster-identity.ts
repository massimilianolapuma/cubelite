/**
 * Cluster identity colors — assigned at discovery, stable, user-overridable.
 * Identity ≠ health: health is always a separate dot/badge.
 */

export const IDENTITY_COLORS = ["blue", "amber", "pink", "violet", "teal"] as const;

export type IdentityColor = (typeof IDENTITY_COLORS)[number];

export function isIdentityColor(v: unknown): v is IdentityColor {
  return typeof v === "string" && (IDENTITY_COLORS as readonly string[]).includes(v);
}

/**
 * Assign a palette color to every context name. Previously saved assignments
 * win (so colors stay stable when kubeconfig order changes); new names get the
 * next palette color by first-appearance order, cycling when exhausted.
 */
export function assignIdentityColors(
  names: string[],
  saved: Record<string, string> = {},
): Record<string, IdentityColor> {
  const result: Record<string, IdentityColor> = {};
  for (const name of names) {
    const kept = saved[name];
    if (isIdentityColor(kept)) result[name] = kept;
  }
  for (const name of names) {
    if (result[name]) continue;
    result[name] = IDENTITY_COLORS[Object.keys(result).length % IDENTITY_COLORS.length];
  }
  return result;
}

/** Two-character avatar initials from a context name (e.g. "prod-eu-1" → "PE"). */
export function initials(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return "?";
}
