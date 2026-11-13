import { invoke } from "@tauri-apps/api/core";

// --- Types matching Rust structs ---

/** A Kubernetes quantity as the cluster writes it, with its amount (millicores, bytes); `amount` is null when `text` cannot be parsed. */
export type QuantityInfo = { text: string; amount: number | null };
export type ResourcePairInfo = { request: QuantityInfo | null; limit: QuantityInfo | null };
export type ContainerResourcesInfo = { cpu: ResourcePairInfo; memory: ResourcePairInfo };
/** A container of a workload's pod template; `sidecar` is a native sidecar (init container with `restartPolicy: Always`). */
export type TemplateContainerInfo = {
  name: string;
  image: string | null;
  sidecar: boolean;
  resources: ContainerResourcesInfo;
};
/** CPU/memory usage of one container of a pod. */
export type ContainerUsageInfo = { name: string; cpu_millis: number; memory_bytes: number };

export type ContainerInfo = {
  name: string;
  image: string | null;
  ready: boolean;
  /** Requests and limits; absent in a payload from an older core. */
  resources?: ContainerResourcesInfo;
};

export type PodInfo = {
  name: string;
  namespace: string;
  phase: string | null;
  ready: boolean;
  restarts: number;
  ready_containers: number;
  total_containers: number;
  node: string | null;
  pod_ip: string | null;
  qos_class: string | null;
  containers: ContainerInfo[];
  labels: Record<string, string>;
  creation_timestamp: string | null;
  /** The Deployment whose ReplicaSet controls the pod; null for any other owner or none, absent from an older core. */
  deployment?: string | null;
};

export type NamespaceInfo = {
  name: string;
  phase: string | null;
};

export type DeploymentConditionInfo = {
  condition_type: string;
  status: string;
  reason: string | null;
};

/** Who manages a workload, from its labels and annotations. */
export type ManagerKind =
  | "argo_cd"
  | "flux_kustomization"
  | "flux_helm_release"
  | "helm"
  | "possibly_managed"
  | "none";
/** `release` is the Helm release name, set for `helm` only. */
export type ManagerInfo = { kind: ManagerKind; release: string | null };
/** A request and a limit as text; null is not set. */
export type PairText = { request: string | null; limit: string | null };
export type ResourceTexts = { cpu: PairText; memory: PairText };
/** One container of the override mark: its values before the first change and the ones applied last. */
export type OverrideContainer = { name: string; original: ResourceTexts; applied: ResourceTexts };
/** The active override mark of a deployment; `containers` in name order. */
export type OverrideInfo = { at: string; containers: OverrideContainer[] };

// --- A change of a deployment's requests and limits (resource_facts, evaluate_resources, apply_resources) ---

export type ResourceName = "cpu" | "memory";
export type ResourceField = "request" | "limit";
/** A part of the facts that may be missing, with the reason in the user's terms. */
export type Fact<T> = { state: "known"; value: T } | { state: "missing"; reason: string };
/** Millicores and bytes. */
export type Amounts = { cpu_millis: number; memory_bytes: number };
/** A pod's figures as the scheduler computes them; a null limit is no limit. */
export type PodFigures = {
  request: Amounts;
  cpu_limit: number | null;
  memory_limit: number | null;
  /** The limits as a node adds them up: a container without a limit counts 0. */
  set_limits: Amounts;
};
/** Millicores and bytes, or plain numbers for a ratio; null is not set. */
export type PerResource = { cpu: number | null; memory: number | null };
/** One item of a LimitRange; `kind` is its type ("Container", "Pod"). */
export type LimitRangeItemFacts = {
  kind: string;
  min: PerResource;
  max: PerResource;
  default: PerResource;
  default_request: PerResource;
  max_ratio: PerResource;
};
export type LimitRangeFacts = { name: string; items: LimitRangeItemFacts[] };
/** The rollout strategy, its counts resolved against the replicas. */
export type RolloutFacts = { recreate: boolean; max_surge: number; max_unavailable: number };
export type WorkloadFacts = {
  namespace: string;
  name: string;
  resource_version: string | null;
  generation: number;
  replicas: number;
  rollout: RolloutFacts;
  /** Regular containers, spec order. */
  containers: TemplateContainerInfo[];
  /** Every init container, spec order; `sidecar` marks the native sidecars. */
  init_containers: TemplateContainerInfo[];
  overhead: Amounts;
  manager: ManagerInfo;
  /** The override annotation as read, whatever it holds. */
  override_annotation: string | null;
};
/** What the editor saw when it opened; sent back with the apply. */
export type SeenState = {
  generation: number;
  resources: Record<string, ContainerResourcesInfo>;
  override_annotation: string | null;
};
export type OwnPodFacts = {
  name: string;
  node: string | null;
  figures: PodFigures;
  /** Empty when metrics-server has no sample. */
  usage: ContainerUsageInfo[];
};
export type NodeFacts = {
  name: string;
  /** Ready and not cordoned. */
  schedulable: boolean;
  allocatable: Amounts;
  /** Requests of the pods of other workloads on the node. */
  others_requests: Amounts;
  others_cpu_limits: number;
  others_memory_limits: number;
  memory_used: number | null;
};
export type QuotaFacts = {
  name: string;
  /** Has scopes or a scope selector: not evaluated. */
  scoped: boolean;
  hard: Record<string, number>;
  used: Record<string, number>;
};
export type HpaFacts = { name: string; cpu_utilization: boolean; memory_utilization: boolean };
export type VpaFacts = { name: string; update_mode: string };
/** Everything a change is checked against; held by the frontend and sent back with each proposal. */
export type ResourceFacts = {
  workload: WorkloadFacts;
  seen: SeenState;
  pods: OwnPodFacts[];
  usage: Fact<null>;
  nodes: Fact<NodeFacts[]>;
  limit_ranges: Fact<LimitRangeFacts[]>;
  quotas: Fact<QuotaFacts[]>;
  hpas: Fact<HpaFacts[]>;
  vpas: Fact<VpaFacts[]>;
};
export type ProposalKind = "adjust" | "restore";
/** The four values wanted for one container, as typed. */
export type ContainerProposal = { name: string; resources: ResourceTexts };
/** `containers` is ignored for a restore. */
export type ResourceProposal = { kind: ProposalKind; containers: ContainerProposal[] };
export type FindingLevel = "blocked" | "warning" | "not_checked" | "note";
export type FindingCode =
  | "b1"
  | "b2"
  | "b3"
  | "b4"
  | "b5"
  | "cleared"
  | "unknown_container"
  | "no_override"
  | "w0"
  | "w1"
  | "w1r"
  | "w2"
  | "w3"
  | "w4"
  | "w5"
  | "w6"
  | "w7"
  | "w8"
  | "milli_memory"
  | "w9"
  | "note_fits"
  | "note_cpu_limits"
  | "note_qos"
  | "note_no_pods";
