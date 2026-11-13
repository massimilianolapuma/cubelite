/**
 * Browser-side mock of the Tauri v2 IPC layer (`window.__TAURI_INTERNALS__`)
 * with deterministic cluster fixtures. Injected via `page.addInitScript`
 * before the app boots, so `@tauri-apps/api` calls resolve without a Rust
 * backend.
 */
import type { Page } from "@playwright/test";
import type { DeploymentInfo, Finding, ResourceFacts } from "../../src/lib/tauri.ts";

declare global {
  interface Window {
    /** Test hook installed by the mock script: fires a Tauri event to every
     * listener registered for `name` via `@tauri-apps/api/event`'s `listen`. */
    __emitTauriEvent?: (name: string, payload: unknown) => void;
    /** Test hook: looks up the stream id the mock last handed out for a
     * `stream_pod_log` call with this container name (see `emitPodLogLine`). */
    __streamIdFor?: (container: string) => string | null;
    /** Test hook: arguments of the last `start_exec` call. */
    __lastExec?: Record<string, unknown>;
    /** Test hook: every `exec_send` payload, in order. */
    __execSent?: string[];
    __lastElasticSearch?: Record<string, unknown>;
    __kibanaOpened?: Record<string, unknown>;
    __kibanaForwards?: number;
    __lastPromMetrics?: Record<string, unknown>;
    __grafanaOpened?: Record<string, unknown>;
    __grafanaForwards?: Record<string, unknown>[];
    /** Test hook: arguments of the last `apply_resource_yaml` call. */
    __lastApply?: Record<string, unknown>;
    /** Test hook: arguments of the last `apply_resources` call, dry run or not. */
    __lastResourcesApply?: Record<string, unknown>;
    /** Test hook: the arguments of every `apply_resources` call, in order. */
    __resourcesApplies?: Record<string, unknown>[];
    /** Test hook: arguments of the last `clear_resources_override` call. */
    __lastClearOverride?: Record<string, unknown>;
    /** Test hook: what `integrations_detect` finds (#527); null = nothing. */
    __detectedIntegrations?: Record<string, unknown>;
    /** Test hook: every integration command the banner's Enable sent, in order. */
    __integrationCalls?: { cmd: string; args: Record<string, unknown> }[];
  }
}

const Mi = 1024 * 1024;
const Gi = 1024 * Mi;
const quantity = (text: string, amount: number | null) => ({ text, amount });

/** Requests and limits of the worker container: cpu 250m / 500m, memory 256Mi / 512Mi. */
const WORKER_RESOURCES = {
  cpu: { request: quantity("250m", 250), limit: quantity("500m", 500) },
  memory: { request: quantity("256Mi", 256 * Mi), limit: quantity("512Mi", 512 * Mi) },
};

/** Requests only, no limit: envoy, the sidecar. */
const ENVOY_RESOURCES = {
  cpu: { request: quantity("100m", 100), limit: null },
  memory: { request: quantity("64Mi", 64 * Mi), limit: null },
};

type QuantityFixture = { text: string; amount: number | null };
type PairFixture = { request: QuantityFixture | null; limit: QuantityFixture | null };
/** A pod's container as `list_pods` sends it; `resources` is absent in an older payload. */
type ContainerFixture = { name: string; image: string; ready: boolean; resources?: { cpu: PairFixture; memory: PairFixture } };

type PodMetricsFixture = {
  name: string;
  namespace: string;
  cpu_millis: number;
  memory_bytes: number;
  containers?: { name: string; cpu_millis: number; memory_bytes: number }[];
};

/** Usage of api-0 with its worker close to its memory limit (498Mi of 512Mi). */
export const API_0_METRICS: PodMetricsFixture = {
  name: "api-0",
  namespace: "default",
  cpu_millis: 298,
  memory_bytes: 539 * Mi,
  containers: [
    { name: "worker", cpu_millis: 260, memory_bytes: 498 * Mi },
    { name: "envoy", cpu_millis: 38, memory_bytes: 41 * Mi },
  ],
};

/** No requests, no limits: the plain init container of the pod. */
const NO_RESOURCES = {
  cpu: { request: null, limit: null },
  memory: { request: null, limit: null },
};

/** One pod of `default/api` as the scheduler counts it: worker plus the envoy sidecar. */
const API_POD_FIGURES = {
  request: { cpu_millis: 350, memory_bytes: 320 * Mi },
  // envoy has no limit: the pod has none.
  cpu_limit: null,
  memory_limit: null,
  set_limits: { cpu_millis: 500, memory_bytes: 512 * Mi },
};

/**
 * What `resource_facts` reads for `default/api`: the deployment fixture's
 * containers with the same texts (worker, then envoy as a native sidecar, and
 * the pod's plain init container), 2 replicas rolling 1 / 0, both pods on
 * node-1 (api-0 with the usage of API_0_METRICS, so the editor's "Now" agrees
 * with the panel), node-2 with none of them, and no LimitRange, quota, HPA or
 * VPA. Memory limits on node-1 are at 91%: 768Mi for the worker still fits
 * (97%), 1Gi does not (103%).
 */
