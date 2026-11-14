import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";

// A list reload replaces every object of the lists with a new one (#659): the
// panel that shows one of them must not take that for another object.

vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  getResourceYaml: vi.fn(async () => "kind: Deployment\n"),
  getDynamicResourceYaml: vi.fn(async () => "kind: DaemonSet\n"),
  prometheusMetrics: vi.fn(() => new Promise(() => {})),
  prometheusSparklines: vi.fn(() => new Promise(() => {})),
  listPods: vi.fn(async () => []),
  listDeployments: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  resourceFacts: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import DeploymentDrawer from "./deployments/DeploymentDrawer.svelte";
import PodDrawer from "./pods/PodDrawer.svelte";
import NodeDrawer from "./nodes/NodeDrawer.svelte";
import ObjectYamlDrawer from "./dynamic/ObjectYamlDrawer.svelte";
import MetricsSection from "./metrics/MetricsSection.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { prometheus } from "#lib/stores/prometheus.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import {
  getResourceYaml,
  prometheusMetrics,
  type DeploymentInfo,
  type NodeInfo,
  type PodInfo,
  type PromEndpoint,
} from "#lib/tauri.ts";

function pod(overrides: Partial<PodInfo> = {}): PodInfo {
  return {
    name: "api-0",
    namespace: "default",
    phase: "Running",
    ready: true,
    restarts: 0,
    ready_containers: 1,
    total_containers: 1,
    node: "node-1",
    pod_ip: "10.0.0.7",
    qos_class: "Burstable",
    containers: [{ name: "api", image: "registry.example/api:1.4", ready: true }],
    labels: {},
    creation_timestamp: null,
    ...overrides,
  } as PodInfo;
}

function dep(overrides: Partial<DeploymentInfo> = {}): DeploymentInfo {
  return {
    name: "api",
    namespace: "shop",
    replicas: 3,
    ready_replicas: 3,
    images: ["registry.example/api:1.4"],
    selector: { app: "api" },
    strategy: "RollingUpdate",
    conditions: [],
    creation_timestamp: null,
    ...overrides,
  };
}

const node = (overrides: Partial<NodeInfo> = {}): NodeInfo =>
  ({ name: "node-1", status: "Ready", roles: ["worker"], version: "v1.30.2", creation_timestamp: null, ...overrides }) as NodeInfo;

const endpoint: PromEndpoint = {
  target: { kind: "in-cluster", namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false },
  cluster: null,
  grafanaUrl: null,
  grafanaDatasource: null,
  skipTlsVerify: false,
} as PromEndpoint;

const body = () => document.querySelector<HTMLElement>("[data-panel-body]")!;

/** Scrolls the panel down, applies `change`, and lets every effect run. */
async function scrolledThen(change: () => Promise<unknown>) {
  body().scrollTop = 160;
  await change();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return body().scrollTop;
}

beforeEach(() => {
  vi.clearAllMocks();
  app.namespace = null;
  app.kubeconfigPath = "";
  app.activeCluster = null;
  resources.clear();
});

describe("a list reload with the panel open (#659)", () => {
  it("keeps the Deployment panel where it was scrolled when the reload returns the same deployment", async () => {
    const view = render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });
    expect(await scrolledThen(() => view.rerender({ deployment: dep({ ready_replicas: 2 }) }))).toBe(160);
  });

  it("starts the Deployment panel at its top for another deployment", async () => {
    const view = render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });
    expect(await scrolledThen(() => view.rerender({ deployment: dep({ name: "worker" }) }))).toBe(0);
  });

  it("keeps the Pod panel where it was scrolled when the reload returns the same pod", async () => {
    const view = render(PodDrawer, { props: { pod: pod(), onClose: vi.fn() } });
    expect(await scrolledThen(() => view.rerender({ pod: pod({ restarts: 1 }) }))).toBe(160);
  });

  it("starts the Pod panel at its top for a pod of the same name in another namespace", async () => {
    const view = render(PodDrawer, { props: { pod: pod(), onClose: vi.fn() } });
    expect(await scrolledThen(() => view.rerender({ pod: pod({ namespace: "shop" }) }))).toBe(0);
  });

  it("keeps the Node panel where it was scrolled when the reload returns the same node", async () => {
    const view = render(NodeDrawer, { props: { name: "node-1", info: node(), onClose: vi.fn() } });
    expect(await scrolledThen(() => view.rerender({ info: node({ status: "NotReady" }) }))).toBe(160);
  });

  it("starts the generic panel at its top for an object of the same name in another namespace", async () => {
    app.kubeconfigPath = "/k";
    app.activeCluster = "prod";
    const view = render(ObjectYamlDrawer, {
      props: { view: "daemonsets", kind: "daemon set", name: "agent", namespace: "default", onClose: vi.fn() },
    });
    expect(await scrolledThen(() => view.rerender({ namespace: "kube-system" }))).toBe(0);
  });

  it("keeps the generic panel where it was scrolled when the reload returns a new summary", async () => {
    app.kubeconfigPath = "/k";
    app.activeCluster = "prod";
    const view = render(ObjectYamlDrawer, {
      props: { view: "daemonsets", kind: "daemon set", name: "agent", namespace: "default", summary: [["Ready", "1"]], onClose: vi.fn() },
    });
    await screen.findByText(/kind: DaemonSet/);
    expect(await scrolledThen(() => view.rerender({ summary: [["Ready", "2"]] }))).toBe(160);
  });

  it("does not fetch the open YAML again when the reload returns the same deployment", async () => {
    app.kubeconfigPath = "/k";
    app.activeCluster = "prod";
    const view = render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });
    await fireEvent.click(screen.getByRole("button", { name: "YAML" }));
    await screen.findByText(/kind: Deployment/);
    expect(getResourceYaml).toHaveBeenCalledTimes(1);
    await view.rerender({ deployment: dep({ ready_replicas: 2 }) });
    await tick();
    expect(getResourceYaml).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/kind: Deployment/)).toBeInTheDocument();
  });
});

describe("MetricsSection across a list reload (#659)", () => {
  beforeEach(() => {
    app.kubeconfigPath = "/k";
    app.activeCluster = "prod";
    prometheus.setEndpoint("prod", endpoint);
  });

  it("does not ask Prometheus again when the reload returns the same workload", async () => {
    const view = render(MetricsSection, { namespace: "shop", workload: { kind: "deployment", name: "api" } });
    await waitFor(() => expect(prometheusMetrics).toHaveBeenCalledTimes(1));
    await view.rerender({ namespace: "shop", workload: { kind: "deployment", name: "api" } });
    await tick();
    expect(prometheusMetrics).toHaveBeenCalledTimes(1);
  });

  it("asks Prometheus for another workload", async () => {
    const view = render(MetricsSection, { namespace: "shop", workload: { kind: "deployment", name: "api" } });
    await waitFor(() => expect(prometheusMetrics).toHaveBeenCalledTimes(1));
    await view.rerender({ workload: { kind: "deployment", name: "worker" } });
    await waitFor(() => expect(prometheusMetrics).toHaveBeenCalledTimes(2));
    expect(prometheusMetrics).toHaveBeenLastCalledWith("/k", "prod", endpoint, {
      namespace: "shop",
      workload: { kind: "deployment", name: "worker" },
      range: "1h",
      perContainer: true,
    });
  });
});
