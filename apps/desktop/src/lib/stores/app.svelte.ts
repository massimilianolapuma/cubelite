/**
 * Global app state: active cluster, current view, namespace filter, overlays.
 */

import { lists } from "./lists.svelte";
import { GENERIC_VIEWS } from "#lib/resource-kinds.ts";
import type { DeploymentInfo, KubeconfigOrigin, KubeconfigSource, PodInfo } from "#lib/tauri.ts";

export const VIEWS = [
  "dashboard",
  "overview",
  "pods",
  "deployments",
  "statefulsets",
  "jobs",
  "cronjobs",
  "helm",
  "services",
  "ingresses",
  "configmaps",
  "secrets",
  "pvcs",
  "events",
  "logs",
  "nodes",
  // Listed through the API server's Table (resource-kinds design §5.1).
  ...GENERIC_VIEWS,
] as const;

export type View = (typeof VIEWS)[number];

/** Preferences sections that can be opened directly (#526). */
export type PreferencesSection = "integrations" | "elasticsearch" | "prometheus";

export function isView(v: unknown): v is View {
  return typeof v === "string" && (VIEWS as readonly string[]).includes(v);
}

class AppState {
  /**
   * Kubeconfig spec passed to every command: one path or a KUBECONFIG-style
   * list (resolved by the backend on startup, ~/.kube/config fallback).
   */
  kubeconfigPath = $state("");
  /** Files behind `kubeconfigPath`, in merge order (Preferences list). */
  kubeconfigSources = $state<KubeconfigSource[]>([]);
  /** Which precedence level produced kubeconfigSources. */
  kubeconfigOrigin = $state<KubeconfigOrigin>("default");
  /** Active kube context name; null until contexts are discovered. */
  activeCluster = $state<string | null>(null);
  view = $state<View>("dashboard");
  /** Namespace filter; null = all namespaces. */
  namespace = $state<string | null>(null);
  /** Lists show namespace groups: the preference is on and all namespaces are shown (#547). */
  get groupedLists(): boolean {
    return lists.groupByNamespace && this.namespace === null;
  }
  /** Cluster name a switch is in flight for; null when idle. */
  connecting = $state<string | null>(null);

  paletteOpen = $state(false);
  preferencesOpen = $state(false);
  /** Part of Preferences to scroll to when it opens; cleared once shown. */
  preferencesSection = $state<PreferencesSection | null>(null);
  onboardingOpen = $state(false);

  /** Opens Preferences, optionally on one of its sections (#526). */
  openPreferences(section: PreferencesSection | null = null): void {
    this.preferencesSection = section;
    this.preferencesOpen = true;
  }

  /**
   * Close handlers of mounted `Modal`s, innermost last. Component-owned
   * dialogs (Delete Pod, YAML) register here so Esc can close them before
   * the drawer underneath.
   */
  readonly #modalStack: Array<() => void> = [];

  selectedPod = $state<PodInfo | null>(null);
  selectedDeployment = $state<DeploymentInfo | null>(null);
  /** Node whose drawer is open in the Nodes view (#530). */
  selectedNode = $state<string | null>(null);
  /** Object whose YAML drawer is open in a generic list (resource-kinds §5.1). */
  selectedObject = $state<{ name: string; namespace: string | null } | null>(null);
  podFilter = $state("");
  /** Pods list shows only the pods needing attention (#574). */
  podIssuesOnly = $state(false);
  /** Events list shows only warnings (#574). */
  eventWarningsOnly = $state(false);
  deploymentFilter = $state("");

  navigate(view: View): void {
    this.view = view;
    this.selectedPod = null;
    this.selectedDeployment = null;
    this.selectedNode = null;
    this.selectedObject = null;
  }

  /** Reset per-cluster state on switch (spec: reset namespace, clear selections). */
  resetForClusterSwitch(): void {
    lists.resetSession();
    this.namespace = null;
    this.selectedPod = null;
    this.selectedDeployment = null;
    this.selectedNode = null;
    this.selectedObject = null;
    this.podFilter = "";
    this.podIssuesOnly = false;
    this.eventWarningsOnly = false;
    this.deploymentFilter = "";
    if (this.view === "dashboard") this.view = "overview";
  }

  /** Register a mounted modal's close handler; returns the unregister function. */
  pushModal(close: () => void): () => void {
    this.#modalStack.push(close);
    return () => {
      const i = this.#modalStack.lastIndexOf(close);
      if (i !== -1) this.#modalStack.splice(i, 1);
    };
  }

  /** Close the topmost overlay; returns false if nothing was open. */
  closeTopOverlay(): boolean {
    if (this.paletteOpen) {
      this.paletteOpen = false;
      return true;
    }
    const closeModal = this.#modalStack.at(-1);
    if (closeModal) {
      closeModal();
      return true;
    }
    if (this.preferencesOpen) {
      this.preferencesOpen = false;
      return true;
    }
    if (this.onboardingOpen) {
      this.onboardingOpen = false;
      return true;
    }
    if (this.selectedPod || this.selectedDeployment || this.selectedNode || this.selectedObject) {
      this.selectedPod = null;
      this.selectedDeployment = null;
      this.selectedNode = null;
      this.selectedObject = null;
      return true;
    }
    return false;
  }
}

export const app = new AppState();
