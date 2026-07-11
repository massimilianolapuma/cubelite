/** True when every selector entry is present in the labels map (matchLabels semantics). */
export function matchesSelector(
  labels: Record<string, string>,
  selector: Record<string, string>,
): boolean {
  const entries = Object.entries(selector);
  if (entries.length === 0) return false;
  return entries.every(([k, v]) => labels[k] === v);
}
