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
import { readOnlyRefusal } from "#lib/access.ts";
import { errorMessage } from "#lib/errors.ts";
import { activeClusterRef, elsewhere, onScreen, refKey, type ClusterRef } from "./cluster-ref";
import { clusterSettings } from "./cluster-settings.svelte";
import { resources } from "./resources.svelte";
import { toasts } from "./toasts.svelte";

/** Idle time after the last stepper click before the scale is applied. */
export const SCALE_DEBOUNCE_MS = 800;

/**
 * Whether `cluster` takes a write (#662). A read-only one takes none: no call
 * goes to the backend, and the toast says why in the backend's words, the
 * same error the user would see had the backend refused it (a scale whose
 * debounce outlived the unlock). The reason names the cluster.
 */
function writable(cluster: string, failed: string): boolean {
  const reason = clusterSettings.lockReason(cluster);
  if (reason === null) return true;
  toasts.push(`${failed} failed: ${readOnlyRefusal(reason)}`, "err");
  return false;
}

/**
 * Every action runs on the cluster it was started on (#685): the caller hands
 * it the kubeconfig and context taken when its dialog opened or its button was
 * used, and the active ones are taken otherwise. What is in flight is keyed by
 * that cluster, so it never shows on the same-named object of another one; an
 * outcome that lands after a switch names its cluster and reloads nothing.
 */
class MutationsStore {
  /** Keys (`refKey`) of pods with a delete in flight. */
  pendingPodDeletes = $state<Record<string, boolean>>({});
  /** Keys of deployments with a restart in flight. */
  pendingRestarts = $state<Record<string, boolean>>({});
  /** Deployment key → target replicas while a scale is applying. */
  pendingScales = $state<Record<string, number>>({});
  /** Deployment key → target replicas still being edited (not yet sent). */
  draftScales = $state<Record<string, number>>({});
  readonly #draftTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** The key of `namespace/name` on the active cluster; null when there is none. */
  #activeKey(namespace: string, name: string): string | null {
    const ref = activeClusterRef();
    return ref === null ? null : refKey(ref, namespace, name);
  }

  isDeleting(namespace: string, name: string): boolean {
    const k = this.#activeKey(namespace, name);
    return k !== null && (this.pendingPodDeletes[k] ?? false);
  }

  isRestarting(namespace: string, name: string): boolean {
    const k = this.#activeKey(namespace, name);
    return k !== null && (this.pendingRestarts[k] ?? false);
  }

  /** Target replicas while a scale is being edited or applied; null when idle. */
  pendingScale(namespace: string, name: string): number | null {
    const k = this.#activeKey(namespace, name);
    if (k === null) return null;
    return this.draftScales[k] ?? this.pendingScales[k] ?? null;
  }

  /** True while a scale request is in flight (the stepper is locked). */
  isApplyingScale(namespace: string, name: string): boolean {
    const k = this.#activeKey(namespace, name);
    return k !== null && this.pendingScales[k] !== undefined;
  }

  /**
   * Step the replica target by `delta`. Clicks are batched: the scale is
   * applied once, SCALE_DEBOUNCE_MS after the last step (spec: the value is
   * shown in warn while the change is pending). The kubeconfig and context
   * are taken at the step, so the scale goes to the cluster it was made on
   * whatever is active when it is sent (#682).
   */
  nudgeScale(namespace: string, name: string, current: number, delta: number): void {
    const ref = activeClusterRef();
    if (ref === null) return;
    const k = refKey(ref, namespace, name);
    if (this.pendingScales[k] !== undefined) return;
    // A read-only cluster's stepper is off; nothing to hold either.
    if (clusterSettings.lockReason(ref.cluster) !== null) return;
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
        void this.#scale(ref, namespace, name, target);
      }, SCALE_DEBOUNCE_MS),
    );
  }

  /**
   * Drop every scale still held in the debounce: nothing is sent. Called when
   * the active cluster changes: a step is not sent once its cluster is left (#682).
   */
  cancelDrafts(): void {
    for (const timer of this.#draftTimers.values()) clearTimeout(timer);
    this.#draftTimers.clear();
    this.draftScales = {};
  }

  /** Delete a pod on `on`: the cluster its dialog was opened on, the active one by default. */
  async deletePod(namespace: string, name: string, on: ClusterRef | null = activeClusterRef()): Promise<boolean> {
    if (on === null || !writable(on.cluster, "Delete")) return false;
    const k = refKey(on, namespace, name);
    this.pendingPodDeletes = { ...this.pendingPodDeletes, [k]: true };
    try {
      await deletePodCmd(on.kubeconfig, namespace, name, on.cluster);
      toasts.push(`Pod ${name} deleted${elsewhere(on)}`, "ok");
      if (onScreen(on)) void resources.load();
      return true;
    } catch (e) {
      toasts.push(`Delete${elsewhere(on)} failed: ${errorMessage(e)}`, "err");
      return false;
    } finally {
      const rest = { ...this.pendingPodDeletes };
      delete rest[k];
      this.pendingPodDeletes = rest;
    }
  }

  /** Restart a deployment on `on`, the active cluster by default. */
  async restartDeployment(
    namespace: string,
    name: string,
    on: ClusterRef | null = activeClusterRef(),
  ): Promise<boolean> {
    if (on === null || !writable(on.cluster, "Restart")) return false;
    const k = refKey(on, namespace, name);
    this.pendingRestarts = { ...this.pendingRestarts, [k]: true };
    try {
      await restartDeploymentCmd(on.kubeconfig, namespace, name, on.cluster);
      toasts.push(`Rollout restart of ${name} triggered${elsewhere(on)}`, "ok");
      if (onScreen(on)) void resources.load();
      return true;
    } catch (e) {
      toasts.push(`Restart${elsewhere(on)} failed: ${errorMessage(e)}`, "err");
      return false;
    } finally {
      const rest = { ...this.pendingRestarts };
      delete rest[k];
      this.pendingRestarts = rest;
    }
  }

  /** Scale a deployment on `on`, the active cluster by default. */
  async scaleDeployment(
    namespace: string,
    name: string,
    replicas: number,
    on: ClusterRef | null = activeClusterRef(),
  ): Promise<boolean> {
    if (on === null) return false;
    return this.#scale(on, namespace, name, replicas);
  }

  /** Scale on the given kubeconfig and context, which need not be the active ones. */
  async #scale(on: ClusterRef, namespace: string, name: string, replicas: number): Promise<boolean> {
    if (replicas < 0 || !writable(on.cluster, "Scale")) return false;
    const k = refKey(on, namespace, name);
    this.pendingScales = { ...this.pendingScales, [k]: replicas };
    try {
      await scaleDeploymentCmd(on.kubeconfig, namespace, name, replicas, on.cluster);
      toasts.push(`${name} scaled to ${replicas}${elsewhere(on)}`, "ok");
      if (onScreen(on)) await resources.load();
      return true;
    } catch (e) {
      toasts.push(`Scale${elsewhere(on)} failed: ${errorMessage(e)}`, "err");
      return false;
    } finally {
      const rest = { ...this.pendingScales };
      delete rest[k];
      this.pendingScales = rest;
    }
  }
}

export const mutations = new MutationsStore();