/** One finding of the check, with its sentence. */
export type Finding = {
  code: FindingCode;
  level: FindingLevel;
  message: string;
  container: string | null;
  resource: ResourceName | null;
  field: ResourceField | null;
  node: string | null;
};
/** One field a proposal changes; a null `after` removes the value (restore only). */
export type ResourceChange = {
  container: string;
  sidecar: boolean;
  resource: ResourceName;
  field: ResourceField;
  before: string | null;
  after: string | null;
};
/** A percent of a node's allocatable, before and after. */
export type BeforeAfter = { before: number; after: number };
export type NodeProjection = {
  name: string;
  schedulable: boolean;
  own_pods: number;
  cpu_requests: BeforeAfter;
  memory_requests: BeforeAfter;
  cpu_limits: BeforeAfter;
  memory_limits: BeforeAfter;
  /** Null without usage. */
  memory_if_full: BeforeAfter | null;
};
/** The outcome of the check: findings worst first, changes in template order, hosting nodes first. */
export type ResourceEvaluation = {
  findings: Finding[];
  changes: ResourceChange[];
  nodes: NodeProjection[];
};

export type DeploymentInfo = {
  name: string;
  namespace: string;
  replicas: number;
  ready_replicas: number;
  images: string[];
  selector: Record<string, string>;
  strategy: string | null;
  conditions: DeploymentConditionInfo[];
  creation_timestamp: string | null;
  /** Template containers (regular, then native sidecars); absent in a payload from an older core. */
  containers?: TemplateContainerInfo[];
  /** Who manages the deployment; absent in a payload from an older core. */
  manager?: ManagerInfo;
  /** The active override mark; null when there is none or it is stale. */
  resources_override?: OverrideInfo | null;
};

export type ContextInfo = {
  name: string;
  cluster_server: string | null;
  namespace: string;
  is_active: boolean;
  /** Kubeconfig file that defines this context (first file wins). */
  source?: string | null;
};

/** One file of the resolved kubeconfig list, in merge order. */
export type KubeconfigSource = {
  path: string;
  exists: boolean;
  contexts: number;
  /** Context names hidden by an earlier file with the same name. */
  shadowed: string[];
  /**
   * Cluster / user names an earlier file defines differently. This file's
   * contexts still use this file's definition (informational).
   */
  redefined_clusters?: string[];
  redefined_users?: string[];
};

/** Which precedence level produced the kubeconfig list (spec §1.1). */
export type KubeconfigOrigin = "custom" | "env" | "default";

export type KubeconfigSources = {
  /** Loaded files joined like KUBECONFIG; pass as `kubeconfigPath`. */
  spec: string;
  sources: KubeconfigSource[];
  origin: KubeconfigOrigin;
};

export type ServiceInfo = {
  name: string;
  namespace: string;
  service_type: string | null;
  cluster_ip: string | null;
  external_ips: string[];
  ports: string[];
  creation_timestamp: string | null;
};

export type IngressInfo = {
  name: string;
  namespace: string;
  class: string | null;
  hosts: string[];
  addresses: string[];
  tls: boolean;
  creation_timestamp: string | null;
};

export type ConfigMapInfo = {
  name: string;
  namespace: string;
  data_count: number;
  creation_timestamp: string | null;
};

export type EventInfo = {
  event_type: string | null;
  reason: string | null;
  object: string;
  message: string | null;
  namespace: string;
  count: number;
  last_timestamp: string | null;
};

export type SecretInfo = {
  name: string;
  namespace: string;
  secret_type: string | null;
  /** Values decoded locally by the backend — they never leave this machine. */
  data: Record<string, string>;
  creation_timestamp: string | null;
};

// --- Invoke wrappers ---

/** Resolve the kubeconfig list; a non-empty `customPaths` replaces KUBECONFIG. */
export function kubeconfigSources(customPaths: string[] = []): Promise<KubeconfigSources> {
  return invoke<KubeconfigSources>("kubeconfig_sources", { customPaths });
}

export function listContexts(kubeconfigPath?: string): Promise<ContextInfo[]> {
  return invoke<ContextInfo[]>("list_contexts", { kubeconfigPath: kubeconfigPath ?? null });
}

export function getCurrentContext(kubeconfigPath?: string): Promise<string | null> {
  return invoke<string | null>("get_current_context", { kubeconfigPath: kubeconfigPath ?? null });
}

export function setContext(contextName: string, kubeconfigPath?: string): Promise<void> {
  return invoke("set_context", { contextName, kubeconfigPath: kubeconfigPath ?? null });
}

