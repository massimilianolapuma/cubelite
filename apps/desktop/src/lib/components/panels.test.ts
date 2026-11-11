import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", () => ({
  listPods: vi.fn(async () => []),
  listNamespaces: vi.fn(async () => []),
  listDeployments: vi.fn(async () => []),
  listEvents: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  listPodMetrics: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import PodDrawer from "./pods/PodDrawer.svelte";
import DeploymentDrawer from "./deployments/DeploymentDrawer.svelte";
import NodeDrawer from "./nodes/NodeDrawer.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { logPanel } from "#lib/stores/logPanel.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { clusterCapacity, listPods, type DeploymentInfo, type PodInfo } from "#lib/tauri.ts";

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
    namespace: "default",
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

/** Loads pods through the store, as the app does: a count means something only once they answered. */
async function loadPods(pods: PodInfo[]) {
  app.kubeconfigPath = "/k";
  app.activeCluster = "prod";
  vi.mocked(listPods).mockResolvedValue(pods);
  await resources.load();
  app.kubeconfigPath = "";
}

const hero = () => document.querySelector("[data-hero]")!;
const tile = (label: string) => screen.getByText(label, { selector: "[data-tone] *" }).closest("[data-tone]")!;
const terms = () => screen.getAllByRole("term").map((el) => el.textContent);

beforeEach(() => {
  app.namespace = null;
  app.kubeconfigPath = "";
  resources.clear();
});

