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
import {
  clusterCapacity,
  listPodMetrics,
  listPods,
  type ContainerResourcesInfo,
  type DeploymentInfo,
  type PodInfo,
  type PodMetricsInfo,
  type QuantityInfo,
  type TemplateContainerInfo,
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

/** Loads pods, then the metrics, through the store; an Error is metrics-server not answering. */
async function loadWithMetrics(pods: PodInfo[], metrics: PodMetricsInfo[] | Error) {
  if (metrics instanceof Error) vi.mocked(listPodMetrics).mockRejectedValueOnce(metrics);
  else vi.mocked(listPodMetrics).mockResolvedValueOnce(metrics);
  await loadPods(pods);
  await vi.waitFor(() => expect(resources.metricsKnown).toBe(true));
}

const Mi = 1024 * 1024;
const q = (text: string, amount: number | null): QuantityInfo => ({ text, amount });
/** cpu 250m / 500m, memory 256Mi / 512Mi. */
const API_RESOURCES: ContainerResourcesInfo = {
  cpu: { request: q("250m", 250), limit: q("500m", 500) },
  memory: { request: q("256Mi", 256 * Mi), limit: q("512Mi", 512 * Mi) },
};
/** A sidecar with a CPU request only. */
const MESH_RESOURCES: ContainerResourcesInfo = {
  cpu: { request: q("50m", 50), limit: null },
  memory: { request: null, limit: null },
};
const TEMPLATE: TemplateContainerInfo[] = [
  { name: "api", image: "registry.example/api:1.4", sidecar: false, resources: API_RESOURCES },
  { name: "mesh", image: "registry.example/mesh:1.0", sidecar: true, resources: MESH_RESOURCES },
];
/** api uses 260m of CPU and 498Mi of memory in pod api-0. */
const API_0_METRICS: PodMetricsInfo = {
  name: "api-0",
  namespace: "default",
  cpu_millis: 260,
  memory_bytes: 498 * Mi,
  containers: [{ name: "api", cpu_millis: 260, memory_bytes: 498 * Mi }],
};
/** api-0 of the deployment: its api container runs with the template's resources. */
const apiPod = (resources: ContainerResourcesInfo = API_RESOURCES) =>
  pod({ labels: { app: "api" }, containers: [{ name: "api", image: "registry.example/api:1.4", ready: true, resources }] });
const UNAVAILABLE = "Usage unavailable: metrics-server did not answer.";
const resourcesSection = () => document.querySelector<HTMLElement>('[data-section="resources"]');
const resourceCard = (name: string) => resourcesSection()!.querySelector<HTMLElement>(`[data-container="${name}"]`)!;
const resourceRow = (card: HTMLElement, resource: "cpu" | "memory") =>
  card.querySelector<HTMLElement>(`[data-resource-row="${resource}"]`)!;

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
    expect(document.querySelector("[data-container] [data-image]")).toHaveAttribute("title", "registry.example/otel:1");
  });

  it("shows a container's image tag as its own element, apart from the repository by weight", () => {
    const image = "registry.example.internal:5000/platform/team/backend-services/orders-api:2.14.3-rc.1";
    render(PodDrawer, {
      props: { pod: pod({ containers: [{ name: "orders", image, ready: true }] as PodInfo["containers"] }), onClose: vi.fn() },
    });
    const row = screen.getByText("orders").closest<HTMLElement>("[data-container]")!;
    const ref = row.querySelector<HTMLElement>("[data-image]")!;
    expect(ref).toHaveAttribute("title", image);
    const tag = ref.querySelector<HTMLElement>("[data-image-tag]")!;
    expect(tag.textContent).toBe("2.14.3-rc.1");
    expect(tag).toHaveClass("text-text", "font-semibold");
    // The image's name is its own element, whole; the registry and path in front are what gives way.
    const name = ref.querySelector<HTMLElement>("[data-image-name]")!;
    expect(name.textContent).toBe("orders-api");
    expect(name).toHaveClass("text-text-muted", "font-normal");
    expect(name).not.toHaveClass("truncate");
    const prefix = ref.querySelector<HTMLElement>("[data-image-prefix]")!;
    expect(prefix.textContent).toBe("registry.example.internal:5000/platform/team/backend-services/");
    expect(prefix).toHaveClass("truncate", "text-text-muted", "font-normal");
    expect(tag).not.toHaveClass("truncate");
    // The whole reference still reads as one string.
    expect(ref.textContent).toBe(image);
  });

  it("shows the tag of an image pinned by tag and digest, with the digest in the tooltip", () => {
    const image = `ghcr.io/x/api:2.1@sha256:${"a".repeat(64)}`;
    render(PodDrawer, {
      props: { pod: pod({ containers: [{ name: "api", image, ready: true }] as PodInfo["containers"] }), onClose: vi.fn() },
    });
    const ref = document.querySelector<HTMLElement>("[data-container] [data-image]")!;
    expect(ref).toHaveAttribute("title", image);
    expect(ref.querySelector("[data-image-tag]")!.textContent).toBe("2.1");
  });

  it("a container image without a tag shows latest", () => {
    render(PodDrawer, {
      props: { pod: pod({ containers: [{ name: "api", image: "nginx", ready: true }] as PodInfo["containers"] }), onClose: vi.fn() },
    });
    expect(document.querySelector("[data-container] [data-image-tag]")!.textContent).toBe("latest");
    // No slash: the whole repository is the name, and nothing is in front of it.
    expect(document.querySelector("[data-container] [data-image-name]")!.textContent).toBe("nginx");
    expect(document.querySelector("[data-container] [data-image-prefix]")).toBeNull();
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

  it("shows a container's requests, limits and usage in its card; a container without resources has no rows", async () => {
    const withResources = pod({
      containers: [
        { name: "api", image: "registry.example/api:1.4", ready: true, resources: API_RESOURCES },
        { name: "legacy", image: "registry.example/legacy:1", ready: true },
      ],
    });
    await loadWithMetrics([withResources], [API_0_METRICS]);
    render(PodDrawer, { props: { pod: withResources, onClose: vi.fn() } });
    const card = document.querySelector<HTMLElement>('[data-container="api"]')!;
    expect(card).toHaveTextContent("260m of 500m · request 250m");
    expect(card).toHaveTextContent("498Mi of 512Mi · request 256Mi");
    expect(resourceRow(card, "memory").querySelector("[data-level]")).toHaveAttribute("data-level", "critical");
    expect(document.querySelector('[data-container="legacy"] [data-resource-row]')).toBeNull();
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

  it("shows each image on its own line, its tag as its own element", () => {
    const digest = `sha256:${"0123456789abcdef".repeat(4)}`;
    const images = ["registry.example.internal:5000/platform/orders-api:2.14.3-rc.1", `ghcr.io/x/sidecar@${digest}`];
    render(DeploymentDrawer, { props: { deployment: dep({ images }), onClose: vi.fn() } });
    const value = screen.getByText("Images", { selector: "dt" }).nextElementSibling as HTMLElement;
    const refs = [...value.querySelectorAll<HTMLElement>("[data-image]")];
    expect(refs.map((el) => el.getAttribute("title"))).toEqual(images);
    expect(refs.map((el) => el.querySelector("[data-image-tag]")!.textContent)).toEqual(["2.14.3-rc.1", "sha256:0123456789ab"]);
    expect(refs.map((el) => el.querySelector("[data-image-name]")!.textContent)).toEqual(["orders-api", "sidecar"]);
    expect(refs.map((el) => el.querySelector("[data-image-prefix]")!.textContent)).toEqual([
      "registry.example.internal:5000/platform/",
      "ghcr.io/x/",
    ]);
    expect(refs[0].querySelector("[data-image-tag]")).toHaveClass("text-text", "font-semibold");
    // No comma-joined string any more.
    expect(value.textContent).not.toContain(", ");
  });

  it("names a single image Image, and shows an en dash when there is none", () => {
    const one = render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });
    const value = screen.getByText("Image", { selector: "dt" }).nextElementSibling as HTMLElement;
    expect(value.querySelector("[data-image-tag]")!.textContent).toBe("1.4");
    one.unmount();
    render(DeploymentDrawer, { props: { deployment: dep({ images: [] }), onClose: vi.fn() } });
    const empty = screen.getByText("Image", { selector: "dt" }).nextElementSibling as HTMLElement;
    expect(empty).toHaveTextContent("–");
    expect(empty).toHaveAttribute("data-missing", "true");
  });

  it("has Logs as its one primary action", () => {
    render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });
    const footer = screen.getByRole("button", { name: "Logs" }).closest("footer")!;
    expect(footer.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(within(footer).getByRole("button", { name: "Rollout Restart" })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "YAML" })).toBeInTheDocument();
  });

  it("shows each container's requests, limits and the usage of its pods in a Resources section", async () => {
    await loadWithMetrics([apiPod()], [API_0_METRICS]);
    render(DeploymentDrawer, { props: { deployment: dep({ containers: TEMPLATE }), onClose: vi.fn() } });
    const section = resourcesSection()!;
    expect(within(section).getByText("Resources")).toBeInTheDocument();
    expect(section.querySelectorAll("[data-container]")).toHaveLength(2);

    const api = resourceCard("api");
    expect(api).toHaveTextContent("260m of 500m · request 250m");
    expect(api).toHaveTextContent("498Mi of 512Mi · request 256Mi");
    expect(resourceRow(api, "memory").querySelector("[data-level]")).toHaveAttribute("data-level", "critical");
    expect(resourceRow(api, "cpu").querySelector("[data-level]")).toHaveAttribute("data-level", "normal");

    const mesh = resourceCard("mesh");
    expect(mesh).toHaveTextContent("sidecar");
    expect(mesh).toHaveTextContent("request 50m · no limit");
    expect(resourceRow(mesh, "cpu").querySelector("[data-meter-track]")).toBeNull();
    expect(resourceRow(api, "cpu").querySelector("[data-meter-track]")).not.toBeNull();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });

  it("says once that usage is unavailable when metrics-server did not answer", async () => {
    await loadWithMetrics([apiPod()], new Error("the server could not find the requested resource"));
    render(DeploymentDrawer, { props: { deployment: dep({ containers: TEMPLATE }), onClose: vi.fn() } });
    expect(screen.getAllByText(UNAVAILABLE)).toHaveLength(1);
    expect(resourceCard("api")).toHaveTextContent("limit 500m · request 250m");
    expect(resourceCard("api")).toHaveTextContent("limit 512Mi · request 256Mi");
  });

  it("does not say usage is unavailable before metrics-server was asked", () => {
    render(DeploymentDrawer, { props: { deployment: dep({ containers: TEMPLATE }), onClose: vi.fn() } });
    expect(resourcesSection()).not.toBeNull();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });

  it("shows requests and limits without a meter value, and no unavailable sentence, when the deployment has no pods", async () => {
    await loadWithMetrics([], []);
    render(DeploymentDrawer, { props: { deployment: dep({ containers: TEMPLATE }), onClose: vi.fn() } });
    const api = resourceCard("api");
    expect(api).toHaveTextContent("limit 500m · request 250m");
    expect(resourceRow(api, "cpu").querySelector('[data-testid="meter-value"]')).toHaveTextContent("–");
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });

  it("has no Resources section for a payload without containers", () => {
    render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });
    expect(resourcesSection()).toBeNull();
    expect(screen.queryByText("Resources")).toBeNull();
  });

  it("shows a limit it cannot read as the cluster wrote it, with no percent", async () => {
    const unreadable: TemplateContainerInfo[] = [
      {
        name: "api",
        image: null,
        sidecar: false,
        resources: { ...API_RESOURCES, memory: { request: q("256Mi", 256 * Mi), limit: q("1Xi", null) } },
      },
    ];
    await loadWithMetrics([apiPod(unreadable[0].resources)], [API_0_METRICS]);
    render(DeploymentDrawer, { props: { deployment: dep({ containers: unreadable }), onClose: vi.fn() } });
    const memory = resourceRow(resourceCard("api"), "memory");
    expect(memory).toHaveTextContent("498Mi of 1Xi · request 256Mi");
    expect(memory.querySelector('[data-testid="meter-value"]')).toHaveTextContent("–");
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
