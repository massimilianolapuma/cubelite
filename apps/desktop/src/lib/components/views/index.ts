/** View registry: maps the app view enum to a component (+ static props). */

import type { Component } from "svelte";
import type { View } from "$lib/stores/app.svelte";
import AllClustersView from "./AllClustersView.svelte";
import ConfigMapsView from "./ConfigMapsView.svelte";
import CronJobsView from "./CronJobsView.svelte";
import DeploymentsView from "./DeploymentsView.svelte";
import EventsView from "./EventsView.svelte";
import HelmView from "./HelmView.svelte";
import IngressesView from "./IngressesView.svelte";
import JobsView from "./JobsView.svelte";
import LogsView from "./LogsView.svelte";
import NodesView from "./NodesView.svelte";
import OverviewView from "./OverviewView.svelte";
import PodsView from "./PodsView.svelte";
import PvcsView from "./PvcsView.svelte";
import SecretsView from "./SecretsView.svelte";
import ServicesView from "./ServicesView.svelte";
import StatefulSetsView from "./StatefulSetsView.svelte";

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

export const viewRegistry: Record<View, ViewEntry> = {
  dashboard: asEntry(AllClustersView),
  overview: asEntry(OverviewView),
  pods: asEntry(PodsView),
  deployments: asEntry(DeploymentsView),
  statefulsets: asEntry(StatefulSetsView),
  jobs: asEntry(JobsView),
  cronjobs: asEntry(CronJobsView),
  helm: asEntry(HelmView),
  services: asEntry(ServicesView),
  ingresses: asEntry(IngressesView),
  configmaps: asEntry(ConfigMapsView),
  secrets: asEntry(SecretsView),
  pvcs: asEntry(PvcsView),
  events: asEntry(EventsView),
  logs: asEntry(LogsView),
  nodes: asEntry(NodesView),
};