const API_RESOURCE_FACTS: ResourceFacts = {
  workload: {
    namespace: "default",
    name: "api",
    resource_version: "812",
    generation: 4,
    replicas: 2,
    rollout: { recreate: false, max_surge: 1, max_unavailable: 0 },
    containers: [{ name: "worker", image: "ghcr.io/x/worker:2.1", sidecar: false, resources: WORKER_RESOURCES }],
    init_containers: [
      { name: "envoy", image: "ghcr.io/x/envoy:1.29", sidecar: true, resources: ENVOY_RESOURCES },
      { name: "init-migrate", image: "ghcr.io/x/init-migrate:1.0", sidecar: false, resources: NO_RESOURCES },
    ],
    overhead: { cpu_millis: 0, memory_bytes: 0 },
    manager: { kind: "none", release: null },
    override_annotation: null,
  },
  seen: {
    generation: 4,
    resources: { worker: WORKER_RESOURCES, envoy: ENVOY_RESOURCES, "init-migrate": NO_RESOURCES },
    override_annotation: null,
  },
  pods: [
    { name: "api-0", node: "node-1", figures: API_POD_FIGURES, usage: API_0_METRICS.containers ?? [] },
    {
      name: "api-1",
      node: "node-1",
      figures: API_POD_FIGURES,
      usage: [
        { name: "worker", cpu_millis: 180, memory_bytes: 300 * Mi },
        { name: "envoy", cpu_millis: 30, memory_bytes: 30 * Mi },
      ],
    },
  ],
  usage: { state: "known", value: null },
  nodes: {
    state: "known",
    value: [
      {
        name: "node-1",
        schedulable: true,
        allocatable: { cpu_millis: 4000, memory_bytes: 8 * Gi },
        others_requests: { cpu_millis: 1800, memory_bytes: 4 * Gi },
        others_cpu_limits: 2500,
        others_memory_limits: 6400 * Mi,
        memory_used: 5 * Gi,
      },
      {
        name: "node-2",
        schedulable: true,
        allocatable: { cpu_millis: 4000, memory_bytes: 8 * Gi },
        others_requests: { cpu_millis: 1000, memory_bytes: 2 * Gi },
        others_cpu_limits: 2000,
        others_memory_limits: 3 * Gi,
        memory_used: 3 * Gi,
      },
    ],
  },
  limit_ranges: { state: "known", value: [] },
  quotas: { state: "known", value: [] },
  hpas: { state: "known", value: [] },
  vpas: { state: "known", value: [] },
};

const ABOUT_NOTHING = { container: null, resource: null, field: null, node: null };

/**
 * The findings `evaluate_resources` answers for a typed value, keyed
 * "{container}/{resource}.{field}={text}": a blocked value, a warning (the
 * x2 quick step on the worker's memory limit) and a not-checked finding (the
 * +50% quick step on its CPU limit). Any other change only fits.
 */
const RESOURCE_FINDINGS: Record<string, Finding[]> = {
  "worker/memory.limit=128Mi": [
    {
      code: "b3",
      level: "blocked",
      message: "The limit (128Mi) is under the request (256Mi).",
      ...ABOUT_NOTHING,
      container: "worker",
      resource: "memory",
      field: "limit",
    },
  ],
  "worker/memory.limit=1Gi": [
    {
      code: "w2",
      level: "warning",
      message:
        "Memory limits on node-1 add up to 103% of what the node has (was 91%). Under memory pressure the node evicts pods.",
      ...ABOUT_NOTHING,
      resource: "memory",
      node: "node-1",
    },
  ],
  "worker/cpu.limit=750m": [
    {
      code: "w9",
      level: "not_checked",
      message: "Not checked: namespace quota (not allowed to read ResourceQuota).",
      ...ABOUT_NOTHING,
    },
  ],
};

