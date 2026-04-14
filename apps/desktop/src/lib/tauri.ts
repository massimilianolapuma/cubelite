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
