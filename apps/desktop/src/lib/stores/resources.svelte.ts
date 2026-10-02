/**
 * Resources for the active cluster: pods / namespaces / deployments.
 * List + watch (backend supports only these three kinds today), derived
 * counts, and auto-refresh per settings.refreshInterval.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  clusterCapacity,
  listConfigMaps,
  listCronJobs,
  listDeployments,
  listEvents,
  listHelmReleases,
  listIngresses,
  listJobs,
  listNamespaces,
  listNodes,
  listPods,
  listPodMetrics,
  listPvcs,
  listSecrets,
  listServices,
  listStatefulSets,
  unwatchResources,
  watchResources,
  type ConfigMapInfo,
  type CronJobInfo,
  type DeploymentInfo,
  type EventInfo,
  type HelmReleaseInfo,
  type IngressInfo,
  type JobInfo,
  type NamespaceInfo,
  type NodeCapacityInfo,
  type NodeInfo,
  type PodInfo,
  type PodMetricsInfo,
  type PvcInfo,
  type SecretInfo,
  type StatefulSetInfo,
  type ServiceInfo,
} from "$lib/tauri";
import { errorMessage } from "$lib/errors";
import { isForbiddenError } from "$lib/overview-summary";
import { app } from "./app.svelte";
import { settings } from "./settings.svelte";

const RELOAD_DEBOUNCE_MS = 300;

/** Resource kinds loaded on demand when their view is opened. */
export type ExtraKind =
  | "services"
  | "ingresses"
  | "configmaps"
  | "secrets"
  | "helm"
  | "statefulsets"
  | "jobs"
  | "cronjobs"
  | "pvcs"
  | "nodes";

const EXTRA_KINDS: readonly ExtraKind[] = [
  "services",
  "ingresses",
  "configmaps",
  "secrets",
  "helm",
  "statefulsets",
  "jobs",
  "cronjobs",
  "pvcs",
  "nodes",
];

/** Kinds the Overview resource grid summarizes (plus the node inventory). */
export const OVERVIEW_KINDS: readonly ExtraKind[] = [
  "services",
  "ingresses",
  "configmaps",
  "secrets",
  "helm",
  "nodes",
];

export function isExtraKind(v: unknown): v is ExtraKind {
  return typeof v === "string" && (EXTRA_KINDS as readonly string[]).includes(v);
}

