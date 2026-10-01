import { describe, it, expect } from "vitest";
import {
  coresDetail,
  isForbiddenError,
  memoryDetail,
  summarize,
  type OverviewInput,
} from "./overview-summary";
import type {
  DeploymentInfo,
  HelmReleaseInfo,
  IngressInfo,
  PodInfo,
  SecretInfo,
  ServiceInfo,
} from "$lib/tauri";

// Same fixture as cubeliteTests/OverviewSummaryTests.swift: both apps must
// produce the same numbers.
const pod = (phase: string | null): PodInfo => ({
  name: `p-${phase}`,
  namespace: "default",
  phase,
  ready: phase === "Running",
  restarts: 0,
  ready_containers: 1,
  total_containers: 1,
  node: null,
  pod_ip: null,
  qos_class: null,
  containers: [],
  labels: {},
  creation_timestamp: null,
});
const deploy = (replicas: number, ready: number): DeploymentInfo => ({
  name: `d-${replicas}-${ready}`,
  namespace: "default",
  replicas,
  ready_replicas: ready,
  images: [],
  selector: {},
  strategy: null,
  conditions: [],
  creation_timestamp: null,
});
const service = (type: string | null): ServiceInfo => ({
  name: `s-${type}`,
  namespace: "default",
  service_type: type,
  cluster_ip: null,
  external_ips: [],
  ports: [],
  creation_timestamp: null,
});
const secret = (type: string | null): SecretInfo => ({
  name: `x-${type}`,
  namespace: "default",
  secret_type: type,
  data: {},
  creation_timestamp: null,
});
const ingress = (tls: boolean): IngressInfo => ({
  name: `i-${tls}`,
  namespace: "default",
  class: null,
  hosts: [],
  addresses: [],
  tls,
  creation_timestamp: null,
});
const helm = (status: string | null): HelmReleaseInfo => ({
  name: `h-${status}`,
  namespace: "default",
  revision: 1,
  status,
  chart: null,
  app_version: null,
  updated: null,
});

const fixture: OverviewInput = {
  pods: [pod("Running"), pod("Running"), pod("Pending"), pod("Failed"), pod("Succeeded")],
  deployments: [deploy(2, 2), deploy(3, 1), deploy(0, 0)],
  namespaces: [
    { name: "default", phase: "Active" },
    { name: "old", phase: "Terminating" },
  ],
  services: [service("ClusterIP"), service("ClusterIP"), service("NodePort"), service("LoadBalancer"), service("ExternalName")],
  secrets: [secret("Opaque"), secret("kubernetes.io/tls"), secret("kubernetes.io/dockerconfigjson"), secret("kubernetes.io/service-account-token")],
  configmaps: [{ name: "c", namespace: "default", data_count: 1, creation_timestamp: null }],
  ingresses: [ingress(true), ingress(false)],
  helm: [helm("deployed"), helm("failed"), helm("superseded")],
  nodes: 3,
};

describe("summarize", () => {
  it("counts the shared fixture", () => {
    expect(summarize(fixture)).toEqual({
      nodes: 3,
      pods: { total: 5, running: 2, pending: 1, failed: 1 },
      deployments: { total: 3, healthy: 2, degraded: 1 },
      namespaces: { total: 2, active: 1 },
      services: { total: 5, clusterIP: 2, nodePort: 1, loadBalancer: 1 },
      secrets: { total: 4, opaque: 1, tls: 1, docker: 1 },
      configmaps: { total: 1 },
      ingresses: { total: 2, tls: 1 },
      helm: { total: 3, deployed: 1, failed: 1 },
    });
  });

  it("keeps kinds that are not loaded as null", () => {
    const s = summarize({
      ...fixture,
      services: null,
      secrets: null,
      configmaps: null,
      ingresses: null,
      helm: null,
      nodes: null,
    });
    expect(s.services).toBeNull();
    expect(s.secrets).toBeNull();
    expect(s.configmaps).toBeNull();
    expect(s.ingresses).toBeNull();
    expect(s.helm).toBeNull();
    expect(s.nodes).toBeNull();
    expect(s.pods.total).toBe(5);
  });

  it("counts an empty cluster as zeros", () => {
    const s = summarize({ ...fixture, pods: [], deployments: [], namespaces: [], services: [] });
    expect(s.pods).toEqual({ total: 0, running: 0, pending: 0, failed: 0 });
    expect(s.deployments).toEqual({ total: 0, healthy: 0, degraded: 0 });
    expect(s.services?.total).toBe(0);
  });
});

describe("capacity details", () => {
  it("formats cores from millicores and memory in GiB, one decimal", () => {
    expect(coresDetail(1200, 4000)).toBe("1.2 / 4.0 cores");
    expect(memoryDetail(3.5 * 1024 ** 3, 16 * 1024 ** 3)).toBe("3.5 / 16.0 GiB");
  });

  it("is null without allocatable capacity", () => {
    expect(coresDetail(100, 0)).toBeNull();
    expect(memoryDetail(100, 0)).toBeNull();
  });
});

describe("isForbiddenError", () => {
  it("recognises apiserver RBAC denials", () => {
    expect(
      isForbiddenError(
        'kubernetes client error: ApiError: services is forbidden: User "dev" cannot list resource "services" (Forbidden)',
      ),
    ).toBe(true);
    expect(isForbiddenError("request failed: 403")).toBe(true);
  });

  it("ignores other failures", () => {
    expect(isForbiddenError("connection refused")).toBe(false);
    expect(isForbiddenError("timeout after 4030ms")).toBe(false);
  });
});
