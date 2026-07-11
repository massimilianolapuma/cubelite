import { invoke } from "@tauri-apps/api/core";

// --- Types matching Rust structs ---

export type PodInfo = {
  name: string;
  namespace: string;
  phase: string | null;
  ready: boolean;
  restarts: number;
};

export type NamespaceInfo = {
  name: string;
  phase: string | null;
};

export type DeploymentInfo = {
  name: string;
  namespace: string;
  replicas: number;
  ready_replicas: number;
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
