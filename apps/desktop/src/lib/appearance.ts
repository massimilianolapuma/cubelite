/**
 * Runtime appearance preferences applied to <html>: row density and accent.
 * Theme (light/dark) stays with mode-watcher.
 */

import type { Accent, Density } from "$lib/stores/settings.svelte";

const ACCENT_VAR: Record<Accent, string | null> = {
  blue: null, // token default
  violet: "var(--cl-color-accent-alt-violet)",
  teal: "var(--cl-color-accent-alt-teal)",
};

/** Compact density swaps the row padding token (see app.css). */
export function applyDensity(density: Density, root: HTMLElement = document.documentElement): void {
  root.dataset.density = density;
}

/**
 * Override the accent token. An inline style on <html> beats both the :root
 * (light) and .dark definitions, so the choice holds in either theme.
 */
export function applyAccent(accent: Accent, root: HTMLElement = document.documentElement): void {
  const value = ACCENT_VAR[accent];
  if (value) root.style.setProperty("--cl-color-accent", value);
  else root.style.removeProperty("--cl-color-accent");
}
