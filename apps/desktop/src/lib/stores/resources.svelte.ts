/**
 * Resources for the active cluster: pods / namespaces / deployments.
 * List + watch (backend supports only these three kinds today), derived
 * counts, and auto-refresh per settings.refreshInterval.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  listDeployments,
  listNamespaces,
  listPods,
  unwatchResources,
  watchResources,
  type DeploymentInfo,
  type NamespaceInfo,
  type PodInfo,
} from "$lib/tauri";
import { app } from "./app.svelte";
import { settings } from "./settings.svelte";

const RELOAD_DEBOUNCE_MS = 300;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class ResourcesStore {
  pods = $state<PodInfo[]>([]);
  namespaces = $state<NamespaceInfo[]>([]);
  deployments = $state<DeploymentInfo[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  #loadSeq = 0;
  #watchIds: string[] = [];
  #unlisteners: UnlistenFn[] = [];
  #reloadTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshTimer: ReturnType<typeof setInterval> | null = null;

  /** Pod counts per namespace (all namespaces, from the current pod list). */
  get podCountByNamespace(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const p of this.pods) {
      counts.set(p.namespace, (counts.get(p.namespace) ?? 0) + 1);
    }
    return counts;
  }

  get runningPods(): number {
    return this.pods.filter((p) => p.phase === "Running").length;
  }

  /** Pods that are not ready or restarting hard — the "warnings" surrogate. */
  get issuePods(): PodInfo[] {
    return this.pods.filter(
      (p) => (!p.ready && p.phase !== "Succeeded") || p.restarts > 3,
    );
  }

  /**
   * Load pods + namespaces + deployments for the active cluster/namespace.
   * Late resolutions from an older cluster/namespace are dropped (seq guard).
   * Returns true when the cluster answered (drives connected/unreachable).
   */
  async load(): Promise<boolean> {
    const seq = ++this.#loadSeq;
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    const ns = app.namespace;
    if (!kc || !cluster) return false;

    this.loading = true;
    this.error = null;
    try {
      const [podList, nsList] = await Promise.all([
        listPods(kc, ns ?? undefined, cluster),
        listNamespaces(kc, cluster),
      ]);
      // list_deployments requires a namespace: fan out when filtering "all".
      const depList = ns
        ? await listDeployments(kc, ns, cluster)
        : (
            await Promise.all(
              nsList.map((n) =>
                listDeployments(kc, n.name, cluster).catch(() => [] as DeploymentInfo[]),
              ),
            )
          ).flat();

      if (seq !== this.#loadSeq) return true;
      this.pods = podList;
      this.namespaces = nsList;
      this.deployments = depList;
      return true;
    } catch (e) {
      if (seq === this.#loadSeq) this.error = errorMessage(e);
      return false;
    } finally {
      if (seq === this.#loadSeq) this.loading = false;
    }
  }

  /** Invalidate in-flight loads and clear data (call before switching cluster). */
  clear(): void {
    this.#loadSeq++;
    this.pods = [];
    this.namespaces = [];
    this.deployments = [];
    this.error = null;
    this.loading = false;
  }

  #scheduleReload(): void {
    if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = null;
      void this.load();
    }, RELOAD_DEBOUNCE_MS);
  }

  /** Start backend watches + event listeners for the active cluster/namespace. */
  async startWatching(): Promise<void> {
    await this.stopWatching();
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    if (!kc || !cluster) return;

    const onEvent = (): void => this.#scheduleReload();
    this.#unlisteners = await Promise.all([
      listen("resource-updated", onEvent),
      listen("resource-deleted", onEvent),
    ]);

    const ns = app.namespace ?? undefined;
    const results = await Promise.allSettled([
      watchResources(kc, "pod", ns, cluster),
      watchResources(kc, "deployment", ns, cluster),
    ]);
    this.#watchIds = results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
      .map((r) => r.value);
  }

  /** Tear down watches + listeners (must run before set_context). */
  async stopWatching(): Promise<void> {
    for (const un of this.#unlisteners) un();
    this.#unlisteners = [];
    const ids = this.#watchIds;
    this.#watchIds = [];
    await Promise.allSettled(ids.map((id) => unwatchResources(id)));
  }

  /** (Re)start the auto-refresh interval from settings; 0 = off. */
  applyRefreshInterval(): void {
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
    const seconds = settings.refreshInterval.value;
    if (seconds > 0) {
      this.#refreshTimer = setInterval(() => void this.load(), seconds * 1000);
    }
  }

  stopAutoRefresh(): void {
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
  }
}

export const resources = new ResourcesStore();
