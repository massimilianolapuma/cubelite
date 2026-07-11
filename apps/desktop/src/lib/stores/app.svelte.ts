/**
 * Global app state: active cluster, current view, namespace filter, overlays.
 */

import type { DeploymentInfo, PodInfo } from "$lib/tauri";

export const VIEWS = [
  "dashboard",
  "overview",
  "pods",
  "deployments",
  "helm",
  "services",
  "ingresses",
  "configmaps",
  "secrets",
  "events",
  "logs",
] as const;

export type View = (typeof VIEWS)[number];

export function isView(v: unknown): v is View {
  return typeof v === "string" && (VIEWS as readonly string[]).includes(v);
}

class AppState {
  /** Resolved kubeconfig path (from homeDir on startup). */
  kubeconfigPath = $state("");
  /** Active kube context name; null until contexts are discovered. */
  activeCluster = $state<string | null>(null);
  view = $state<View>("dashboard");
  /** Namespace filter; null = all namespaces. */
  namespace = $state<string | null>(null);
  /** Cluster name a switch is in flight for; null when idle. */
  connecting = $state<string | null>(null);

  paletteOpen = $state(false);
  preferencesOpen = $state(false);
  onboardingOpen = $state(false);

  selectedPod = $state<PodInfo | null>(null);
  selectedDeployment = $state<DeploymentInfo | null>(null);
  podFilter = $state("");
  deploymentFilter = $state("");

  navigate(view: View): void {
    this.view = view;
    this.selectedPod = null;
    this.selectedDeployment = null;
  }

  /** Reset per-cluster state on switch (spec: reset namespace, clear selections). */
  resetForClusterSwitch(): void {
    this.namespace = null;
    this.selectedPod = null;
    this.selectedDeployment = null;
    this.podFilter = "";
    this.deploymentFilter = "";
    if (this.view === "dashboard") this.view = "overview";
  }

  /** Close the topmost overlay; returns false if nothing was open. */
  closeTopOverlay(): boolean {
    if (this.paletteOpen) {
      this.paletteOpen = false;
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
    if (this.selectedPod || this.selectedDeployment) {
      this.selectedPod = null;
      this.selectedDeployment = null;
      return true;
    }
    return false;
  }
}

export const app = new AppState();
