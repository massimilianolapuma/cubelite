/**
 * Identity palette for the merged log view source column (§Line anatomy):
 * init containers always amber; regular containers cycle blue → teal by
 * pod-spec order. Identity, never status colors.
 */
import type { ContainerDetail } from "$lib/tauri";

const CYCLE = ["var(--color-cluster-blue)", "var(--color-cluster-teal)"];

export function identityColorFor(containers: ContainerDetail[], name: string): string {
  const c = containers.find((x) => x.name === name);
  if (c?.init) return "var(--color-cluster-amber)";
  const regulars = containers.filter((x) => !x.init);
  const i = regulars.findIndex((x) => x.name === name);
  return CYCLE[(i >= 0 ? i : 0) % CYCLE.length];
}