describe("PodDrawer", () => {
  it("names the kind, and keeps a healthy pod's status a plain line", () => {
    render(PodDrawer, { props: { pod: pod(), onClose: vi.fn() } });
    expect(within(screen.getByRole("dialog", { name: "api-0" })).getByText("Pod")).toBeInTheDocument();
    expect(hero()).toHaveAttribute("data-hero", "none");
    expect(within(hero() as HTMLElement).getByText("Running")).toBeInTheDocument();
  });

  it("puts a failing pod's state in a hero, with what explains it", () => {
    render(PodDrawer, {
      props: { pod: pod({ phase: "CrashLoopBackOff", ready: false, ready_containers: 0, restarts: 23 }), onClose: vi.fn() },
    });
    expect(hero()).toHaveAttribute("data-hero", "error");
    expect(hero()).toHaveTextContent("CrashLoopBackOff");
    expect(hero()).toHaveTextContent("0 of 1 containers ready, 23 restarts");
    expect(hero().querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "err");
  });

  it("puts a pending pod in the attention hero", () => {
    render(PodDrawer, { props: { pod: pod({ phase: "Pending", ready: false, ready_containers: 0 }), onClose: vi.fn() } });
    expect(hero()).toHaveAttribute("data-hero", "warning");
  });

  it("shows restarts and memory as the two tiles; restarts above 3 fill theirs", () => {
    render(PodDrawer, { props: { pod: pod({ restarts: 5 }), onClose: vi.fn() } });
    expect(tile("Restarts")).toHaveTextContent("5");
    expect(tile("Restarts")).toHaveAttribute("data-tone", "warn");
    // No metrics-server answer: an en dash, not a zero.
    expect(tile("Memory")).toHaveTextContent("–");
    expect(tile("Memory")).toHaveAttribute("data-tone", "none");
  });

  it("a completed pod's restarts are history: its tile is not a warning", () => {
    render(PodDrawer, { props: { pod: pod({ phase: "Succeeded", ready: false, restarts: 5 }), onClose: vi.fn() } });
    expect(tile("Restarts")).toHaveAttribute("data-tone", "none");
  });

  it("keeps a long container name and its image inside the row, each with its full text as a tooltip", () => {
    const name = "opentelemetry-collector-contrib-with-a-very-long-suffix";
    render(PodDrawer, {
      props: { pod: pod({ containers: [{ name, image: "registry.example/otel:1", ready: false }] as PodInfo["containers"] }), onClose: vi.fn() },
    });
    expect(screen.getByText(name)).toHaveAttribute("title", name);
    expect(screen.getByText(name)).toHaveClass("truncate");
    expect(screen.getByText("registry.example/otel:1")).toHaveAttribute("title", "registry.example/otel:1");
  });

  it("lists the facts as label and value rows", () => {
    render(PodDrawer, { props: { pod: pod({ node: null }), onClose: vi.fn() } });
    expect(terms()).toEqual(["Namespace", "Node", "Age", "Ready", "Pod IP", "QoS"]);
    expect(screen.getByText("10.0.0.7")).toBeInTheDocument();
  });

  it("tells a container that is not ready by shape and word", () => {
    render(PodDrawer, {
      props: {
        pod: pod({
          containers: [
            { name: "api", image: "a:1", ready: true },
            { name: "sidecar", image: "b:1", ready: false },
          ] as PodInfo["containers"],
        }),
        onClose: vi.fn(),
      },
    });
    const row = (name: string) => screen.getByText(name).closest<HTMLElement>("[data-container]")!;
    expect(row("api").querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "ok");
    expect(row("api")).toHaveTextContent("ready");
    expect(row("sidecar").querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "warn");
    expect(row("sidecar")).toHaveTextContent("not ready");
  });

  it("has one primary action, Open logs, with the others beside it and Delete as destructive text", async () => {
    const onDelete = vi.fn();
    const open = vi.spyOn(logPanel, "openFor").mockResolvedValue(undefined as never);
    render(PodDrawer, { props: { pod: pod(), onClose: vi.fn(), onDelete } });
    const footer = screen.getByRole("button", { name: "Open logs" }).closest("footer")!;
    expect(footer.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open logs" })).toHaveAttribute("data-variant", "primary");
    for (const name of ["Shell", "YAML", "Restart"]) {
      expect(within(footer).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(footer).getByRole("button", { name: "Delete" })).toHaveAttribute("data-variant", "danger");
    await fireEvent.click(screen.getByRole("button", { name: "Open logs" }));
    expect(open).toHaveBeenCalledWith({ namespace: "default", name: "api-0" });
    await fireEvent.click(within(footer).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalled();
    open.mockRestore();
  });

  it("Enter on the heading opens the logs", async () => {
    const open = vi.spyOn(logPanel, "openFor").mockResolvedValue(undefined as never);
    render(PodDrawer, { props: { pod: pod(), onClose: vi.fn() } });
    await fireEvent.keyDown(screen.getByRole("heading", { level: 2, name: "api-0" }), { key: "Enter" });
    expect(open).toHaveBeenCalledWith({ namespace: "default", name: "api-0" });
    open.mockRestore();
  });

  it("shows label chips sorted by key", () => {
    render(PodDrawer, { props: { pod: pod({ labels: { tier: "api", app: "shop" } }), onClose: vi.fn() } });
    expect(screen.getByText("Labels")).toBeInTheDocument();
    expect(screen.getAllByTitle(/=/).map((el) => el.textContent?.trim())).toEqual(["app=shop", "tier=api"]);
  });
});

describe("DeploymentDrawer", () => {
  it("keeps an available deployment's status a plain line", () => {
    render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });
    expect(within(screen.getByRole("dialog", { name: "api" })).getByText("Deployment")).toBeInTheDocument();
    expect(hero()).toHaveAttribute("data-hero", "none");
  });

  it("puts a progressing deployment in the attention hero with how many replicas are ready", () => {
    render(DeploymentDrawer, { props: { deployment: dep({ ready_replicas: 1 }), onClose: vi.fn() } });
    expect(hero()).toHaveAttribute("data-hero", "warning");
    expect(hero()).toHaveTextContent("Progressing");
    expect(hero()).toHaveTextContent("1 of 3 replicas ready");
  });

  it("shows ready replicas and matched pods as the two tiles", async () => {
    await loadPods([pod({ labels: { app: "api" } }), pod({ name: "api-1", labels: { app: "api" } }), pod({ name: "other" })]);
    render(DeploymentDrawer, { props: { deployment: dep({ ready_replicas: 2 }), onClose: vi.fn() } });
    expect(tile("Ready")).toHaveTextContent("2/3");
    expect(tile("Ready")).toHaveAttribute("data-tone", "warn");
    expect(tile("Pods")).toHaveTextContent("2");
  });

  it("shows an en dash, not a zero, while the pods are not known", () => {
    render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });
    expect(tile("Pods")).toHaveTextContent("–");
  });

  it("scales from the panel", () => {
    render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });
    const dialog = screen.getByRole("dialog", { name: "api" });
    expect(within(dialog).getByRole("button", { name: "Scale up" })).toBeInTheDocument();
    expect(within(dialog).getByRole("img", { name: "3 of 3 replicas ready" })).toBeInTheDocument();
  });

  it("gives a condition its word; one that is not True stands out by weight", () => {
    render(DeploymentDrawer, {
      props: {
        deployment: dep({
          conditions: [
            { condition_type: "Available", status: "True", reason: "MinimumReplicasAvailable" },
            { condition_type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" },
          ] as DeploymentInfo["conditions"],
        }),
        onClose: vi.fn(),
      },
    });
    const row = (type: string) => screen.getByText(type, { selector: "[data-condition] *" }).closest<HTMLElement>("[data-condition]")!;
    expect(row("Available")).toHaveAttribute("data-condition", "True");
    expect(row("Progressing")).toHaveAttribute("data-condition", "False");
    expect(row("Progressing")).toHaveTextContent("ProgressDeadlineExceeded");
    expect(row("Progressing").getAttribute("style") ?? "").not.toContain("color");
  });

  it("lists its pods with their state as a shape", async () => {
    await loadPods([pod({ labels: { app: "api" }, phase: "CrashLoopBackOff", ready: false })]);
    render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });
    const row = screen.getByRole("button", { name: /api-0/ });
    expect(row.querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "err");
    expect(row).toHaveTextContent("CrashLoopBackOff");
  });

  it("has Logs as its one primary action", () => {
    render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });
    const footer = screen.getByRole("button", { name: "Logs" }).closest("footer")!;
    expect(footer.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(within(footer).getByRole("button", { name: "Rollout Restart" })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "YAML" })).toBeInTheDocument();
  });
});

