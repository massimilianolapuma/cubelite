/**
 * Mutating operations (delete pod, restart/scale deployment) with the
 * spec's three-level feedback: inline spinner on the affected element,
 * toast on outcome, modal only for destructive confirms.
 */

import {
  deletePod as deletePodCmd,
  restartDeployment as restartDeploymentCmd,
  scaleDeployment as scaleDeploymentCmd,
} from "$lib/tauri";
import { errorMessage } from "$lib/errors";
import { app } from "./app.svelte";
import { resources } from "./resources.svelte";
import { toasts } from "./toasts.svelte";

function key(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

class MutationsStore {
  /** Keys of pods with a delete in flight. */
  pendingPodDeletes = $state<Record<string, boolean>>({});
  /** Keys of deployments with a restart in flight. */
  pendingRestarts = $state<Record<string, boolean>>({});
  /** Deployment key → target replicas while a scale is applying. */
  pendingScales = $state<Record<string, number>>({});

  isDeleting(namespace: string, name: string): boolean {
    return this.pendingPodDeletes[key(namespace, name)] ?? false;
  }

  isRestarting(namespace: string, name: string): boolean {
    return this.pendingRestarts[key(namespace, name)] ?? false;
  }

  pendingScale(namespace: string, name: string): number | null {
    return this.pendingScales[key(namespace, name)] ?? null;
  }

  async deletePod(namespace: string, name: string): Promise<boolean> {
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    if (!kc || !cluster) return false;
    const k = key(namespace, name);
    this.pendingPodDeletes = { ...this.pendingPodDeletes, [k]: true };
    try {
      await deletePodCmd(kc, namespace, name, cluster);
      toasts.push(`Pod ${name} deleted`, "ok");
      void resources.load();
      return true;
    } catch (e) {
      toasts.push(`Delete failed: ${errorMessage(e)}`, "err");
      return false;
    } finally {
      const rest = { ...this.pendingPodDeletes };
      delete rest[k];
      this.pendingPodDeletes = rest;
    }
  }

  async restartDeployment(namespace: string, name: string): Promise<boolean> {
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    if (!kc || !cluster) return false;
    const k = key(namespace, name);
    this.pendingRestarts = { ...this.pendingRestarts, [k]: true };
    try {
      await restartDeploymentCmd(kc, namespace, name, cluster);
      toasts.push(`Rollout restart of ${name} triggered`, "ok");
      void resources.load();
      return true;
    } catch (e) {
      toasts.push(`Restart failed: ${errorMessage(e)}`, "err");
      return false;
    } finally {
      const rest = { ...this.pendingRestarts };
      delete rest[k];
      this.pendingRestarts = rest;
    }
  }

  async scaleDeployment(namespace: string, name: string, replicas: number): Promise<boolean> {
    if (replicas < 0) return false;
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    if (!kc || !cluster) return false;
    const k = key(namespace, name);
    this.pendingScales = { ...this.pendingScales, [k]: replicas };
    try {
      await scaleDeploymentCmd(kc, namespace, name, replicas, cluster);
      toasts.push(`${name} scaled to ${replicas}`, "ok");
      await resources.load();
      return true;
    } catch (e) {
      toasts.push(`Scale failed: ${errorMessage(e)}`, "err");
      return false;
    } finally {
      const rest = { ...this.pendingScales };
      delete rest[k];
      this.pendingScales = rest;
    }
  }
}

export const mutations = new MutationsStore();
