/**
 * Resources for the active cluster: pods / namespaces / deployments.
 * List + watch (backend supports only these three kinds today), derived
 * counts, and auto-refresh per settings.refreshInterval.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  clusterCapacity,
  listConfigMaps,
  listDeployments,
  listEvents,
  listHelmReleases,
  listIngresses,
  listNamespaces,
  listPods,
  listPodMetrics,
  listSecrets,
  listServices,
  unwatchResources,
  watchResources,
  type ConfigMapInfo,
  type DeploymentInfo,
  type EventInfo,
  type HelmReleaseInfo,
  type IngressInfo,
  type NamespaceInfo,
  type NodeCapacityInfo,
  type PodInfo,
  type PodMetricsInfo,
  type SecretInfo,
  type ServiceInfo,
} from "$lib/tauri";
import { errorMessage } from "$lib/errors";
import { app } from "./app.svelte";
import { settings } from "./settings.svelte";

const RELOAD_DEBOUNCE_MS = 300;

/** Resource kinds loaded on demand when their view is opened. */
export type ExtraKind = "services" | "ingresses" | "configmaps" | "secrets" | "helm";

const EXTRA_KINDS: readonly ExtraKind[] = [
  "services",
  "ingresses",
  "configmaps",
  "secrets",
  "helm",
];

export function isExtraKind(v: unknown): v is ExtraKind {
  return typeof v === "string" && (EXTRA_KINDS as readonly string[]).includes(v);
}

class ResourcesStore {
  pods = $state<PodInfo[]>([]);
  namespaces = $state<NamespaceInfo[]>([]);
  deployments = $state<DeploymentInfo[]>([]);
  events = $state<EventInfo[]>([]);
  services = $state<ServiceInfo[]>([]);
  ingresses = $state<IngressInfo[]>([]);
  configmaps = $state<ConfigMapInfo[]>([]);
  secrets = $state<SecretInfo[]>([]);
  helmReleases = $state<HelmReleaseInfo[]>([]);
  /** ns/name → usage; null until metrics-server answers, {} when it 404s. */
  podMetrics = $state<Record<string, PodMetricsInfo>>({});
  nodes = $state<NodeCapacityInfo[]>([]);
  /** false when metrics-server is unavailable in the active cluster. */
  metricsAvailable = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);
  extraLoading = $state(false);
  extraError = $state<string | null>(null);

  #loadSeq = 0;
  #extraSeq = 0;
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

  /** Pods that are not ready or restarting hard. */
  get issuePods(): PodInfo[] {
    return this.pods.filter(
      (p) => (!p.ready && p.phase !== "Succeeded") || p.restarts > 3,
    );
  }

  /** Warning-type events (drives sidebar/status-bar counts and Overview). */
  get warningEvents(): EventInfo[] {
    return this.events.filter((e) => e.event_type === "Warning");
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
      const [podList, nsList, eventList] = await Promise.all([
        listPods(kc, ns ?? undefined, cluster),
        listNamespaces(kc, cluster),
        // Events are non-fatal: the warnings count degrades to empty.
        listEvents(kc, ns ?? undefined, cluster).catch(() => [] as EventInfo[]),
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
      this.events = eventList;
      void this.#loadMetrics(kc, ns ?? undefined, cluster, seq);
      // Keep the currently open extra view in sync with refresh/watch cycles.
      if (isExtraKind(app.view)) void this.loadKind(app.view);
      return true;
    } catch (e) {
      if (seq === this.#loadSeq) this.error = errorMessage(e);
      return false;
    } finally {
      if (seq === this.#loadSeq) this.loading = false;
    }
  }

  /** Metrics are best-effort: absence of metrics-server must not fail load(). */
  async #loadMetrics(
    kc: string,
    ns: string | undefined,
    cluster: string,
    seq: number,
  ): Promise<void> {
    try {
      const [podMetricsList, nodeList] = await Promise.all([
        listPodMetrics(kc, ns, cluster),
        clusterCapacity(kc, cluster),
      ]);
      if (seq !== this.#loadSeq) return;
      const map: Record<string, PodMetricsInfo> = {};
      for (const m of podMetricsList) map[`${m.namespace}/${m.name}`] = m;
      this.podMetrics = map;
      this.nodes = nodeList;
      this.metricsAvailable = true;
    } catch {
      if (seq !== this.#loadSeq) return;
      this.podMetrics = {};
      this.nodes = [];
      this.metricsAvailable = false;
    }
  }

  metricsFor(namespace: string, name: string): PodMetricsInfo | null {
    return this.podMetrics[`${namespace}/${name}`] ?? null;
  }

  /** Cluster totals from per-node capacity; null without metrics. */
  get capacityTotals(): {
    cpuUsed: number;
    cpuAllocatable: number;
    memUsed: number;
    memAllocatable: number;
  } | null {
    if (!this.metricsAvailable || this.nodes.length === 0) return null;
    return this.nodes.reduce(
      (acc, n) => ({
        cpuUsed: acc.cpuUsed + n.cpu_used_millis,
        cpuAllocatable: acc.cpuAllocatable + n.cpu_allocatable_millis,
        memUsed: acc.memUsed + n.memory_used_bytes,
        memAllocatable: acc.memAllocatable + n.memory_allocatable_bytes,
      }),
      { cpuUsed: 0, cpuAllocatable: 0, memUsed: 0, memAllocatable: 0 },
    );
  }

  /** Load one on-demand kind (services/ingresses/configmaps/secrets). */
  async loadKind(kind: ExtraKind): Promise<void> {
    const seq = ++this.#extraSeq;
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    const ns = app.namespace ?? undefined;
    if (!kc || !cluster) return;

    this.extraLoading = true;
    this.extraError = null;
    try {
      switch (kind) {
        case "services": {
          const list = await listServices(kc, ns, cluster);
          if (seq === this.#extraSeq) this.services = list;
          break;
        }
        case "ingresses": {
          const list = await listIngresses(kc, ns, cluster);
          if (seq === this.#extraSeq) this.ingresses = list;
          break;
        }
        case "configmaps": {
          const list = await listConfigMaps(kc, ns, cluster);
          if (seq === this.#extraSeq) this.configmaps = list;
          break;
        }
        case "secrets": {
          const list = await listSecrets(kc, ns, cluster);
          if (seq === this.#extraSeq) this.secrets = list;
          break;
        }
        case "helm": {
          const list = await listHelmReleases(kc, ns, cluster);
          if (seq === this.#extraSeq) this.helmReleases = list;
          break;
        }
      }
    } catch (e) {
      if (seq === this.#extraSeq) this.extraError = errorMessage(e);
    } finally {
      if (seq === this.#extraSeq) this.extraLoading = false;
    }
  }

  /** Invalidate in-flight loads and clear data (call before switching cluster). */
  clear(): void {
    this.#loadSeq++;
    this.#extraSeq++;
    this.pods = [];
    this.namespaces = [];
    this.deployments = [];
    this.events = [];
    this.services = [];
    this.ingresses = [];
    this.configmaps = [];
    this.secrets = [];
    this.helmReleases = [];
    this.podMetrics = {};
    this.nodes = [];
    this.metricsAvailable = false;
    this.error = null;
    this.loading = false;
    this.extraError = null;
    this.extraLoading = false;
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
