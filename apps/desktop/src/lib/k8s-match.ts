/** True when every selector entry is present in the labels map (matchLabels semantics). */
export function matchesSelector(
  labels: Record<string, string>,
  selector: Record<string, string>,
): boolean {
  const entries = Object.entries(selector);
  if (entries.length === 0) return false;
  return entries.every(([k, v]) => labels[k] === v);
}

/**
 * Parses an equality-based label selector ("app=api, tier=web") into a
 * selector map. Malformed tokens (no key, no value, no "=") are ignored;
 * values may themselves contain "=". Empty input yields an empty selector,
 * which callers must treat as "match all" (matchesSelector treats an empty
 * selector as match-none by design).
 */
export function parseLabelSelector(text: string): Record<string, string> {
  const selector: Record<string, string> = {};
  for (const token of text.split(",")) {
    const eq = token.indexOf("=");
    if (eq < 0) continue;
    const key = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim();
    if (!key || !value) continue;
    selector[key] = value;
  }
  return selector;
}
