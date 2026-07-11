/**
 * View registry: maps the app view enum to a component (+ static props).
 * Views without backend support render the spec'd empty state until their
 * Tauri commands exist.
 */

import type { Component } from "svelte";
import type { View } from "$lib/stores/app.svelte";
import AllClustersView from "./AllClustersView.svelte";
import ConfigMapsView from "./ConfigMapsView.svelte";
import DeploymentsView from "./DeploymentsView.svelte";
import EmptyStateView from "./EmptyStateView.svelte";
import IngressesView from "./IngressesView.svelte";
import OverviewView from "./OverviewView.svelte";
import PodsView from "./PodsView.svelte";
import SecretsView from "./SecretsView.svelte";
import ServicesView from "./ServicesView.svelte";

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
  dashboard: asEntry(AllClustersView),
  overview: asEntry(OverviewView),
  pods: asEntry(PodsView),
  deployments: asEntry(DeploymentsView),
  helm: emptyState("The Helm Releases view"),
  services: asEntry(ServicesView),
  ingresses: asEntry(IngressesView),
  configmaps: asEntry(ConfigMapsView),
  secrets: asEntry(SecretsView),
  events: emptyState("The Events view"),
  logs: emptyState("The Logs view"),
};
