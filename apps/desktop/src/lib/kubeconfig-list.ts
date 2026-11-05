import type { KubeconfigOrigin, KubeconfigSource } from "#lib/tauri.ts";

/** Append `added` to `current`: trimmed, non-blank, deduplicated, order kept. */
export function addPaths(current: string[], added: readonly string[]): string[] {
  const out = [...current];
  for (const raw of added) {
    const p = raw.trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export function removePath(current: string[], path: string): string[] {
  return current.filter((p) => p !== path);
}

/** The macOS "seed then edit" rule: an empty custom list starts from the resolved files. */
export function seedIfEmpty(custom: string[], resolved: readonly string[]): string[] {
  return custom.length > 0 ? custom : [...resolved];
}

export function originLabel(origin: KubeconfigOrigin): string {
  switch (origin) {
    case "custom":
      return "Custom list";
    case "env":
      return "From KUBECONFIG";
    default:
      return "From ~/.kube";
  }
}

/**
 * Clusters and users `source` defines differently from an earlier file, as
 * `cluster <name>` / `user <name>` labels in that order.
 */
export function redefinedEntries(
  source: Pick<KubeconfigSource, "redefined_clusters" | "redefined_users">,
): string[] {
  return [
    ...(source.redefined_clusters ?? []).map((name) => `cluster ${name}`),
    ...(source.redefined_users ?? []).map((name) => `user ${name}`),
  ];
}
