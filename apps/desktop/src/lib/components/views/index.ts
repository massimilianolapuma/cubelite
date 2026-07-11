/**
 * View registry: maps the app view enum to a component (+ static props).
 * Views without backend support render the spec'd empty state until their
 * Tauri commands exist.
 */

import type { Component } from "svelte";
import type { View } from "$lib/stores/app.svelte";
import EmptyStateView from "./EmptyStateView.svelte";

export interface ViewEntry {
  component: Component<Record<string, unknown>>;
  props?: Record<string, unknown>;
}

/** Erase a component's prop type so the registry can spread props generically. */
export function asEntry<P extends Record<string, unknown>>(
  component: Component<P>,
  props?: P,
): ViewEntry {
  return { component: component as unknown as ViewEntry["component"], props };
}

const emptyState = (what: string): ViewEntry =>
  asEntry(EmptyStateView, {
    message: `${what} requires backend support — coming soon.`,
  });

export const viewRegistry: Record<View, ViewEntry> = {
  dashboard: emptyState("The All Clusters dashboard"),
  overview: emptyState("The cluster overview"),
  pods: emptyState("The Pods view"),
  deployments: emptyState("The Deployments view"),
  helm: emptyState("The Helm Releases view"),
  services: emptyState("The Services view"),
  ingresses: emptyState("The Ingresses view"),
  configmaps: emptyState("The ConfigMaps view"),
  secrets: emptyState("The Secrets view"),
  events: emptyState("The Events view"),
  logs: emptyState("The Logs view"),
};