describe("NodeDrawer", () => {
  const info = { name: "node-1", status: "Ready", roles: ["control-plane"], version: "v1.30.2", creation_timestamp: null };

  it("shows the node's status, and a node that is not ready as a failure hero", () => {
    const ready = render(NodeDrawer, { props: { name: "node-1", info, onClose: vi.fn() } });
    expect(within(screen.getByRole("dialog", { name: "node-1" })).getByText("Node")).toBeInTheDocument();
    expect(hero()).toHaveAttribute("data-hero", "none");
    ready.unmount();
    render(NodeDrawer, { props: { name: "node-1", info: { ...info, status: "NotReady" }, onClose: vi.fn() } });
    expect(hero()).toHaveAttribute("data-hero", "error");
  });

  it("shows the pods on the node and its CPU use as the two tiles", async () => {
    vi.mocked(clusterCapacity).mockResolvedValueOnce([
      { name: "node-1", cpu_used_millis: 500, cpu_allocatable_millis: 2000, memory_used_bytes: 1, memory_allocatable_bytes: 2 },
    ]);
    await loadPods([pod(), pod({ name: "api-1" }), pod({ name: "elsewhere", node: "node-2" })]);
    render(NodeDrawer, { props: { name: "node-1", info, onClose: vi.fn() } });
    expect(tile("Pods")).toHaveTextContent("2");
    await vi.waitFor(() => expect(tile("CPU")).toHaveTextContent("25%"));
  });

  it("says which namespace the pod count is for when one is selected, and an en dash without metrics", async () => {
    app.namespace = "default";
    await loadPods([]);
    render(NodeDrawer, { props: { name: "node-1", info, onClose: vi.fn() } });
    expect(tile("Pods in default")).toHaveTextContent("0");
    expect(tile("CPU")).toHaveTextContent("–");
  });

  it("shows an en dash for the pod count while the pods are not known", () => {
    render(NodeDrawer, { props: { name: "node-1", info, onClose: vi.fn() } });
    expect(tile("Pods")).toHaveTextContent("–");
  });

  it("still opens for a node the inventory does not have yet", () => {
    render(NodeDrawer, { props: { name: "node-9", info: null, onClose: vi.fn() } });
    expect(screen.getByRole("dialog", { name: "node-9" })).toBeInTheDocument();
    expect(document.querySelector("[data-hero]")).toBeNull();
  });
});
