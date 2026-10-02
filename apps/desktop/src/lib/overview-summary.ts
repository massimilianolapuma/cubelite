/**
 * Overview counts (parity v2 §4). Pure, so the desktop and the macOS app
 * (`Models/OverviewSummary.swift`) count identically; keep the two in step.
 * A `null` list means "not loaded" and yields `null` counts (UI shows "—").
 */
import type {
  ConfigMapInfo,
  DeploymentInfo,
  HelmReleaseInfo,
  IngressInfo,
  NamespaceInfo,
  PodInfo,
  SecretInfo,
  ServiceInfo,
} from "#lib/tauri.ts";

export type OverviewInput = {
  pods: PodInfo[];
  deployments: DeploymentInfo[];
  namespaces: NamespaceInfo[];
  services: ServiceInfo[] | null;
  secrets: SecretInfo[] | null;
  configmaps: ConfigMapInfo[] | null;
  ingresses: IngressInfo[] | null;
  helm: HelmReleaseInfo[] | null;
  /** Node inventory count, else metrics node count, else null. */
  nodes: number | null;
};

export type OverviewSummary = {
  nodes: number | null;
  pods: { total: number; running: number; pending: number; failed: number };
  deployments: { total: number; healthy: number; degraded: number };
  namespaces: { total: number; active: number };
  services: { total: number; clusterIP: number; nodePort: number; loadBalancer: number } | null;
  secrets: { total: number; opaque: number; tls: number; docker: number } | null;
  configmaps: { total: number } | null;
  ingresses: { total: number; tls: number } | null;
  helm: { total: number; deployed: number; failed: number } | null;
};

function count<T>(items: T[], predicate: (item: T) => boolean): number {
  let n = 0;
  for (const item of items) if (predicate(item)) n++;
  return n;
}

/** Counts for the Overview stat row and resource grid. */
export function summarize(input: OverviewInput): OverviewSummary {
  const { pods, deployments, namespaces, services, secrets, configmaps, ingresses, helm } = input;
  const healthy = count(deployments, (d) => d.ready_replicas === d.replicas);
  return {
    nodes: input.nodes,
    pods: {
      total: pods.length,
      running: count(pods, (p) => p.phase === "Running"),
      pending: count(pods, (p) => p.phase === "Pending"),
      failed: count(pods, (p) => p.phase === "Failed"),
    },
    deployments: { total: deployments.length, healthy, degraded: deployments.length - healthy },
    namespaces: {
      total: namespaces.length,
      active: count(namespaces, (n) => n.phase === "Active"),
    },
    services: services && {
      total: services.length,
      clusterIP: count(services, (s) => s.service_type === "ClusterIP"),
      nodePort: count(services, (s) => s.service_type === "NodePort"),
      loadBalancer: count(services, (s) => s.service_type === "LoadBalancer"),
    },
    secrets: secrets && {
      total: secrets.length,
      opaque: count(secrets, (s) => s.secret_type === "Opaque"),
      tls: count(secrets, (s) => s.secret_type === "kubernetes.io/tls"),
      docker: count(secrets, (s) => s.secret_type === "kubernetes.io/dockerconfigjson"),
    },
    configmaps: configmaps && { total: configmaps.length },
    ingresses: ingresses && { total: ingresses.length, tls: count(ingresses, (i) => i.tls) },
    helm: helm && {
      total: helm.length,
      deployed: count(helm, (h) => h.status === "deployed"),
      failed: count(helm, (h) => h.status === "failed"),
    },
  };
}

const GIB = 1024 ** 3;

/** `"1.2 / 4.0 cores"` from millicores; null without allocatable. */
export function coresDetail(usedMillis: number, allocatableMillis: number): string | null {
  if (allocatableMillis <= 0) return null;
  return `${(usedMillis / 1000).toFixed(1)} / ${(allocatableMillis / 1000).toFixed(1)} cores`;
}

/** `"3.1 / 16.0 GiB"` from bytes; null without allocatable. */
export function memoryDetail(usedBytes: number, allocatableBytes: number): string | null {
  if (allocatableBytes <= 0) return null;
  return `${(usedBytes / GIB).toFixed(1)} / ${(allocatableBytes / GIB).toFixed(1)} GiB`;
}

/** True when a backend error is an RBAC denial (HTTP 403 / "… is forbidden"). */
export function isForbiddenError(message: string): boolean {
  return /\bforbidden\b|\b403\b/i.test(message);
}
