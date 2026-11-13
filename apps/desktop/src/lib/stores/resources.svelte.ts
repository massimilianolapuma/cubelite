/**
 * Resources for the active cluster: pods / namespaces / deployments.
 * List + watch (backend supports only these three kinds today), derived
 * counts, and auto-refresh per settings.refreshInterval.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { untrack } from "svelte";
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
} from "#lib/tauri.ts";
import { errorMessage } from "#lib/errors.ts";
import { isForbiddenError } from "#lib/overview-summary.ts";
import { isKindView } from "#lib/resource-kinds.ts";
import { needsAttention } from "#lib/status.ts";
import { app } from "./app.svelte";
import { dynamic } from "./dynamic.svelte";
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


/** The lists `load()` fills. */
export type MainList = "pods" | "deployments" | "events";

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
  /**
   * false when metrics-server is unavailable in the active cluster: both the
   * pod metrics and the node capacity answered (node figures need both).
   */
  metricsAvailable = $state(false);
  /**
   * true when metrics-server answered for pods, even if node capacity was
   * refused (a user who may not list nodes still has pod usage).
   */
  podMetricsAvailable = $state(false);
  /** metrics-server has answered or failed once for the active cluster. */
  metricsKnown = $state(false);
  loading = $state(false);
  /** Message of the last failed `load()`; kept until a load succeeds. */
  error = $state<string | null>(null);
  extraLoading = $state(false);
  extraError = $state<string | null>(null);
  /** The kind `extraError` belongs to, and the namespace filter it was loaded with. */
  #extraErrorKind = $state<ExtraKind | null>(null);
  #extraErrorFor = $state<string | null>(null);
  /**
   * What failed in the last `load()`, per list, and the namespace filter it
   * ran with. One list failing is not the others' failure: RBAC can allow
   * pods and refuse deployments.
   */
  #listErrors = $state<{ ns: string | null } & Record<MainList, string | null>>({
    ns: null,
    pods: null,
    deployments: null,
    events: null,
  });
  /**
   * Namespace filter pods, deployments and events were last loaded with
   * (null = all); undefined until the first load of the active cluster.
   */
  #mainLoadedFor = $state<string | null | undefined>(undefined);

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
    return this.pods.filter(needsAttention);
  }

  /** Warning-type events (drives the sidebar and top-bar counts and Overview). */
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
    try {
      const failure = (r: PromiseSettledResult<unknown>) =>
        r.status === "rejected" ? errorMessage(r.reason) : null;
      // Each list answers for itself: a refusal of one is not the others' failure.
      const [podsR, nsR, eventsR] = await Promise.allSettled([
        listPods(kc, ns ?? undefined, cluster),
        listNamespaces(kc, cluster),
        listEvents(kc, ns ?? undefined, cluster),
      ]);
      const deps = await this.#loadDeployments(kc, ns, cluster, nsR);

      if (seq !== this.#loadSeq) return true;
      if (podsR.status === "fulfilled") {
        this.pods = podsR.value;
        if (ns === null) this.#allNsPodCounts = countByNamespace(podsR.value);
      }
      if (nsR.status === "fulfilled") this.namespaces = nsR.value;
      if (deps.rows) this.deployments = deps.rows;
      if (eventsR.status === "fulfilled") this.events = eventsR.value;
      this.#listErrors = { ns, pods: failure(podsR), deployments: deps.error, events: failure(eventsR) };
      // Every list now has an answer for `ns`: its rows or its error.
      this.#mainLoadedFor = ns;
      // Pods and namespaces are what "the cluster answered" means.
      this.error = failure(podsR) ?? failure(nsR);
      if (this.error !== null) return false;
      void this.#loadMetrics(kc, ns ?? undefined, cluster, seq);
      // Keep the currently open extra view in sync with refresh/watch cycles.
      if (isExtraKind(app.view)) void this.loadKind(app.view);
      else if (isKindView(app.view)) void dynamic.load(app.view);
      else if (app.view === "overview") void this.loadOverviewExtras();
      return true;
    } finally {
      if (seq === this.#loadSeq) this.loading = false;
    }
  }

  /**
   * list_deployments requires a namespace: with "all namespaces" it fans out
   * over them. Some namespaces refusing leaves the rows of the others; every
   * namespace refusing (or no namespace list to fan out over) is a failed
   * list, not an empty one.
   */
  async #loadDeployments(
    kc: string,
    ns: string | null,
    cluster: string,
    namespaces: PromiseSettledResult<NamespaceInfo[]>,
  ): Promise<{ rows: DeploymentInfo[] | null; error: string | null }> {
    if (ns !== null) {
      try {
        return { rows: await listDeployments(kc, ns, cluster), error: null };
      } catch (e) {
        return { rows: null, error: errorMessage(e) };
      }
    }
    if (namespaces.status === "rejected") return { rows: null, error: errorMessage(namespaces.reason) };
    const settled = await Promise.allSettled(namespaces.value.map((n) => listDeployments(kc, n.name, cluster)));
    const refused = settled.find((r) => r.status === "rejected");
    if (refused && settled.every((r) => r.status === "rejected")) {
      return { rows: null, error: errorMessage(refused.reason) };
    }
    return { rows: settled.flatMap((r) => (r.status === "fulfilled" ? r.value : [])), error: null };
  }

  /** Metrics are best-effort: absence of metrics-server must not fail load(). */
  async #loadMetrics(
    kc: string,
    ns: string | undefined,
    cluster: string,
    seq: number,
  ): Promise<void> {
    // Settled apart: node capacity lists nodes first, and a refusal there
    // must not take the pods' usage with it.
    const [podsR, nodesR] = await Promise.allSettled([
      listPodMetrics(kc, ns, cluster),
      clusterCapacity(kc, cluster),
    ]);
    if (seq !== this.#loadSeq) return;
    const map: Record<string, PodMetricsInfo> = {};
    if (podsR.status === "fulfilled") {
      for (const m of podsR.value) map[`${m.namespace}/${m.name}`] = m;
    }
    const both = podsR.status === "fulfilled" && nodesR.status === "fulfilled";
    this.podMetrics = map;
    this.nodes = both ? nodesR.value : [];
    this.podMetricsAvailable = podsR.status === "fulfilled";
    this.metricsAvailable = both;
    this.metricsKnown = true;
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
   * Pods, deployments and events are loaded for the current cluster and
   * namespace. False during the first load and after a namespace change, so a
   * list shows its loading state instead of nothing or another namespace's rows.
   */
  get mainLoaded(): boolean {
    return this.#mainLoadedFor !== undefined && this.#mainLoadedFor === app.namespace;
  }

  /**
   * Message of a main list's last failed load, if it failed for the current
   * namespace. An error of another namespace is not shown under this one's
   * name: the list is then loading.
   */
  listError(list: MainList): string | null {
    return this.#listErrors.ns === app.namespace ? this.#listErrors[list] : null;
  }

  /** An on-demand kind is loaded for the current cluster and namespace. */
  kindLoaded(kind: ExtraKind): boolean {
    return this.kindCount(kind) !== null;
  }

  /** Message of `kind`'s last failed load, if its last load failed. */
  kindError(kind: ExtraKind): string | null {
    if (this.#extraErrorKind !== kind) return null;
    // Nodes are cluster-scoped; any other kind's error belongs to its namespace.
    if (kind !== "nodes" && this.#extraErrorFor !== app.namespace) return null;
    return this.extraError;
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
    // Another kind's error is not this one's; this kind's stays until it loads.
    // Views call loadKind() from an effect: this read must not subscribe it.
    untrack(() => {
      if (this.#extraErrorKind !== kind) this.extraError = null;
    });
    try {
      const commit = await this.#fetchKind(kind, kc, ns, cluster);
      if (seq === this.#extraSeq) {
        commit();
        this.extraError = null;
        this.loadedKinds = { ...this.loadedKinds, [kind]: ns ?? null };
        this.#markForbidden(kind, false);
      }
    } catch (e) {
      if (seq === this.#extraSeq) {
        this.extraError = errorMessage(e);
        this.#extraErrorKind = kind;
        this.#extraErrorFor = ns ?? null;
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
    // A batch for a namespace the user has left must not replace what a later
    // load of the new one committed (it would mark those kinds not loaded).
    if (seq !== this.#overviewSeq || (app.namespace ?? undefined) !== ns) return;
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
    dynamic.clear();
    this.podMetrics = {};
    this.nodes = [];
    this.metricsAvailable = false;
    this.podMetricsAvailable = false;
    this.metricsKnown = false;
    this.error = null;
    this.loading = false;
    this.extraError = null;
    this.#extraErrorKind = null;
    this.#extraErrorFor = null;
    this.#listErrors = { ns: null, pods: null, deployments: null, events: null };
    this.#mainLoadedFor = undefined;
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
