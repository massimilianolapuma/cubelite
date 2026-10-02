/**
 * Mutating operations (delete pod, restart/scale deployment) with the
 * spec's three-level feedback: inline spinner on the affected element,
 * toast on outcome, modal only for destructive confirms.
 */

import {
  deletePod as deletePodCmd,
  restartDeployment as restartDeploymentCmd,
  scaleDeployment as scaleDeploymentCmd,
} from "#lib/tauri.ts";
import { errorMessage } from "#lib/errors.ts";
import { app } from "./app.svelte";
import { resources } from "./resources.svelte";
import { toasts } from "./toasts.svelte";

/** Idle time after the last stepper click before the scale is applied. */
export const SCALE_DEBOUNCE_MS = 800;

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
  /** Deployment key → target replicas still being edited (not yet sent). */
  draftScales = $state<Record<string, number>>({});
  readonly #draftTimers = new Map<string, ReturnType<typeof setTimeout>>();

  isDeleting(namespace: string, name: string): boolean {
    return this.pendingPodDeletes[key(namespace, name)] ?? false;
  }

  isRestarting(namespace: string, name: string): boolean {
    return this.pendingRestarts[key(namespace, name)] ?? false;
  }

  /** Target replicas while a scale is being edited or applied; null when idle. */
  pendingScale(namespace: string, name: string): number | null {
    const k = key(namespace, name);
    return this.draftScales[k] ?? this.pendingScales[k] ?? null;
  }

  /** True while a scale request is in flight (the stepper is locked). */
  isApplyingScale(namespace: string, name: string): boolean {
    return this.pendingScales[key(namespace, name)] !== undefined;
  }

  /**
   * Step the replica target by `delta`. Clicks are batched: the scale is
   * applied once, SCALE_DEBOUNCE_MS after the last step (spec: the value is
   * shown in warn while the change is pending).
   */
  nudgeScale(namespace: string, name: string, current: number, delta: number): void {
    const k = key(namespace, name);
    if (this.pendingScales[k] !== undefined) return;
    const target = Math.max(0, (this.draftScales[k] ?? current) + delta);
    const existing = this.#draftTimers.get(k);
    if (existing) clearTimeout(existing);
    if (target === current) {
      // Stepped back to where we started: nothing to apply.
      const rest = { ...this.draftScales };
      delete rest[k];
      this.draftScales = rest;
      this.#draftTimers.delete(k);
      return;
    }
    this.draftScales = { ...this.draftScales, [k]: target };
    this.#draftTimers.set(
      k,
      setTimeout(() => {
        this.#draftTimers.delete(k);
        const rest = { ...this.draftScales };
        delete rest[k];
        this.draftScales = rest;
        void this.scaleDeployment(namespace, name, target);
      }, SCALE_DEBOUNCE_MS),
    );
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
