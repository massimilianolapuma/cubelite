/**
 * Integration endpoints shared across kube contexts (#528): a default
 * endpoint used by every context without one of its own, per-context
 * overrides, and an explicit "off" per context. Pure helpers (same rules as
 * the macOS `EndpointStore`).
 */
import { MODE_SEGMENTS } from "#lib/integration.ts";
import type { IntegrationTarget } from "#lib/tauri.ts";

/** What an endpoint store needs to know about an endpoint. */
export type ScopedEndpoint = { target: IntegrationTarget; shared?: boolean };

/** How a context gets its endpoint. */
export type EndpointUse = "own" | "default" | "off" | "none";

/** Which endpoint the preferences edit. */
export type EndpointScopeKind = "context" | "default";

export const SCOPE_SEGMENTS: { value: EndpointScopeKind; label: string }[] = [
  { value: "context", label: "This context" },
  { value: "default", label: "All contexts (default)" },
];

/** Modes of the default endpoint's form: it can only be an external URL. */
export const DEFAULT_MODE_SEGMENTS = MODE_SEGMENTS.filter((s) => s.value !== "in-cluster");

/** What the preferences show for a context. */
export type ScopeView = "default" | "own" | "inherited" | "off";

/** Same copy on both apps. */
export const SCOPE_TEXT = {
  usingDefault: "Using the default endpoint",
  offForContext: "Off for this context: the default endpoint is not used.",
  overridesDefault: "This context overrides the default endpoint.",
  override: "Override",
  turnOff: "Turn off for this context",
  useDefault: "Use the default endpoint",
  defaultHint: "Only external URLs can be shared by every context. Credentials are saved once, for this URL only.",
  usedByNone: "No context uses the default endpoint yet.",
} as const;

/** "Used by: a, b" for the default's editor. */
export function usedByText(contexts: string[]): string {
  return contexts.length === 0 ? SCOPE_TEXT.usedByNone : `Used by: ${contexts.join(", ")}`;
}

/** Only external targets can be shared: in-cluster services are per cluster. */
export function canBeDefault(target: IntegrationTarget): boolean {
  return target.kind === "external";
}

/**
 * `own ?? (disabled ? null : default)`, the default carrying the context's
 * own settings (`merge`) and marked `shared` (its credentials are the
 * default's).
 */
export function resolveEndpoint<E extends ScopedEndpoint, P>(args: {
  own: E | null;
  fallback: E | null;
  disabled: boolean;
  settings: P | null;
  merge: (fallback: E, settings: P) => E;
}): E | null {
  const { own, fallback, disabled, settings, merge } = args;
  if (own) return own;
  if (disabled || !fallback || !canBeDefault(fallback.target)) return null;
  return { ...(settings ? merge(fallback, settings) : fallback), shared: true };
}

/** Which view the preferences show for a context. */
export function scopeView(scope: EndpointScopeKind, use: EndpointUse, overriding: boolean): ScopeView {
  if (scope === "default") return "default";
  if (overriding || use === "own" || use === "none") return "own";
  return use === "default" ? "inherited" : "off";
}

/**
 * The `cluster` label value matching a kube context (#528): equal to its
 * name, else the shortest value containing it, else the longest value the
 * name contains (`admin@aks-prod` → `aks-prod`). Case-insensitive.
 */
export function matchClusterLabel(values: string[], context: string): string | null {
  const name = context.toLowerCase();
  const exact = values.find((v) => v.toLowerCase() === name);
  if (exact !== undefined) return exact;
  const byLength = (a: string, b: string) => a.length - b.length;
  const containing = values.filter((v) => v.toLowerCase().includes(name)).sort(byLength);
  if (containing.length > 0) return containing[0];
  const contained = values.filter((v) => v.length > 0 && name.includes(v.toLowerCase())).sort(byLength);
  return contained.at(-1) ?? null;
}
