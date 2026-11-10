/**
 * Cluster identity colors — assigned at discovery, stable, user-overridable.
 * Identity ≠ health: health is always a separate dot/badge.
 *
 * The identity is also the tint of the whole window, so the palette is cool
 * hues only: red, amber and green mean a state, never a cluster. The order
 * (which is the order of `identity.hues` in design/tokens.json) puts the most
 * different hues first, so the first clusters are the easiest to tell apart.
 */

export const IDENTITY_COLORS = ["blue", "magenta", "teal", "violet", "indigo"] as const;

export type IdentityColor = (typeof IDENTITY_COLORS)[number];

export function isIdentityColor(v: unknown): v is IdentityColor {
  return typeof v === "string" && (IDENTITY_COLORS as readonly string[]).includes(v);
}

/** Colours of the v2 palette that left it, and where a saved choice moves. */
const RETIRED: Record<string, IdentityColor> = { amber: "indigo", pink: "magenta" };

/** The hue of an identity, for `--cl-tint-h` (emitted by the token generator). */
export function identityHue(color: IdentityColor): string {
  return `var(--cl-hue-${color})`;
}

/**
 * CSS color for an identity. Uses the base `--cl-color-cluster-*` variables:
 * Tailwind only emits theme vars (`--color-*`) it sees referenced literally,
 * and a name built at runtime (`--color-cluster-${color}`) is invisible to it
 * (#391).
 */
export function identityVar(color: IdentityColor): string {
  return `var(--cl-color-cluster-${color})`;
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
    const value = saved[name];
    const kept = Object.hasOwn(RETIRED, value) ? RETIRED[value] : value;
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