export function listPods(
  kubeconfigPath: string,
  namespace?: string,
  context?: string,
): Promise<PodInfo[]> {
  return invoke<PodInfo[]>("list_pods", {
    kubeconfigPath,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

export function listNamespaces(
  kubeconfigPath: string,
  context?: string,
): Promise<NamespaceInfo[]> {
  return invoke<NamespaceInfo[]>("list_namespaces", {
    kubeconfigPath,
    context: context ?? null,
  });
}

export function listDeployments(
  kubeconfigPath: string,
  namespace: string,
  context?: string,
): Promise<DeploymentInfo[]> {
  return invoke<DeploymentInfo[]>("list_deployments", {
    kubeconfigPath,
    namespace,
    context: context ?? null,
  });
}

export function listServices(
  kubeconfigPath: string,
  namespace?: string,
  context?: string,
): Promise<ServiceInfo[]> {
  return invoke<ServiceInfo[]>("list_services", {
    kubeconfigPath,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

export function listIngresses(
  kubeconfigPath: string,
  namespace?: string,
  context?: string,
): Promise<IngressInfo[]> {
  return invoke<IngressInfo[]>("list_ingresses", {
    kubeconfigPath,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

export function listConfigMaps(
  kubeconfigPath: string,
  namespace?: string,
  context?: string,
): Promise<ConfigMapInfo[]> {
  return invoke<ConfigMapInfo[]>("list_configmaps", {
    kubeconfigPath,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

export function listSecrets(
  kubeconfigPath: string,
  namespace?: string,
  context?: string,
): Promise<SecretInfo[]> {
  return invoke<SecretInfo[]>("list_secrets", {
    kubeconfigPath,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

export function listEvents(
  kubeconfigPath: string,
  namespace?: string,
  context?: string,
): Promise<EventInfo[]> {
  return invoke<EventInfo[]>("list_events", {
    kubeconfigPath,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

export type HelmReleaseInfo = {
  name: string;
  namespace: string;
  revision: number;
  status: string | null;
  chart: string | null;
  app_version: string | null;
  updated: string | null;
};

export type PodMetricsInfo = {
  name: string;
  namespace: string;
  cpu_millis: number;
  memory_bytes: number;
  /** Usage per container; absent in a payload from an older core. */
  containers?: ContainerUsageInfo[];
};

export type NodeCapacityInfo = {
  name: string;
  cpu_used_millis: number;
  cpu_allocatable_millis: number;
  memory_used_bytes: number;
  memory_allocatable_bytes: number;
};

export type JobInfo = {
  name: string;
  namespace: string;
  completions: number;
  succeeded: number;
  active: number;
  failed: number;
  creation_timestamp: string | null;
};

export type CronJobInfo = {
  name: string;
  namespace: string;
  schedule: string;
  suspend: boolean;
  active: number;
  last_schedule: string | null;
  creation_timestamp: string | null;
};

export type StatefulSetInfo = {
  name: string;
  namespace: string;
  replicas: number;
  ready_replicas: number;
  creation_timestamp: string | null;
};

export type NodeInfo = {
  name: string;
  status: string;
  roles: string[];
  version: string | null;
  creation_timestamp: string | null;
};

export type PvcInfo = {
  name: string;
  namespace: string;
  status: string | null;
  volume: string | null;
  capacity: string | null;
  access_modes: string[];
  storage_class: string | null;
  creation_timestamp: string | null;
};

export type CapacityTotals = {
  cpu_used_millis: number;
  cpu_allocatable_millis: number;
  memory_used_bytes: number;
  memory_allocatable_bytes: number;
};

export type ClusterHealthInfo = {
  context: string;
  reachable: boolean;
  version: string | null;
  node_count: number | null;
  /** Pods across all namespaces; null when forbidden or timed out. */
  pod_count: number | null;
  /** Pods needing attention (same rule as `resources.issuePods`). */
  issue_pod_count: number | null;
  /** Cluster CPU/memory totals; null without metrics-server. */
  capacity: CapacityTotals | null;
  error: string | null;
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogLine = {
  pod: string;
  namespace: string;
  time: string | null;
  level: LogLevel;
  message: string;
  /** Frontend-only: source container, tagged by ContainerStream. Absent on aggregated-view lines. */
  container?: string;
  /** Frontend-only: the stored Elasticsearch `_source` (history lines, #501); JSON/ECS modes render it. */
  document?: string;
};

export type PodRef = {
  namespace: string;
  name: string;
};

/// Full per-container detail for the log-panel container picker.
export type ContainerDetail = {
  name: string;
  init: boolean;
  sidecar: boolean;
  restarts: number;
  ready: boolean;
  state: "running" | "waiting" | "terminated";
  state_reason: string | null;
  last_terminated_reason: string | null;
  last_terminated_at: string | null;
};

export type PodLogStreamOptions = {
  container?: string;
  previous?: boolean;
  tailLines?: number;
  sinceTime?: string;
};

export function listHelmReleases(
  kubeconfigPath: string,
  namespace?: string,
  context?: string,
): Promise<HelmReleaseInfo[]> {
  return invoke<HelmReleaseInfo[]>("list_helm_releases", {
    kubeconfigPath,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

export function listPodMetrics(
  kubeconfigPath: string,
  namespace?: string,
  context?: string,
): Promise<PodMetricsInfo[]> {
  return invoke<PodMetricsInfo[]>("list_pod_metrics", {
    kubeconfigPath,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

export function clusterCapacity(
  kubeconfigPath: string,
  context?: string,
): Promise<NodeCapacityInfo[]> {
  return invoke<NodeCapacityInfo[]>("cluster_capacity", {
    kubeconfigPath,
    context: context ?? null,
  });
}

export function listJobs(
  kubeconfigPath: string,
  namespace?: string,
  context?: string,
): Promise<JobInfo[]> {
  return invoke<JobInfo[]>("list_jobs", {
    kubeconfigPath,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

export function listCronJobs(
  kubeconfigPath: string,
  namespace?: string,
  context?: string,
): Promise<CronJobInfo[]> {
  return invoke<CronJobInfo[]>("list_cronjobs", {
    kubeconfigPath,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

export function listStatefulSets(
  kubeconfigPath: string,
  namespace?: string,
  context?: string,
): Promise<StatefulSetInfo[]> {
  return invoke<StatefulSetInfo[]>("list_statefulsets", {
    kubeconfigPath,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

/** A namespaced object by name (#529). */
export type WorkloadRef = { name: string; namespace: string };

/** DaemonSets by name, for the Logs view's workload picker (#529). */
export function listDaemonSets(kubeconfigPath: string, namespace?: string, context?: string): Promise<WorkloadRef[]> {
  return invoke<WorkloadRef[]>("list_daemonsets", { kubeconfigPath, namespace: namespace ?? null, context: context ?? null });
}

export function listPvcs(
  kubeconfigPath: string,
  namespace?: string,
  context?: string,
): Promise<PvcInfo[]> {
  return invoke<PvcInfo[]>("list_pvcs", {
    kubeconfigPath,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

export function listNodes(
  kubeconfigPath: string,
  context?: string,
): Promise<NodeInfo[]> {
  return invoke<NodeInfo[]>("list_nodes", {
    kubeconfigPath,
    context: context ?? null,
  });
}

export type YamlResourceType =
  | "pod"
  | "deployment"
  | "service"
  | "configmap"
  | "secret"
  | "ingress";

export function getResourceYaml(
  kubeconfigPath: string,
  resourceType: YamlResourceType,
  namespace: string,
  name: string,
  context?: string,
): Promise<string> {
  return invoke<string>("get_resource_yaml", {
    kubeconfigPath,
    resourceType,
    namespace,
    name,
    context: context ?? null,
  });
}

/** One line of shell output (#488); mirrors `cubelite_core::exec::ExecLine`. */
export type ExecLine = { channel: "stdout" | "stderr" | "status"; text: string };

/**
 * Starts a line-based shell (`/bin/sh`, no TTY) in the pod's first container.
 * `sessionId` is chosen by the caller so it can listen to
 * `exec-output:{sessionId}` / `exec-end:{sessionId}` before starting.
 */
export function startExec(
  kubeconfigPath: string,
  sessionId: string,
  namespace: string,
  pod: string,
  context?: string,
): Promise<void> {
  return invoke<void>("start_exec", {
    kubeconfigPath,
    sessionId,
    namespace,
    pod,
    container: null,
    context: context ?? null,
  });
}

/** Writes `data` to the shell's stdin (include the trailing newline). */
export function execSend(sessionId: string, data: string): Promise<void> {
  return invoke<void>("exec_send", { sessionId, data });
}

/** Ends a shell session; resolves even when it already ended. */
export function stopExec(sessionId: string): Promise<void> {
  return invoke<void>("stop_exec", { sessionId });
}

/**
 * Replace a resource with an edited YAML manifest (PUT, `kubectl replace`).
 * Rejects with a message ready to show (invalid manifest, conflict, API error).
 */
export function applyResourceYaml(
  kubeconfigPath: string,
  resourceType: YamlResourceType,
  namespace: string,
  name: string,
  yaml: string,
  context?: string,
): Promise<void> {
  return invoke<void>("apply_resource_yaml", {
    kubeconfigPath,
    resourceType,
    namespace,
    name,
    yaml,
    context: context ?? null,
  });
}

/**
 * Read what a change of a deployment's requests and limits is checked against.
 * Rejects only when the deployment or its pods cannot be read; any other part
 * that cannot be read is a `missing` fact with its reason.
 */
export function resourceFacts(
  kubeconfigPath: string,
  namespace: string,
  name: string,
  context?: string,
): Promise<ResourceFacts> {
  return invoke<ResourceFacts>("resource_facts", {
    kubeconfigPath,
    namespace,
    name,
    context: context ?? null,
  });
}

/** Check a proposal against facts already read: no cluster call. */
export function evaluateResources(
  facts: ResourceFacts,
  proposal: ResourceProposal,
): Promise<ResourceEvaluation> {
  return invoke<ResourceEvaluation>("evaluate_resources", { facts, proposal });
}

/**
 * Apply a proposal (or, with `dryRun`, have the API server check the exact
 * patch without saving it). The core reads the facts again and refuses a
 * blocked change or one made underneath `seen`. Rejects with a message ready
 * to show.
 */
export function applyResources(
  kubeconfigPath: string,
  namespace: string,
  name: string,
  proposal: ResourceProposal,
  seen: SeenState,
  dryRun: boolean,
  context?: string,
): Promise<ResourceEvaluation> {
  return invoke<ResourceEvaluation>("apply_resources", {
    kubeconfigPath,
    namespace,
    name,
    proposal,
    seen,
    dryRun,
    context: context ?? null,
  });
}

/** Remove the override mark and nothing else ("Keep these values"). Rejects with a message ready to show. */
export function clearResourcesOverride(
  kubeconfigPath: string,
  namespace: string,
  name: string,
  context?: string,
): Promise<void> {
  return invoke<void>("clear_resources_override", {
    kubeconfigPath,
    namespace,
    name,
    context: context ?? null,
  });
}

// ---------------------------------------------------------------------------
// Any resource kind: discovery, Table lists and YAML (resource-kinds design)
// ---------------------------------------------------------------------------

/** One kind the API server serves, from discovery (preferred version first). */
export interface ResourceKindInfo {
  /** API group; `""` for the core group. */
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  short_names: string[];
}

/** Which resource to list or fetch. */
export interface ResourceRef {
  group: string;
  version: string;
  plural: string;
  namespaced: boolean;
}

/** One `priority: 0` column of the API server's Table. */
export interface TableColumn {
  name: string;
  /** OpenAPI type: `string`, `integer`, `number`, `boolean` or `date`. */
  column_type: string;
  format: string;
  description: string;
}

/** One object of a Table: its identity plus the cells of the columns. */
export interface TableRow {
  name: string;
  namespace: string | null;
  creation_timestamp: string | null;
  cells: unknown[];
}

/** A list as `kubectl get` prints it. */
export interface ResourceTable {
  columns: TableColumn[];
  rows: TableRow[];
}

export function discoverResourceKinds(
  kubeconfigPath: string,
  context?: string,
): Promise<ResourceKindInfo[]> {
  return invoke<ResourceKindInfo[]>("discover_resource_kinds", {
    kubeconfigPath,
    context: context ?? null,
  });
}

/** Any kind as the API server's Table; all namespaces when `namespace` is undefined. */
export function listResourceTable(
  kubeconfigPath: string,
  resource: ResourceRef,
  namespace?: string,
  context?: string,
): Promise<ResourceTable> {
  return invoke<ResourceTable>("list_resource_table", {
    kubeconfigPath,
    resource,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

/** Any object as clean YAML (read-only). */
export function getDynamicResourceYaml(
  kubeconfigPath: string,
  resource: ResourceRef,
  namespace: string | undefined,
  name: string,
  context?: string,
): Promise<string> {
  return invoke<string>("get_dynamic_resource_yaml", {
    kubeconfigPath,
    resource,
    namespace: namespace ?? null,
    name,
    context: context ?? null,
  });
}

/**
 * Reachability probe (short timeouts). `summary` adds pod and capacity
 * totals for the All Clusters dashboard; leave it off on hot paths.
 */
export function probeCluster(
  kubeconfigPath: string,
  context: string,
  options: { summary?: boolean } = {},
): Promise<ClusterHealthInfo> {
  return invoke<ClusterHealthInfo>("probe_cluster", {
    kubeconfigPath,
    context,
    includeSummary: options.summary ?? false,
  });
}

export function streamLogs(
  kubeconfigPath: string,
  pods: PodRef[],
  context?: string,
): Promise<string> {
  return invoke<string>("stream_logs", {
    kubeconfigPath,
    pods,
    context: context ?? null,
  });
}

export function stopLogs(streamId: string): Promise<void> {
  return invoke("stop_logs", { streamId });
}

/** Write exported log contents to ~/Downloads; resolves to the written path. */
export function exportLog(filename: string, contents: string): Promise<string> {
  return invoke<string>("export_log", { filename, contents });
}

/**
 * Start a single-container log stream for the log panel.
 *
 * Lines arrive as `pod-log-line:{streamId}` events; a final
 * `pod-log-end:{streamId}` event signals that the stream ended (server drop
 * or completed previous-instance fetch). Tear down with {@link stopLogs}.
 */
export function streamPodLog(
  kubeconfigPath: string,
  namespace: string,
  pod: string,
  opts: PodLogStreamOptions = {},
  context?: string,
): Promise<string> {
  return invoke<string>("stream_pod_log", {
    kubeconfigPath,
    namespace,
    pod,
    container: opts.container ?? null,
    previous: opts.previous ?? false,
    tailLines: opts.tailLines ?? null,
    sinceTime: opts.sinceTime ?? null,
    context: context ?? null,
  });
}

/** Fetch one pod's containers (app, sidecar, init) with live status. */
export function getPodContainers(
  kubeconfigPath: string,
  namespace: string,
  pod: string,
  context?: string,
): Promise<ContainerDetail[]> {
  return invoke<ContainerDetail[]>("get_pod_containers", {
    kubeconfigPath,
    namespace,
    pod,
    context: context ?? null,
  });
}

export function deletePod(
  kubeconfigPath: string,
  namespace: string,
  name: string,
  context?: string,
): Promise<void> {
  return invoke("delete_pod", {
    kubeconfigPath,
    namespace,
    name,
    context: context ?? null,
  });
}

export function restartDeployment(
  kubeconfigPath: string,
  namespace: string,
  name: string,
  context?: string,
): Promise<void> {
  return invoke("restart_deployment", {
    kubeconfigPath,
    namespace,
    name,
    context: context ?? null,
  });
}

export function scaleDeployment(
  kubeconfigPath: string,
  namespace: string,
  name: string,
  replicas: number,
  context?: string,
): Promise<void> {
  return invoke("scale_deployment", {
    kubeconfigPath,
    namespace,
    name,
    replicas,
    context: context ?? null,
  });
}

export function watchResources(
  kubeconfigPath: string,
  resourceType: string,
  namespace?: string,
  context?: string,
): Promise<string> {
  return invoke<string>("watch_resources", {
    kubeconfigPath,
    resourceType,
    namespace: namespace ?? null,
    context: context ?? null,
  });
}

export function unwatchResources(watchId: string): Promise<void> {
  return invoke("unwatch_resources", { watchId });
}

/** Tauri event emitted when a watched kubeconfig file changes on disk. */
export const KUBECONFIG_CHANGED = "kubeconfig-changed";
export type KubeconfigChanged = { paths: string[] };

export function watchKubeconfig(paths: string[]): Promise<string> {
  return invoke<string>("watch_kubeconfig", { paths });
}

export function unwatchKubeconfig(watchId: string): Promise<void> {
  return invoke("unwatch_kubeconfig", { watchId });
}

/** Result of starting a port-forward session. */
export interface ForwardStartResult {
  id: string;
  /** The actually-bound local port (relevant when 0 = auto was requested). */
  localPort: number;
}

export function startPortForward(
  kubeconfigPath: string,
  namespace: string,
  pod: string,
  localPort: number,
  remotePort: number,
  context?: string,
): Promise<ForwardStartResult> {
  return invoke<ForwardStartResult>("start_port_forward", {
    kubeconfigPath,
    context: context ?? null,
    namespace,
    pod,
    localPort,
    remotePort,
  });
}

export function stopPortForward(id: string): Promise<void> {
  return invoke("stop_port_forward", { id });
}

// ── Elasticsearch / Kibana (#483, #500) ──────────────────────────────────

export type EsTarget =
  | { kind: "in-cluster"; namespace: string; service: string; port: number; https: boolean }
  | { kind: "external"; url: string };

export type FieldPreset = "ecs" | "fluent-bit";

/** A context's endpoint; secrets are never part of it (OS keychain). */
export type EsEndpoint = {
  target: EsTarget;
  indexPattern: string;
  preset: FieldPreset;
  kibanaUrl: string | null;
  /** In-cluster Kibana opened through a port-forward when there is no URL (#505). */
  kibanaService?: KibanaService | null;
  skipTlsVerify: boolean;
  /** Narrows a deployment shared by many clusters to this context's (#528). */
  clusterFilter?: ClusterFilter | null;
  /** Resolved from the default endpoint shared by every context (#528): the backend uses the default's credentials. */
  shared?: boolean;
};

/**
 * A `field: value` term added to every history query (#528); an empty field
 * means `orchestrator.cluster.name` with the ECS preset.
 */
export type ClusterFilter = { field: string; value: string };

/** A web UI service in the cluster picked from Detect (Kibana #505, Grafana #525). */
export type ServiceRef = { namespace: string; service: string; port: number; https: boolean };

export type KibanaService = ServiceRef;

export type EsAuth =
  | { method: "none" }
  | { method: "basic"; username: string; password: string }
  | { method: "api-key"; key: string }
  | { method: "bearer"; token: string }
  /** ECK's `elastic` user, read from the cluster at each connection (never stored). */
  | { method: "eck-user" };

export type EsAuthMethod = EsAuth["method"];

export type HistoryQuery = {
  namespace: string;
  /** One pod; "" (with no `workload`) for the whole namespace. */
  pod: string;
  /** A workload's pods instead of `pod` (#529), matched by a regexp in the core. */
  workload?: Workload | null;
  container: string | null;
  /** RFC 3339 or date math (`now-1h`). */
  from: string;
  to: string;
  text: string | null;
  /** The previous page's `next`, passed back untouched; null for the first page. */
  searchAfter: HistoryCursor | null;
  size: number | null;
};

/**
 * Opaque paging cursor from the backend (#531): the last hit's sort values
 * and, on servers with point-in-time support, the PIT id. Never inspected
 * here; pass it back as `searchAfter`, or to `elasticCloseCursor`.
 */
export type HistoryCursor = object;

export type HistoryLine = {
  time: string | null;
  level: LogLevel;
  message: string;
  container: string | null;
  /** Pod the line came from, when the document names it (#529). */
  pod?: string | null;
  /** Stored `_source`, compact JSON. */
  document: string;
  /** `_index` and `_id` of the hit (drop lines repeated between pages). */
  docIndex?: string | null;
  docId?: string | null;
};

export type HistoryPage = {
  lines: HistoryLine[];
  total: number | null;
  totalIsLowerBound: boolean;
  /** Cursor of the next (older) page; null at the end. */
  next: HistoryCursor | null;
};

export type EsInfo = { version: string; clusterName: string; health: string | null; indices: number | null };

export type DetectedService = {
  kind: "elasticsearch" | "kibana";
  namespace: string;
  name: string;
  port: number;
  https: boolean;
};

export function elasticDetect(kubeconfigPath: string, context: string): Promise<DetectedService[]> {
  return invoke<DetectedService[]>("elastic_detect", { kubeconfigPath, context });
}

/** `auth` tests credentials before saving; omit it to use the stored ones. */
export function elasticTest(
  kubeconfigPath: string,
  context: string,
  endpoint: EsEndpoint,
  auth?: EsAuth,
): Promise<EsInfo> {
  return invoke<EsInfo>("elastic_test", { kubeconfigPath, context, endpoint, auth: auth ?? null });
}

export function elasticSearch(
  kubeconfigPath: string,
  context: string,
  endpoint: EsEndpoint,
  query: HistoryQuery,
): Promise<HistoryPage> {
  return invoke<HistoryPage>("elastic_search", { kubeconfigPath, context, endpoint, query });
}

/** Releases the point in time behind a cursor whose search was replaced or closed (best effort). */
export function elasticCloseCursor(
  kubeconfigPath: string,
  context: string,
  endpoint: EsEndpoint,
  cursor: HistoryCursor,
): Promise<void> {
  return invoke("elastic_close_cursor", { kubeconfigPath, context, endpoint, cursor });
}

/** Stores `auth` in the OS keychain, bound to `endpoint`'s origin and TLS setting. */
export function elasticSaveAuth(context: string, endpoint: EsEndpoint, auth: EsAuth): Promise<void> {
  return invoke("elastic_save_auth", { context, endpoint, auth });
}

/** Stored method for this endpoint; `none` when the stored credentials belong to another one. */
export function elasticAuthMethod(context: string, endpoint: EsEndpoint): Promise<EsAuthMethod> {
  return invoke<EsAuthMethod>("elastic_auth_method", { context, endpoint });
}

/** Stores ECK's `elastic` user for this in-cluster endpoint; returns the stored method. */
export function elasticUseEckCredentials(
  kubeconfigPath: string,
  context: string,
  endpoint: EsEndpoint,
): Promise<EsAuthMethod> {
  return invoke<EsAuthMethod>("elastic_use_eck_credentials", { kubeconfigPath, context, endpoint });
}

/**
 * Local port of a port-forward to an in-cluster Kibana (#505). The backend
 * keeps one per (kubeconfig, context, service), reused while its pod is
 * ready, and closes it when the context's endpoint changes.
 */
export function kibanaPortForward(kubeconfigPath: string, context: string, service: KibanaService): Promise<number> {
  return invoke<number>("kibana_port_forward", { kubeconfigPath, context, service });
}

export function elasticDisconnect(context: string): Promise<void> {
  return invoke("elastic_disconnect", { context });
}

export function kibanaDiscoverUrl(args: {
  kibanaUrl: string;
  preset: FieldPreset;
  namespace: string;
  pod: string;
  container: string | null;
  from: string;
  to: string;
  /** The context's cluster in a shared deployment (#528). */
  clusterFilter?: ClusterFilter | null;
}): Promise<string> {
  return invoke<string>("kibana_discover_url", args);
}

/** Opens Kibana Discover for a pod in the default browser (URL built and checked in Rust). */
export function openKibanaDiscover(args: {
  kibanaUrl: string;
  preset: FieldPreset;
  namespace: string;
  pod: string;
  container: string | null;
  from: string;
  to: string;
  /** The context's cluster in a shared deployment (#528). */
  clusterFilter?: ClusterFilter | null;
}): Promise<void> {
  return invoke("open_kibana_discover", args);
}

/**
 * Opens Kibana Discover for a workload's pods, or the whole namespace
 * without one (#526, #529): the same filter as the history.
 */
export function openKibanaWorkload(args: {
  kibanaUrl: string;
  preset: FieldPreset;
  namespace: string;
  workload: Workload | null;
  from: string;
  to: string;
  /** The context's cluster in a shared deployment (#528). */
  clusterFilter?: ClusterFilter | null;
}): Promise<void> {
  return invoke("open_kibana_workload", args);
}

/** Opens Kibana Discover without a filter (#526). */
export function openKibanaHome(kibanaUrl: string): Promise<void> {
  return invoke("open_kibana_home", { kibanaUrl });
}

// ── Prometheus / Grafana (#484, #509) ────────────────────────────────────

/** Where an integration's API lives (same shape for every integration). */
export type IntegrationTarget = EsTarget;

/** A context's Prometheus endpoint; secrets are never part of it (OS keychain). */
export type PromEndpoint = {
  target: IntegrationTarget;
  /** Value of the `cluster` label added to every query (shared workspaces). */
  cluster: string | null;
  grafanaUrl: string | null;
  /** Grafana datasource UID or name; null uses Grafana's default. */
  grafanaDatasource: string | null;
  /** In-cluster Grafana opened through a port-forward when there is no URL (#525). */
  grafanaService?: GrafanaService | null;
  skipTlsVerify: boolean;
  /** Resolved from the default endpoint shared by every context (#528): the backend uses the default's credentials. */
  shared?: boolean;
};

export type GrafanaService = ServiceRef;

export type PromAuth =
  | { method: "none" }
  | { method: "basic"; username: string; password: string }
  | { method: "bearer"; token: string }
  /** Azure Monitor: token from the Azure CLI at connect time (never stored). */
  | { method: "azure-cli" };

export type PromAuthMethod = PromAuth["method"];

export type MetricsRange = "1h" | "6h" | "24h" | "7d";

export type Workload =
  | { kind: "pod"; name: string }
  | { kind: "deployment"; name: string }
  | { kind: "stateful-set"; name: string }
  | { kind: "daemon-set"; name: string }
  | { kind: "job"; name: string };

export type Chart =
  | "cpu"
  | "cpu-request"
  | "cpu-limit"
  | "memory"
  | "memory-request"
  | "memory-limit"
  | "restarts"
  /** Restarts over the whole range, computed by Prometheus (one point). */
  | "restarts-total"
  | "network-rx"
  | "network-tx";

export type MetricsRequest = {
  namespace: string;
  workload: Workload;
  range: MetricsRange;
  perContainer: boolean;
};

/** `[unix seconds, value | null]` (null: NaN/Inf, the line breaks). */
export type Point = [number, number | null];

export type Series = { label: string; points: Point[] };

export type ChartData = { chart: Chart; query: string; series: Series[]; error: string | null };

export type MetricsResult = { start: number; end: number; step: number; charts: ChartData[] };

/** Last hour per `namespace/pod`. */
export type Sparklines = { cpu: Record<string, Point[]>; memory: Record<string, Point[]> };

export type PromInfo = {
  version: string;
  cadvisor: boolean;
  kubeStateMetrics: boolean;
  clusters: string[];
};

export type DetectedPrometheus = {
  kind: "prometheus" | "grafana";
  namespace: string;
  name: string;
  port: number;
  https: boolean;
};

export function prometheusDetect(kubeconfigPath: string, context: string): Promise<DetectedPrometheus[]> {
  return invoke<DetectedPrometheus[]>("prometheus_detect", { kubeconfigPath, context });
}

/**
 * The services the integrations would use, found when a context connects
 * (#527): the best guesses, whether Enable may skip the review (exactly one
 * operator-managed service), and every candidate best first.
 */
export type DetectedIntegrations = {
  elasticsearch: DetectedService | null;
  kibana: DetectedService | null;
  prometheus: DetectedPrometheus | null;
  grafana: DetectedPrometheus | null;
  elasticsearchOneClick: boolean;
  prometheusOneClick: boolean;
  elasticServices: DetectedService[];
  prometheusServices: DetectedPrometheus[];
};

/**
 * One listing of the services across namespaces, classified (#527). Only
 * the Kubernetes API is contacted; nothing is found when listing is forbidden.
 */
export function integrationsDetect(kubeconfigPath: string, context: string): Promise<DetectedIntegrations> {
  return invoke<DetectedIntegrations>("integrations_detect", { kubeconfigPath, context });
}

/** `auth` tests credentials before saving them; omitted uses the stored ones. */
export function prometheusTest(
  kubeconfigPath: string,
  context: string,
  endpoint: PromEndpoint,
  auth?: PromAuth,
): Promise<PromInfo> {
  return invoke<PromInfo>("prometheus_test", { kubeconfigPath, context, endpoint, auth: auth ?? null });
}

export function prometheusMetrics(
  kubeconfigPath: string,
  context: string,
  endpoint: PromEndpoint,
  request: MetricsRequest,
): Promise<MetricsResult> {
  return invoke<MetricsResult>("prometheus_metrics", { kubeconfigPath, context, endpoint, request });
}

/** `namespace` null covers every namespace. */
export function prometheusSparklines(
  kubeconfigPath: string,
  context: string,
  endpoint: PromEndpoint,
  namespace: string | null,
): Promise<Sparklines> {
  return invoke<Sparklines>("prometheus_sparklines", { kubeconfigPath, context, endpoint, namespace });
}

/** Saves credentials in the OS keychain, bound to the endpoint (`none` deletes them). */
export function prometheusSaveAuth(context: string, endpoint: PromEndpoint, auth: PromAuth): Promise<void> {
  return invoke("prometheus_save_auth", { context, endpoint, auth });
}

/** The stored method for this endpoint (never the secret). */
export function prometheusAuthMethod(context: string, endpoint: PromEndpoint): Promise<PromAuthMethod> {
  return invoke<PromAuthMethod>("prometheus_auth_method", { context, endpoint });
}

export function prometheusDisconnect(context: string): Promise<void> {
  return invoke("prometheus_disconnect", { context });
}

/**
 * Local port of a port-forward to an in-cluster Grafana (#525). The backend
 * keeps one per (kubeconfig, context, service), reused while its pod is
 * ready, and closes it when the context's Prometheus is disconnected.
 */
export function grafanaPortForward(kubeconfigPath: string, context: string, service: GrafanaService): Promise<number> {
  return invoke<number>("grafana_port_forward", { kubeconfigPath, context, service });
}

/** Opens Grafana Explore with `queries` (built in Rust, http(s) only). */
export function openGrafanaExplore(args: {
  grafanaUrl: string;
  datasource: string | null;
  queries: string[];
  range: MetricsRange;
}): Promise<void> {
  return invoke("open_grafana_explore", args);
}

/** Opens Grafana Explore with a workload's CPU query (built in Rust, #526). */
export function openGrafanaWorkload(args: {
  grafanaUrl: string;
  datasource: string | null;
  cluster: string | null;
  namespace: string;
  workload: Workload;
  range: MetricsRange;
}): Promise<void> {
  return invoke("open_grafana_workload", args);
}

/** Opens Grafana's home page (#526). */
export function openGrafanaHome(grafanaUrl: string): Promise<void> {
  return invoke("open_grafana_home", { grafanaUrl });
}

// ── Cluster and node history, alerts (#530) ───────────────────────────────

/** A chart of the Overview's cluster history or of a node's Metrics section. */
export type HostChart =
  | "cpu"
  | "cpu-allocatable"
  | "memory"
  | "memory-allocatable"
  | "pods"
  | "network-rx"
  | "network-tx"
  | "filesystem"
  | "filesystem-capacity";

/** The exporter a chart's data came from (null: no candidate had data). */
export type MetricSource = "node-exporter" | "cadvisor" | "kube-state-metrics" | "kubelet";

export type HostChartData = {
  chart: HostChart;
  source: MetricSource | null;
  query: string;
  series: Series[];
  error: string | null;
};

export type HostMetrics = { start: number; end: number; step: number; charts: HostChartData[] };

export type Alert = {
  name: string;
  severity: string | null;
  namespace: string | null;
  pod: string | null;
  node: string | null;
  /** `summary` annotation, else `description` / `message`. */
  summary: string | null;
  /** Firing since (RFC 3339); null from the `ALERTS` series. */
  activeAt: string | null;
  /** Its `ALERTS` series; Open in Grafana asks for the rule's expression. */
  expr: string;
  labels: Record<string, string>;
};

export type AlertsResult = { alerts: Alert[]; source: "alerts-api" | "alerts-metric" };

/** The Overview's cluster CPU and memory against allocatable. */
export function prometheusClusterUsage(
  kubeconfigPath: string,
  context: string,
  endpoint: PromEndpoint,
  range: MetricsRange,
): Promise<HostMetrics> {
  return invoke<HostMetrics>("prometheus_cluster_usage", { kubeconfigPath, context, endpoint, range });
}

/** A node's charts: node-exporter where it scrapes the node, else cAdvisor. */
export function prometheusNodeMetrics(
  kubeconfigPath: string,
  context: string,
  endpoint: PromEndpoint,
  node: string,
  range: MetricsRange,
): Promise<HostMetrics> {
  return invoke<HostMetrics>("prometheus_node_metrics", { kubeconfigPath, context, endpoint, node, range });
}

/** The alert's rule expression for Open in Grafana (rules fetched on demand, cached). */
export function prometheusAlertExpr(
  kubeconfigPath: string,
  context: string,
  endpoint: PromEndpoint,
  alert: Alert,
): Promise<string> {
  return invoke<string>("prometheus_alert_expr", { kubeconfigPath, context, endpoint, alert });
}

/** Firing alerts, most severe first. */
export function prometheusAlerts(kubeconfigPath: string, context: string, endpoint: PromEndpoint): Promise<AlertsResult> {
  return invoke<AlertsResult>("prometheus_alerts", { kubeconfigPath, context, endpoint });
}
