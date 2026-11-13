/**
 * Runtime appearance applied to <html>: row density and the cluster tint.
 * Theme (light/dark) stays with mode-watcher.
 */

import { identityHue, type IdentityColor } from "#lib/cluster-identity.ts";
import type { Density } from "#lib/stores/settings.svelte.ts";

/** Compact density swaps the density tokens (see app.css). */
export function applyDensity(density: Density, root: HTMLElement = document.documentElement): void {
  root.dataset.density = density;
}

/**
 * Tint the window with a cluster's identity. Every tinted colour token reads
 * `--cl-tint-h`; an inline value on <html> beats the token default in either
 * theme. `null` goes back to the default tint.
 */
export function applyTint(
  color: IdentityColor | null,
  root: HTMLElement = document.documentElement,
): void {
  if (color) root.style.setProperty("--cl-tint-h", identityHue(color));
  else root.style.removeProperty("--cl-tint-h");
}

/**
 * The tint a window shows: the active cluster's identity, or the default when
 * the window is `neutral`, i.e. showing something that belongs to no cluster
 * (the All Clusters dashboard, onboarding), or has no context yet.
 */
export function tintFor(
  neutral: boolean,
  cluster: string | null,
  identityFor: (name: string) => IdentityColor,
): IdentityColor | null {
  return neutral || !cluster ? null : identityFor(cluster);
}

/**
 * The tint of a window (Tonal §4.1, §8.4): its cluster's, or the default on a
 * view that belongs to none (the All Clusters dashboard, onboarding). While a
 * cluster is being connected to, the tint is already that cluster's: the
 * colour changes when the user asks, not when the answer arrives. A pop-out
 * log window always keeps its pod's cluster.
 */
export function windowTint(
  state: { popout: boolean; neutralView: boolean; connecting: string | null; active: string | null },
  identityFor: (name: string) => IdentityColor,
): IdentityColor | null {
  if (state.connecting !== null) return identityFor(state.connecting);
  return tintFor(!state.popout && state.neutralView, state.active, identityFor);
}

/**
 * Inline style that gives an element another cluster's tint. Put it on an
 * element that also carries `data-tint`: every colour role is re-declared
 * there, so the whole subtree follows this hue (see design/README.md).
 */
export function tintStyle(color: IdentityColor): string {
  return `--cl-tint-h: ${identityHue(color)}`;
}