function countByNamespace(pods: PodInfo[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of pods) counts[p.namespace] = (counts[p.namespace] ?? 0) + 1;
  return counts;
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
  statefulsets = $state<StatefulSetInfo[]>([]);
  jobs = $state<JobInfo[]>([]);
  cronjobs = $state<CronJobInfo[]>([]);
  pvcs = $state<PvcInfo[]>([]);
  nodeInventory = $state<NodeInfo[]>([]);
  /** ns/name → usage; null until metrics-server answers, {} when it 404s. */
  podMetrics = $state<Record<string, PodMetricsInfo>>({});
  nodes = $state<NodeCapacityInfo[]>([]);
  /** false when metrics-server is unavailable in the active cluster. */
  metricsAvailable = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);
  extraLoading = $state(false);
  extraError = $state<string | null>(null);

  /**
   * Namespace filter each on-demand kind was last loaded with (null = all).
   * A kind missing here has not been loaded for the active cluster yet.
   */
  loadedKinds = $state<Partial<Record<ExtraKind, string | null>>>({});
  /** On-demand kinds the last load was denied by RBAC (HTTP 403). */
  forbiddenKinds = $state<ReadonlySet<ExtraKind>>(new Set());
  /** Pods per namespace from the last all-namespaces load (drives the ns menu). */
  #allNsPodCounts = $state<Record<string, number> | null>(null);

  #loadSeq = 0;
  #extraSeq = 0;
  #overviewSeq = 0;
  #watchIds: string[] = [];
  #unlisteners: UnlistenFn[] = [];
  #reloadTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshTimer: ReturnType<typeof setInterval> | null = null;

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
      if (ns === null) this.#allNsPodCounts = countByNamespace(podList);
      this.namespaces = nsList;
      this.deployments = depList;
      this.events = eventList;
      void this.#loadMetrics(kc, ns ?? undefined, cluster, seq);
      // Keep the currently open extra view in sync with refresh/watch cycles.
      if (isExtraKind(app.view)) void this.loadKind(app.view);
      else if (app.view === "overview") void this.loadOverviewExtras();
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

  /**
   * Pod count per namespace. Live when viewing all namespaces; otherwise the
   * last all-namespaces snapshot, with the filtered namespace kept live.
   */
  get podCountsByNamespace(): Record<string, number> {
    const live = countByNamespace(this.pods);
    const base = app.namespace === null ? live : this.#allNsPodCounts;
    const counts: Record<string, number> = {};
    // With a full picture, namespaces without pods count as 0.
    if (base) for (const ns of this.namespaces) counts[ns.name] = base[ns.name] ?? 0;
    if (app.namespace !== null) counts[app.namespace] = live[app.namespace] ?? 0;
    return counts;
  }

  /**
   * Item count for an on-demand kind, or null when it has not been loaded
   * for the current cluster + namespace (the sidebar then shows no number).
   */
  kindCount(kind: ExtraKind): number | null {
    const loadedFor = this.loadedKinds[kind];
    if (loadedFor === undefined) return null;
    // Nodes are cluster-scoped; everything else must match the namespace filter.
    if (kind !== "nodes" && loadedFor !== app.namespace) return null;
    const lists: Record<ExtraKind, unknown[]> = {
      services: this.services,
      ingresses: this.ingresses,
      configmaps: this.configmaps,
      secrets: this.secrets,
      helm: this.helmReleases,
      statefulsets: this.statefulsets,
      jobs: this.jobs,
      cronjobs: this.cronjobs,
      pvcs: this.pvcs,
      nodes: this.nodeInventory,
    };
    return lists[kind].length;
  }

  /**
   * Fetch one on-demand kind and return a commit that stores the result, so
   * callers apply it only if their sequence guard still holds.
   */
  async #fetchKind(
    kind: ExtraKind,
    kc: string,
    ns: string | undefined,
    cluster: string,
  ): Promise<() => void> {
    switch (kind) {
      case "services": {
        const list = await listServices(kc, ns, cluster);
        return () => (this.services = list);
      }
      case "ingresses": {
        const list = await listIngresses(kc, ns, cluster);
        return () => (this.ingresses = list);
      }
      case "configmaps": {
        const list = await listConfigMaps(kc, ns, cluster);
        return () => (this.configmaps = list);
      }
      case "secrets": {
        const list = await listSecrets(kc, ns, cluster);
        return () => (this.secrets = list);
      }
      case "helm": {
        const list = await listHelmReleases(kc, ns, cluster);
        return () => (this.helmReleases = list);
      }
      case "statefulsets": {
        const list = await listStatefulSets(kc, ns, cluster);
        return () => (this.statefulsets = list);
      }
      case "jobs": {
        const list = await listJobs(kc, ns, cluster);
        return () => (this.jobs = list);
      }
      case "cronjobs": {
        const list = await listCronJobs(kc, ns, cluster);
        return () => (this.cronjobs = list);
      }
      case "pvcs": {
        const list = await listPvcs(kc, ns, cluster);
        return () => (this.pvcs = list);
      }
      case "nodes": {
        const list = await listNodes(kc, cluster);
        return () => (this.nodeInventory = list);
      }
    }
  }

  /** Record (or clear) an RBAC denial for `kind`. */
  #markForbidden(kind: ExtraKind, forbidden: boolean): void {
    if (this.forbiddenKinds.has(kind) === forbidden) return;
    const others = [...this.forbiddenKinds].filter((k) => k !== kind);
    this.forbiddenKinds = new Set(forbidden ? [...others, kind] : others);
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
      const commit = await this.#fetchKind(kind, kc, ns, cluster);
      if (seq === this.#extraSeq) {
        commit();
        this.loadedKinds = { ...this.loadedKinds, [kind]: ns ?? null };
        this.#markForbidden(kind, false);
      }
    } catch (e) {
      if (seq === this.#extraSeq) {
        this.extraError = errorMessage(e);
        this.#markForbidden(kind, isForbiddenError(this.extraError));
      }
    } finally {
      if (seq === this.#extraSeq) this.extraLoading = false;
    }
  }

  /**
   * Overview resource grid (parity v2 §4): load every kind it summarizes in
   * one settled batch. Failures are best-effort; RBAC denials are recorded
   * in `forbiddenKinds` so the card can say so instead of showing zeros.
   */
  async loadOverviewExtras(): Promise<void> {
    const seq = ++this.#overviewSeq;
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    const ns = app.namespace ?? undefined;
    if (!kc || !cluster) return;

    const results = await Promise.allSettled(
      OVERVIEW_KINDS.map((kind) => this.#fetchKind(kind, kc, ns, cluster)),
    );
    if (seq !== this.#overviewSeq) return;
    const loaded = { ...this.loadedKinds };
    const denied: ExtraKind[] = [];
    const succeeded: ExtraKind[] = [];
    results.forEach((result, i) => {
      const kind = OVERVIEW_KINDS[i];
      if (result.status === "fulfilled") {
        result.value();
        loaded[kind] = ns ?? null;
        succeeded.push(kind);
      } else if (isForbiddenError(errorMessage(result.reason))) {
        denied.push(kind);
      }
    });
    this.loadedKinds = loaded;
    this.forbiddenKinds = new Set([
      ...[...this.forbiddenKinds].filter((k) => !succeeded.includes(k)),
      ...denied,
    ]);
  }

  /** Invalidate in-flight loads and clear data (call before switching cluster). */
  clear(): void {
    this.#loadSeq++;
    this.#extraSeq++;
    this.#overviewSeq++;
    this.pods = [];
    this.namespaces = [];
    this.deployments = [];
    this.events = [];
    this.services = [];
    this.ingresses = [];
    this.configmaps = [];
    this.secrets = [];
    this.helmReleases = [];
    this.statefulsets = [];
    this.jobs = [];
    this.cronjobs = [];
    this.pvcs = [];
    this.nodeInventory = [];
    this.loadedKinds = {};
    this.forbiddenKinds = new Set();
    this.#allNsPodCounts = null;
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
