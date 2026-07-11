import { invoke } from "@tauri-apps/api/core";

// --- Types matching Rust structs ---

export type ContainerInfo = {
  name: string;
  image: string | null;
  ready: boolean;
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
};

export type ContextInfo = {
  name: string;
  cluster_server: string | null;
  namespace: string;
  is_active: boolean;
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

export function listContexts(): Promise<ContextInfo[]> {
  return invoke<ContextInfo[]>("list_contexts");
}

export function getCurrentContext(): Promise<string | null> {
  return invoke<string | null>("get_current_context");
}

export function setContext(contextName: string): Promise<void> {
  return invoke("set_context", { contextName });
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
};

export type NodeCapacityInfo = {
  name: string;
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
  error: string | null;
};

export type LogLevel = "info" | "warn" | "error";

export type LogLine = {
  pod: string;
  namespace: string;
  time: string | null;
  level: LogLevel;
  message: string;
};

export type PodRef = {
  namespace: string;
  name: string;
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

export function probeCluster(
  kubeconfigPath: string,
  context: string,
): Promise<ClusterHealthInfo> {
  return invoke<ClusterHealthInfo>("probe_cluster", { kubeconfigPath, context });
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