export const FIXTURES = {
  // Discovery (resource-kinds phase 2): every registry kind except Storage Classes.
  resourceKinds: [
    { group: "", version: "v1", kind: "Namespace", plural: "namespaces", namespaced: false, short_names: [] },
    { group: "apps", version: "v1", kind: "DaemonSet", plural: "daemonsets", namespaced: true, short_names: [] },
    { group: "apps", version: "v1", kind: "ReplicaSet", plural: "replicasets", namespaced: true, short_names: [] },
    { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler", plural: "horizontalpodautoscalers", namespaced: true, short_names: [] },
    { group: "networking.k8s.io", version: "v1", kind: "IngressClass", plural: "ingressclasses", namespaced: false, short_names: [] },
    { group: "discovery.k8s.io", version: "v1", kind: "EndpointSlice", plural: "endpointslices", namespaced: true, short_names: [] },
    { group: "networking.k8s.io", version: "v1", kind: "NetworkPolicy", plural: "networkpolicies", namespaced: true, short_names: [] },
    { group: "", version: "v1", kind: "PersistentVolume", plural: "persistentvolumes", namespaced: false, short_names: [] },
    { group: "", version: "v1", kind: "ResourceQuota", plural: "resourcequotas", namespaced: true, short_names: [] },
    { group: "", version: "v1", kind: "LimitRange", plural: "limitranges", namespaced: true, short_names: [] },
    { group: "policy", version: "v1", kind: "PodDisruptionBudget", plural: "poddisruptionbudgets", namespaced: true, short_names: [] },
    { group: "scheduling.k8s.io", version: "v1", kind: "PriorityClass", plural: "priorityclasses", namespaced: false, short_names: [] },
    { group: "", version: "v1", kind: "ServiceAccount", plural: "serviceaccounts", namespaced: true, short_names: [] },
    { group: "rbac.authorization.k8s.io", version: "v1", kind: "Role", plural: "roles", namespaced: true, short_names: [] },
    { group: "rbac.authorization.k8s.io", version: "v1", kind: "RoleBinding", plural: "rolebindings", namespaced: true, short_names: [] },
    { group: "rbac.authorization.k8s.io", version: "v1", kind: "ClusterRole", plural: "clusterroles", namespaced: false, short_names: [] },
    { group: "rbac.authorization.k8s.io", version: "v1", kind: "ClusterRoleBinding", plural: "clusterrolebindings", namespaced: false, short_names: [] },
    // Custom kinds (resource-kinds phase 5).
    { group: "monitoring.coreos.com", version: "v1", kind: "ServiceMonitor", plural: "servicemonitors", namespaced: true, short_names: ["smon"] },
    { group: "monitoring.coreos.com", version: "v1", kind: "PodMonitor", plural: "podmonitors", namespaced: true, short_names: ["pmon"] },
    { group: "monitoring.coreos.com", version: "v1", kind: "PrometheusRule", plural: "prometheusrules", namespaced: true, short_names: ["promrule"] },
    { group: "elasticsearch.k8s.elastic.co", version: "v1", kind: "Elasticsearch", plural: "elasticsearches", namespaced: true, short_names: ["es"] },
  ],
  daemonSetTable: {
    columns: [
      { name: "Name", column_type: "string", format: "name", description: "" },
      { name: "Desired", column_type: "integer", format: "", description: "" },
      { name: "Node Selector", column_type: "string", format: "", description: "" },
      { name: "Age", column_type: "date", format: "", description: "" },
    ],
    rows: [
      {
        name: "fluent-bit",
        namespace: "logging",
        creation_timestamp: "2026-11-01T00:00:00Z",
        cells: ["fluent-bit", 3, "kubernetes.io/os=linux", "2026-11-01T00:00:00Z"],
      },
    ],
  },
  contexts: [
    { name: "prod-aks", cluster_server: "https://prod.azmk8s.io:443", namespace: "default", is_active: true, source: "/home/test/.kube/config" },
    { name: "staging", cluster_server: "https://staging:6443", namespace: "default", is_active: false, source: "/home/test/.kube/team.yaml" },
  ],
  kubeconfig: {
    origin: "env",
    spec: "/home/test/.kube/config:/home/test/.kube/team.yaml",
    sources: [
      { path: "/home/test/.kube/config", exists: true, contexts: 1, shadowed: [] },
      { path: "/home/test/.kube/team.yaml", exists: true, contexts: 1, shadowed: ["prod-aks"] },
    ],
  },
  extraKubeconfig: { path: "/home/test/.kube/extra.yaml", exists: true, contexts: 1, shadowed: [] },
  extraContext: { name: "extra", cluster_server: "https://extra:6443", namespace: "default", is_active: false, source: "/home/test/.kube/extra.yaml" },
  pods: [
    {
      name: "api-0",
      namespace: "default",
      phase: "Running",
      ready: true,
      restarts: 0,
      ready_containers: 3,
      total_containers: 3,
      node: "node-1",
      pod_ip: "10.0.0.5",
      qos_class: "Burstable",
      containers: [
        { name: "worker", image: "ghcr.io/x/worker:2.1", ready: true, resources: WORKER_RESOURCES },
        { name: "envoy", image: "ghcr.io/x/envoy:1.29", ready: true, resources: ENVOY_RESOURCES },
        { name: "init-migrate", image: "ghcr.io/x/init-migrate:1.0", ready: true },
      ] as ContainerFixture[],
      labels: { app: "api" },
      creation_timestamp: "2026-07-10T09:00:00Z",
      // Controlled by a ReplicaSet of the api deployment.
      deployment: "api",
    },
    {
      name: "worker-0",
      namespace: "default",
      phase: "Pending",
      ready: false,
      restarts: 5,
      ready_containers: 0,
      total_containers: 1,
      node: null,
      pod_ip: null,
      qos_class: null,
      containers: [{ name: "worker", image: "ghcr.io/x/worker:2.1", ready: false }] as ContainerFixture[],
      labels: { app: "worker" },
      creation_timestamp: "2026-07-11T08:00:00Z",
    },
  ],
  namespaces: [
    { name: "default", phase: "Active" },
    { name: "kube-system", phase: "Active" },
  ],
  deployments: [
    {
      name: "api",
      namespace: "default",
      replicas: 2,
      ready_replicas: 2,
      images: ["ghcr.io/x/api:2.1"],
      selector: { app: "api" },
      strategy: "RollingUpdate",
      conditions: [{ condition_type: "Available", status: "True", reason: "MinimumReplicasAvailable" }],
      creation_timestamp: "2026-07-01T09:00:00Z",
      // The template's containers with their requests and limits (#652): the
      // worker the pods run, then envoy as a native sidecar.
      containers: [
        { name: "worker", image: "ghcr.io/x/worker:2.1", sidecar: false, resources: WORKER_RESOURCES },
        { name: "envoy", image: "ghcr.io/x/envoy:1.29", sidecar: true, resources: ENVOY_RESOURCES },
      ],
    },
  ] as DeploymentInfo[],
  /**
   * What `list_pod_metrics` answers: by default metrics-server answers with no
   * sample; null is metrics-server not answering (the command fails).
   */
  podMetrics: [] as PodMetricsFixture[] | null,
  /** What `cluster_capacity` answers; null is the call refused (a user who may not list nodes). */
  nodeCapacity: [] as unknown[] | null,
  /** What `list_events` answers (Overview's recent warnings, the Events list). */
  events: [] as {
    event_type: string | null;
    reason: string | null;
    object: string;
    message: string | null;
    namespace: string;
    count: number;
    last_timestamp: string | null;
  }[],
  /**
   * Per-context answers of `probe_cluster`, merged over `{ context }`: a context
   * listed here answers this instead of the default (staging unreachable,
   * everything else reachable).
   */
  probes: {} as Record<string, Record<string, unknown>>,
  podContainers: [
    {
      name: "worker",
      init: false,
      sidecar: false,
      restarts: 3,
      ready: true,
      state: "running",
      state_reason: null,
      last_terminated_reason: null,
      last_terminated_at: null,
    },
    {
      name: "envoy",
      init: false,
      sidecar: false,
      restarts: 0,
      ready: true,
      state: "running",
      state_reason: null,
      last_terminated_reason: null,
      last_terminated_at: null,
    },
    {
      name: "init-migrate",
      init: true,
      sidecar: false,
      restarts: 0,
      ready: true,
      state: "terminated",
      state_reason: null,
      last_terminated_reason: null,
      last_terminated_at: null,
    },
  ],
  /**
   * What `resource_facts` answers for `default/api`; null makes it fail as a
   * user who may not list pods. `apply_resources` writes into it, so the
   * editor reopened after an apply reads the new values.
   */
  resourceFacts: API_RESOURCE_FACTS as ResourceFacts | null,
  /** Findings of `evaluate_resources` per typed value; see RESOURCE_FINDINGS. */
  resourceFindings: RESOURCE_FINDINGS,
  /** When set, `apply_resources` with `dryRun` fails with this message. */
  dryRunError: null as string | null,
  /** When set, the real `apply_resources` fails with this message. */
  applyError: null as string | null,
  /** When set, `clear_resources_override` fails with this message. */
  clearOverrideError: null as string | null,
  /**
   * When true, `evaluate_resources` compares amounts as the core does (`0.5`
   * is `500m`, `1024Mi` is `1Gi`); otherwise texts, which is enough elsewhere.
   */
  compareAmounts: false,
};

/** Serializable init script installing the IPC mock; `overrides` replace fixtures by key. */
export function tauriMockScript(overrides: Partial<typeof FIXTURES> = {}): string {
  const fixtures = JSON.stringify({ ...FIXTURES, ...overrides });
  return `
(() => {
  const fixtures = ${fixtures};
  let callbackId = 1;
  // stream_pod_log id counter + the container each id was last handed out
  // for, so tests can target the right sub-stream in merged ("all
  // containers") mode, where LogSession opens one ContainerStream per
  // container and each gets its own stream id.
  let streamIdCounter = 1;
  const streamIdsByContainer = {};
  // Last custom kubeconfig list handed to kubeconfig_sources (null = defaults).
  let customSpec = null;

  // --- The resources commands (resource_facts, evaluate_resources,
  // apply_resources, clear_resources_override): a stand-in for the core's
  // check, driven by fixtures.resourceFindings, and an apply that writes into
  // the deployment and facts fixtures so later reads show the outcome.
  const FIELDS = [["cpu", "request"], ["cpu", "limit"], ["memory", "request"], ["memory", "limit"]];
  const LEVELS = ["blocked", "warning", "not_checked", "note"];
  const UNITS = { "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  // The amount of the plain quantities the e2e types (millicores, bytes); null otherwise.
  const amountOf = (resource, text) => {
    if (text === null || text === undefined) return null;
    if (resource === "cpu") {
      const m = /^(\\d+(?:\\.\\d+)?)(m?)$/.exec(text.trim());
      return m ? Number(m[1]) * (m[2] ? 1 : 1000) : null;
    }
    const m = /^(\\d+(?:\\.\\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(text.trim());
    return m ? Number(m[1]) * UNITS[m[2] ?? ""] : null;
  };
  const textsOf = (r) => ({
    cpu: { request: r.cpu.request?.text ?? null, limit: r.cpu.limit?.text ?? null },
    memory: { request: r.memory.request?.text ?? null, limit: r.memory.limit?.text ?? null },
  });
  const infoOf = (t) => {
    const one = (resource, text) => (text === null ? null : { text, amount: amountOf(resource, text) });
    return {
      cpu: { request: one("cpu", t.cpu.request), limit: one("cpu", t.cpu.limit) },
      memory: { request: one("memory", t.memory.request), limit: one("memory", t.memory.limit) },
    };
  };
  const editable = (facts) => [
    ...facts.workload.containers,
    ...facts.workload.init_containers.filter((c) => c.sidecar),
  ];
  const markOf = (facts) => (facts.workload.override_annotation ? JSON.parse(facts.workload.override_annotation) : null);
  // Container name -> the texts the proposal wants: the typed ones, or the mark's originals for a restore.
  const wanted = (facts, proposal) => {
    const want = {};
    if (proposal.kind === "restore") {
      const mark = markOf(facts);
      for (const [name, entry] of Object.entries(mark ? mark.containers : {})) want[name] = entry.original;
    } else {
      for (const c of proposal.containers) want[c.name] = c.resources;
    }
    return want;
  };
  const percent = (part, total) => (total > 0 ? Math.round((part * 100) / total) : 0);
  const project = (facts, want, changes) => {
    if (facts.nodes.state !== "known") return [];
    // A pod's memory limits as a node adds them up after the change (an unset limit counts 0).
    let readable = true;
    const podLimit = editable(facts).reduce((sum, c) => {
      const text = want[c.name] ? want[c.name].memory.limit : c.resources.memory.limit?.text ?? null;
      const amount = amountOf("memory", text);
      if (text !== null && amount === null) readable = false;
      return sum + (amount ?? 0);
    }, 0);
    const moved = readable && changes.some((ch) => ch.resource === "memory" && ch.field === "limit");
    const same = (value) => ({ before: value, after: value });
    const rows = facts.nodes.value.map((n) => {
      const own = facts.pods.filter((p) => p.node === n.name);
      const sum = (pick) => own.reduce((s, p) => s + pick(p), 0);
      const cpu = n.allocatable.cpu_millis;
      const memory = n.allocatable.memory_bytes;
      const limitsBefore = n.others_memory_limits + sum((p) => p.figures.set_limits.memory_bytes);
      const limitsAfter = moved ? n.others_memory_limits + own.length * podLimit : limitsBefore;
      let ifFull = null;
      if (facts.usage.state === "known" && n.memory_used !== null) {
        const inUse = sum((p) => p.usage.reduce((s, u) => s + u.memory_bytes, 0));
        const full = moved ? n.memory_used - inUse + own.length * podLimit : n.memory_used;
        ifFull = { before: percent(n.memory_used, memory), after: percent(full, memory) };
      }
      return {
        name: n.name,
        schedulable: n.schedulable,
        own_pods: own.length,
        cpu_requests: same(percent(n.others_requests.cpu_millis + sum((p) => p.figures.request.cpu_millis), cpu)),
        memory_requests: same(percent(n.others_requests.memory_bytes + sum((p) => p.figures.request.memory_bytes), memory)),
        cpu_limits: same(percent(n.others_cpu_limits + sum((p) => p.figures.set_limits.cpu_millis), cpu)),
        memory_limits: { before: percent(limitsBefore, memory), after: percent(limitsAfter, memory) },
        memory_if_full: ifFull,
      };
    });
    return [...rows.filter((r) => r.own_pods > 0), ...rows.filter((r) => r.own_pods === 0)];
  };
  const evaluate = (facts, proposal) => {
    const want = wanted(facts, proposal);
    const changes = [];
    const findings = [];
    for (const c of editable(facts)) {
      const after = want[c.name];
      if (!after) continue;
      const before = textsOf(c.resources);
      for (const [resource, field] of FIELDS) {
        if (before[resource][field] === after[resource][field]) continue;
        if (fixtures.compareAmounts) {
          const a = amountOf(resource, before[resource][field]);
          if (a !== null && a === amountOf(resource, after[resource][field])) continue;
        }
        changes.push({ container: c.name, sidecar: c.sidecar, resource, field, before: before[resource][field], after: after[resource][field] });
        const key = c.name + "/" + resource + "." + field + "=" + after[resource][field];
        findings.push(...(fixtures.resourceFindings[key] ?? []));
      }
    }
    if (!findings.length) {
      const r = facts.workload.replicas;
      findings.push({ code: "note_fits", level: "note", message: "Fits: " + r + " of " + r + " replicas have room by their requests.", container: null, resource: null, field: null, node: null });
    }
    findings.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
    return { findings, changes, nodes: project(facts, want, changes) };
  };
  const deploymentOf = (namespace, name) => fixtures.deployments.find((d) => d.namespace === namespace && d.name === name);
  const factsOf = (namespace, name) => {
    const facts = fixtures.resourceFacts;
    if (facts === null) throw new Error("pods is forbidden: User cannot list resource pods");
    if (facts.workload.namespace !== namespace || facts.workload.name !== name) {
      throw new Error('deployments.apps "' + name + '" not found');
    }
    return facts;
  };
  // The apply itself: new texts in the facts and the deployment, and the override mark
  // (the first original kept, applied replaced); a restore puts the originals back and drops it.
  const commit = (facts, proposal) => {
    const deployment = deploymentOf(facts.workload.namespace, facts.workload.name);
    const want = wanted(facts, proposal);
    const mark = markOf(facts);
    const marked = mark && proposal.kind === "adjust" ? mark.containers : {};
    for (const c of editable(facts)) {
      const texts = want[c.name];
      if (!texts) continue;
      const now = textsOf(c.resources);
      if (JSON.stringify(now) === JSON.stringify(texts)) continue;
      if (proposal.kind === "adjust") marked[c.name] = { original: marked[c.name]?.original ?? now, applied: texts };
      c.resources = infoOf(texts);
      facts.seen.resources[c.name] = c.resources;
      const shown = deployment?.containers?.find((d) => d.name === c.name);
      if (shown) shown.resources = c.resources;
    }
    const names = Object.keys(marked).sort();
    const at = new Date().toISOString();
    facts.workload.override_annotation = names.length ? JSON.stringify({ v: 1, at, containers: marked }) : null;
    facts.seen.override_annotation = facts.workload.override_annotation;
    facts.workload.generation += 1;
    facts.seen.generation = facts.workload.generation;
    if (deployment) {
      deployment.resources_override = names.length
        ? { at, containers: names.map((name) => ({ name, original: marked[name].original, applied: marked[name].applied })) }
        : null;
    }
  };

  const responses = (cmd, args) => {
    switch (cmd) {
      case "kubeconfig_sources": {
        const custom = Array.isArray(args.customPaths) ? args.customPaths : [];
        if (!custom.length) {
          customSpec = null;
          return fixtures.kubeconfig;
        }
        customSpec = custom;
        return {
          spec: custom.join(":"),
          origin: "custom",
          sources: custom.map((p) => fixtures.kubeconfig.sources.find((s) => s.path === p) ?? fixtures.extraKubeconfig),
        };
      }
      case "list_contexts":
        return customSpec && customSpec.includes(fixtures.extraKubeconfig.path)
          ? [...fixtures.contexts, fixtures.extraContext]
          : fixtures.contexts;
      case "get_current_context": return "prod-aks";
      case "set_context": {
        fixtures.contexts = fixtures.contexts.map((c) => ({ ...c, is_active: c.name === args.contextName }));
        return null;
      }
      case "list_pods": return args.namespace && args.namespace !== "default" ? [] : fixtures.pods;
      case "list_namespaces": return fixtures.namespaces;
      case "list_deployments": return args.namespace === "default" ? fixtures.deployments : [];
      case "list_events": return fixtures.events;
      case "list_pod_metrics":
        if (fixtures.podMetrics === null) throw new Error("the server could not find the requested resource");
        return fixtures.podMetrics;
      case "cluster_capacity":
        if (fixtures.nodeCapacity === null) throw new Error("nodes is forbidden: User cannot list resource nodes");
        return fixtures.nodeCapacity;
      case "list_services":
      case "list_ingresses":
      case "list_configmaps":
      case "list_secrets":
      case "list_helm_releases":
      case "list_jobs":
      case "list_cronjobs":
      case "list_statefulsets":
      case "list_pvcs":
        return [];
      case "list_nodes":
        return [{ name: "node-1", status: "NotReady", roles: ["worker"], version: "v1.30.2", creation_timestamp: null }];
      case "list_daemonsets":
        return [{ name: "node-agent", namespace: "default" }];
      case "probe_cluster":
        if (fixtures.probes[args.context]) return { context: args.context, ...fixtures.probes[args.context] };
        return args.context === "staging"
          ? { context: args.context, reachable: false, version: null, node_count: null, pod_count: null, issue_pod_count: null, capacity: null, error: "connection timed out" }
          : { context: args.context, reachable: true, version: "v1.30.2", node_count: 3, pod_count: 12, issue_pod_count: 0, capacity: { cpu_used_millis: 400, cpu_allocatable_millis: 4000, memory_used_bytes: 2147483648, memory_allocatable_bytes: 8589934592 }, error: null };
      case "watch_resources": return "w1";
      case "unwatch_resources": return null;
      case "watch_kubeconfig": return "kw1";
      case "unwatch_kubeconfig": return null;
      case "stream_logs": return "l1";
      case "stop_logs": return null;
      case "get_pod_containers": return fixtures.podContainers;
      case "stream_pod_log": {
        const id = String(streamIdCounter++);
        streamIdsByContainer[args.container ?? ""] = id;
        return id;
      }
      case "export_log": return "/home/test/Downloads/" + args.filename;
      case "get_resource_yaml": return "kind: Pod\\nmetadata:\\n  name: " + args.name + "\\n";
      case "start_exec": {
        window.__lastExec = args;
        return null;
      }
      case "exec_send": {
        window.__execSent = [...(window.__execSent ?? []), args.data];
        return null;
      }
      case "stop_exec": return null;
      case "elastic_search": {
        window.__lastElasticSearch = args;
        return {
          total: 2,
          totalIsLowerBound: false,
          next: null,
          lines: [
            { time: "2026-11-03T08:00:02Z", level: "error", message: "e2e-history-newest", container: "worker",
              document: JSON.stringify({ "@timestamp": "2026-11-03T08:00:02Z", message: "e2e-history-newest", log: { level: "error" }, service: { name: "shop-api" }, ecs: { version: "8.11.0" } }) },
            { time: "2026-11-03T08:00:01Z", level: "info", message: "e2e-history-older", container: "worker",
              document: JSON.stringify({ "@timestamp": "2026-11-03T08:00:01Z", message: "e2e-history-older" }) },
          ],
        };
      }
      case "elastic_auth_method": return "none";
      case "integrations_detect": return window.__detectedIntegrations ?? null;
      case "elastic_test":
      case "elastic_use_eck_credentials":
      case "prometheus_test":
      case "prometheus_save_auth": {
        window.__integrationCalls = [...(window.__integrationCalls ?? []), { cmd, args }];
        if (cmd === "elastic_test") return { version: "8.15.0", clusterName: "quickstart", health: "green", indices: 3 };
        if (cmd === "prometheus_test") return { version: "2.54.1", cadvisor: true, kubeStateMetrics: true, clusters: [] };
        return cmd === "elastic_use_eck_credentials" ? "eck-user" : null;
      }
      case "prometheus_metrics": {
        window.__lastPromMetrics = args;
        const charts = ["cpu", "cpu-request", "cpu-limit", "memory", "memory-request", "memory-limit", "restarts", "restarts-total", "network-rx", "network-tx"];
        const value = { cpu: 0.25, "cpu-request": 0.5, "cpu-limit": 1, memory: 104857600, "memory-request": 134217728, "memory-limit": 268435456, restarts: 2, "restarts-total": 1, "network-rx": 2048, "network-tx": 1024 };
        return {
          start: 0, end: 3600, step: 15,
          charts: charts.map((chart) => ({
            chart,
            query: "e2e-" + chart,
            series: [{ label: chart.startsWith("network") ? "" : "api", points: [[0, value[chart] / 2], [1800, value[chart]], [3600, value[chart]]] }],
            error: null,
          })),
        };
      }
      case "prometheus_sparklines":
        return { cpu: { "default/api-0": [[0, 0.1], [120, 0.2], [240, 0.15]] }, memory: { "default/api-0": [[0, 1], [120, 2]] } };
      case "prometheus_cluster_usage":
      case "prometheus_node_metrics": {
        const charts = cmd === "prometheus_cluster_usage"
          ? ["cpu", "cpu-allocatable", "memory", "memory-allocatable"]
          : ["cpu", "cpu-allocatable", "memory", "memory-allocatable", "pods", "network-rx", "network-tx", "filesystem", "filesystem-capacity"];
        const value = { cpu: 1.5, "cpu-allocatable": 4, memory: 2147483648, "memory-allocatable": 8589934592, pods: 18, "network-rx": 2048, "network-tx": 1024 };
        return {
          start: 0, end: 3600, step: 15,
          charts: charts.map((chart) => {
            const v = value[chart];
            return {
              chart,
              source: v === undefined ? null : chart === "pods" || chart.endsWith("allocatable") ? "kube-state-metrics" : "cadvisor",
              query: "e2e-" + chart,
              series: v === undefined ? [] : [{ label: "", points: [[0, v / 2], [1800, v], [3600, v]] }],
              error: null,
            };
          }),
        };
      }
      case "prometheus_alerts":
        return {
          source: "alerts-api",
          alerts: [
            { name: "KubeNodeNotReady", severity: "critical", namespace: null, pod: null, node: "node-1", summary: "Node is not ready.", activeAt: "2026-01-01T00:00:00Z", expr: "kube_node_status_condition == 0", labels: {} },
            { name: "Watchdog", severity: "none", namespace: null, pod: null, node: null, summary: "Alerting pipeline check.", activeAt: "2026-01-01T00:00:00Z", expr: "ALERTS-watchdog", labels: {} },
          ],
        };
      case "prometheus_alert_expr":
        return args.alert && args.alert.name === "Watchdog" ? "vector(1)" : "e2e-rule";
      case "prometheus_auth_method": return "none";
      case "open_grafana_explore": {
        window.__grafanaOpened = args;
        return null;
      }
      case "grafana_port_forward": {
        window.__grafanaForwards = [...(window.__grafanaForwards ?? []), args];
        return 43000;
      }
      case "kibana_port_forward": {
        window.__kibanaForwards = (window.__kibanaForwards ?? 0) + 1;
        return 45601;
      }
      case "open_kibana_discover":
      case "open_kibana_workload": {
        window.__kibanaOpened = args;
        return null;
      }
      case "discover_resource_kinds": return fixtures.resourceKinds;
      case "list_resource_table":
        return args.resource.plural === "daemonsets" ? fixtures.daemonSetTable : { columns: fixtures.daemonSetTable.columns, rows: [] };
      case "get_dynamic_resource_yaml":
        return "apiVersion: apps/v1\\nkind: DaemonSet\\nmetadata:\\n  name: " + args.name + "\\n";
      case "apply_resource_yaml": {
        window.__lastApply = args;
        return null;
      }
      case "resource_facts":
        return JSON.parse(JSON.stringify(factsOf(args.namespace, args.name)));
      case "evaluate_resources":
        return evaluate(args.facts, args.proposal);
      case "apply_resources": {
        window.__lastResourcesApply = args;
        window.__resourcesApplies = [...(window.__resourcesApplies ?? []), args];
        if (args.dryRun && fixtures.dryRunError) throw new Error(fixtures.dryRunError);
        if (!args.dryRun && fixtures.applyError) throw new Error(fixtures.applyError);
        const facts = factsOf(args.namespace, args.name);
        const evaluation = evaluate(facts, args.proposal);
        // The core refuses a blocked change even when the caller sends it.
        const blocked = evaluation.findings.find((f) => f.level === "blocked");
        if (blocked) throw new Error(blocked.message);
        if (!args.dryRun) commit(facts, args.proposal);
        return evaluation;
      }
      case "clear_resources_override": {
        window.__lastClearOverride = args;
        if (fixtures.clearOverrideError) throw new Error(fixtures.clearOverrideError);
        const deployment = deploymentOf(args.namespace, args.name);
        if (deployment) deployment.resources_override = null;
        const facts = fixtures.resourceFacts;
        if (facts && facts.workload.namespace === args.namespace && facts.workload.name === args.name) {
          facts.workload.override_annotation = null;
          facts.seen.override_annotation = null;
        }
        return null;
      }
      default: return null;
    }
  };

  // event name -> Map<eventId, handlerCallbackId>, mirroring the registry
  // Tauri's real event plugin keeps so listen/unlisten/emit round-trip.
  const eventListeners = {};

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    plugins: {},
    transformCallback(callback) {
      const id = callbackId++;
      window["_" + id] = callback;
      return id;
    },
    async invoke(cmd, args) {
      if (cmd.startsWith("plugin:path|")) return "/home/test";
      if (cmd === "plugin:dialog|open") return ["/home/test/.kube/extra.yaml"];
      if (cmd === "plugin:event|listen") {
        const eventId = callbackId++;
        const handlers = eventListeners[args.event] ?? (eventListeners[args.event] = new Map());
        handlers.set(eventId, args.handler);
        return eventId;
      }
      if (cmd === "plugin:event|unlisten") {
        eventListeners[args.event]?.delete(args.eventId);
        return null;
      }
      if (cmd.startsWith("plugin:event|")) return callbackId++;
      return responses(cmd, args ?? {});
    },
  };

  // Test hook: fire a Tauri event to every listener registered for the
  // given event name via @tauri-apps/api/event's listen(), e.g.
  // window.__emitTauriEvent("pod-log-line:1", { ... }).
  window.__emitTauriEvent = (name, payload) => {
    const handlers = eventListeners[name];
    if (!handlers) return;
    for (const [eventId, handlerId] of handlers) {
      const callback = window["_" + handlerId];
      callback?.({ event: name, id: eventId, payload });
    }
  };

  // Test hook: look up the stream id last handed out for a given container
  // by the mocked stream_pod_log, e.g. window.__streamIdFor("worker").
  window.__streamIdFor = (container) => streamIdsByContainer[container] ?? null;
})();
`;
}

/**
 * Emits a `pod-log-line` event on whichever stream id the mock last assigned
 * to `container` via `stream_pod_log` — the per-container sub-stream that
 * `ContainerStream` opens for each pod container in merged ("all
 * containers") mode. Waits for that sub-stream to have opened first.
 */
export async function emitPodLogLine(
  page: Page,
  container: string,
  message: string,
  overrides: Partial<{ pod: string; namespace: string; time: string; level: string }> = {},
): Promise<void> {
  await page.waitForFunction((c) => Boolean(window.__streamIdFor?.(c)), container);
  const { pod = "api-0", namespace = "default", time = "2026-08-04T10:00:00Z", level = "info" } =
    overrides;
  await page.evaluate(
    ({ container, message, pod, namespace, time, level }) => {
      const id = window.__streamIdFor?.(container);
      window.__emitTauriEvent?.(`pod-log-line:${id}`, { pod, namespace, time, level, message });
    },
    { container, message, pod, namespace, time, level },
  );
}
