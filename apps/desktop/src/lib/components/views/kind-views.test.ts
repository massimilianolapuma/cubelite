import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  listEvents: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  listServices: vi.fn(async () => []),
  listIngresses: vi.fn(async () => []),
  listConfigMaps: vi.fn(async () => []),
  listSecrets: vi.fn(async () => []),
  listHelmReleases: vi.fn(async () => []),
  listJobs: vi.fn(async () => []),
  listCronJobs: vi.fn(async () => []),
  listStatefulSets: vi.fn(async () => []),
  listPvcs: vi.fn(async () => []),
  listNodes: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import ServicesView from "./ServicesView.svelte";
import IngressesView from "./IngressesView.svelte";
import ConfigMapsView from "./ConfigMapsView.svelte";
import SecretsView from "./SecretsView.svelte";
// Static: NodesView pulls in the node drawer and its charts (#530), whose
// first transform must not count against the test timeout.
import NodesView from "./NodesView.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { lists } from "#lib/stores/lists.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import * as tauri from "#lib/tauri.ts";

beforeEach(() => {
  app.view = "services";
  app.activeCluster = "prod";
  app.kubeconfigPath = "/home/u/.kube/config";
  app.namespace = null;
  resources.clear();
  lists.resetSession();
  lists.groupByNamespace = false;
});

type Lister = "listServices" | "listIngresses" | "listConfigMaps" | "listSecrets" | "listHelmReleases" | "listJobs" | "listCronJobs" | "listStatefulSets" | "listPvcs" | "listNodes";

/** The cluster answers `rows` for the next load of a kind. */
function serve(lister: Lister, rows: unknown[]) {
  vi.mocked(tauri[lister] as (...args: never[]) => Promise<unknown[]>).mockResolvedValueOnce(rows);
}

/** Renders a kind's view over `rows` and waits for its list. */
async function renderList(View: unknown, lister: Lister, rows: unknown[]) {
  serve(lister, rows);
  render(View as never);
  await screen.findByTestId("list-scroller");
}

const badge = (label: string) => screen.getByText(label, { selector: "[data-state] *" }).closest("[data-state]")!;


describe("ServicesView", () => {
  it("renders kubectl-convention columns and rows", async () => {
    await renderList(ServicesView, "listServices", [
      {
        name: "web",
        namespace: "default",
        service_type: "LoadBalancer",
        cluster_ip: "10.0.0.1",
        external_ips: ["203.0.113.9"],
        ports: ["80/TCP", "443:30443/TCP"],
        creation_timestamp: null,
      },
    ]);
    for (const h of ["Name", "Type", "Cluster-IP", "External-IP", "Ports", "Age"]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("LoadBalancer")).toBeInTheDocument();
    expect(screen.getByText("80/TCP, 443:30443/TCP")).toBeInTheDocument();
  });

  it("shows placeholder rows while loading, never the empty message (#606)", async () => {
    let answer: (rows: unknown[]) => void = () => {};
    vi.mocked(tauri.listServices).mockReturnValueOnce(new Promise((resolve) => (answer = resolve as never)));
    render(ServicesView);
    expect(screen.getByRole("status", { name: "Loading services" })).toBeInTheDocument();
    expect(screen.queryByText(/^No services/)).not.toBeInTheDocument();
    answer([]);
    expect(await screen.findByRole("heading", { name: "No services in any namespace" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading services" })).not.toBeInTheDocument();
  });

  it("names the namespace in the empty state", async () => {
    app.namespace = "payments";
    render(ServicesView);
    expect(await screen.findByRole("heading", { name: "No services in payments" })).toBeInTheDocument();
  });

  it("shows the load error and retries (#606)", async () => {
    vi.mocked(tauri.listServices).mockRejectedValueOnce(new Error("connection reset"));
    render(ServicesView);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load services");
    expect(alert).toHaveTextContent("connection reset");

    serve("listServices", [
      { name: "web", namespace: "default", service_type: "ClusterIP", cluster_ip: null, external_ips: [], ports: [], creation_timestamp: null },
    ]);
    await fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("web")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says so when RBAC forbids the list", async () => {
    app.namespace = "payments";
    vi.mocked(tauri.listServices).mockRejectedValueOnce(new Error('services is forbidden: User "dev" cannot list'));
    render(ServicesView);
    expect(await screen.findByText("You are not allowed to list services in payments.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});

describe("IngressesView", () => {
  it("renders hosts, tls ports and address", async () => {
    await renderList(IngressesView, "listIngresses", [
      {
        name: "web",
        namespace: "default",
        class: "nginx",
        hosts: ["app.example.com"],
        addresses: ["203.0.113.9"],
        tls: true,
        creation_timestamp: null,
      },
    ]);
    expect(screen.getByText("app.example.com")).toBeInTheDocument();
    expect(screen.getByText("80, 443")).toBeInTheDocument();
    expect(screen.getByText("nginx")).toBeInTheDocument();
  });
});

describe("ConfigMapsView", () => {
  it("renders name and data count", async () => {
    await renderList(ConfigMapsView, "listConfigMaps", [
      { name: "settings", namespace: "default", data_count: 3, creation_timestamp: null },
    ]);
    expect(screen.getByText("settings")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});

describe("SecretsView", () => {
  const secret = {
    name: "creds",
    namespace: "default",
    secret_type: "Opaque",
    data: { password: "hunter2" },
    creation_timestamp: null,
  };

  it("masks values and shows the local-only warning pill", async () => {
    await renderList(SecretsView, "listSecrets", [secret]);
    expect(screen.getByText(/decoded on this machine only/)).toBeInTheDocument();
    expect(screen.getByText("••••••••")).toBeInTheDocument();
    expect(screen.queryByText("hunter2")).toBeNull();
  });

  it("reveals and hides values per row", async () => {
    await renderList(SecretsView, "listSecrets", [secret]);
    await fireEvent.click(screen.getByRole("button", { name: /Reveal/ }));
    expect(screen.getByText("hunter2")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Hide/ }));
    expect(screen.queryByText("hunter2")).toBeNull();
  });
});

describe("HelmView", () => {
  it("renders columns, status badges and chart", async () => {
    const { default: HelmView } = await import("./HelmView.svelte");
    await renderList(HelmView, "listHelmReleases", [
      {
        name: "web",
        namespace: "default",
        revision: 3,
        status: "deployed",
        chart: "nginx-15.1.2",
        app_version: "1.27",
        updated: null,
      },
      {
        name: "queue",
        namespace: "default",
        revision: 1,
        status: "pending-upgrade",
        chart: null,
        app_version: null,
        updated: null,
      },
      { name: "old", namespace: "default", revision: 9, status: "failed", chart: null, app_version: null, updated: null },
    ]);
    for (const h of ["Name", "Namespace", "Rev", "Status", "Chart", "Updated"]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
    expect(badge("deployed")).toHaveAttribute("data-state", "ok");
    expect(badge("pending-upgrade")).toHaveAttribute("data-state", "warn");
    expect(badge("failed")).toHaveAttribute("data-state", "err");
    expect(screen.getByText("nginx-15.1.2")).toBeInTheDocument();
  });

  it("offers a status chip per state present, worst first", async () => {
    const { default: HelmView } = await import("./HelmView.svelte");
    const release = (name: string, status: string) => ({ name, namespace: "default", revision: 1, status, chart: null, app_version: null, updated: null });
    await renderList(HelmView, "listHelmReleases", [release("a", "deployed"), release("b", "failed"), release("c", "deployed")]);
    const group = screen.getByRole("group", { name: "Filter by status" });
    expect([...group.querySelectorAll("button")].map((b) => b.textContent?.replace(/\s+/g, " ").trim())).toEqual(["Failed 1", "Deployed 2"]);
    await fireEvent.click(within(group).getByRole("button", { name: /Failed/ }));
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.queryByText("a")).not.toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    const { default: HelmView } = await import("./HelmView.svelte");
    render(HelmView);
    expect(await screen.findByRole("heading", { name: "No Helm releases in any namespace" })).toBeInTheDocument();
  });
});

describe("workload views", () => {
  it("JobsView renders completions and marks failures by weight", async () => {
    const { default: JobsView } = await import("./JobsView.svelte");
    await renderList(JobsView, "listJobs", [
      { name: "migrate", namespace: "default", completions: 2, succeeded: 1, active: 0, failed: 1, creation_timestamp: null },
    ]);
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("migrate")).toBeInTheDocument();
    const failed = document.querySelector("[data-attention]")!;
    expect(failed).toHaveTextContent("1");
    expect(failed).toHaveAttribute("data-attention", "true");
    expect(failed.getAttribute("style") ?? "").not.toContain("color");
  });

  it("CronJobsView renders schedule and suspend", async () => {
    const { default: CronJobsView } = await import("./CronJobsView.svelte");
    await renderList(CronJobsView, "listCronJobs", [
      { name: "backup", namespace: "ops", schedule: "0 3 * * *", suspend: true, active: 0, last_schedule: null, creation_timestamp: null },
    ]);
    expect(screen.getByText("0 3 * * *")).toBeInTheDocument();
    expect(screen.getByText("True")).toHaveAttribute("data-attention", "true");
  });

  it("StatefulSetsView derives status", async () => {
    const { default: StatefulSetsView } = await import("./StatefulSetsView.svelte");
    await renderList(StatefulSetsView, "listStatefulSets", [
      { name: "db", namespace: "default", replicas: 3, ready_replicas: 2, creation_timestamp: null },
    ]);
    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(badge("Progressing")).toHaveAttribute("data-state", "warn");
  });

  it("NodesView renders status, roles and version", async () => {
    await renderList(NodesView, "listNodes", [
      { name: "node-1", status: "Ready", roles: ["control-plane"], version: "v1.30.2", creation_timestamp: null },
      { name: "node-2", status: "NotReady", roles: [], version: "v1.30.2", creation_timestamp: null },
    ]);
    expect(badge("Ready")).toHaveAttribute("data-state", "ok");
    expect(badge("NotReady")).toHaveAttribute("data-state", "err");
    expect(screen.getByText("control-plane")).toBeInTheDocument();
    expect(screen.getAllByText("v1.30.2")).toHaveLength(2);
  });

  it("NodesView says this cluster, whatever namespace is selected", async () => {
    app.namespace = "payments";
    render(NodesView);
    expect(await screen.findByRole("heading", { name: "No nodes in this cluster" })).toBeInTheDocument();
  });

  it("PvcsView renders bound claim details", async () => {
    const { default: PvcsView } = await import("./PvcsView.svelte");
    await renderList(PvcsView, "listPvcs", [
      { name: "data", namespace: "default", status: "Bound", volume: "pv-1", capacity: "10Gi", access_modes: ["ReadWriteOnce"], storage_class: "fast", creation_timestamp: null },
      { name: "gone", namespace: "default", status: "Lost", volume: null, capacity: null, access_modes: [], storage_class: null, creation_timestamp: null },
    ]);
    expect(badge("Bound")).toHaveAttribute("data-state", "ok");
    expect(badge("Lost")).toHaveAttribute("data-state", "err");
    expect(screen.getByText("10Gi")).toBeInTheDocument();
    expect(screen.getByText("fast")).toBeInTheDocument();
  });
});

describe("Namespace column (#546)", () => {
  const ns = "team-a";
  const cases: [string, Lister, unknown, () => Promise<{ default: unknown }>][] = [
    ["services", "listServices", { name: "web", namespace: ns, service_type: "ClusterIP", cluster_ip: null, external_ips: [], ports: [], creation_timestamp: null }, () => import("./ServicesView.svelte")],
    ["ingresses", "listIngresses", { name: "web", namespace: ns, class: null, hosts: [], addresses: [], tls: false, creation_timestamp: null }, () => import("./IngressesView.svelte")],
    ["configmaps", "listConfigMaps", { name: "settings", namespace: ns, data_count: 1, creation_timestamp: null }, () => import("./ConfigMapsView.svelte")],
    ["jobs", "listJobs", { name: "migrate", namespace: ns, completions: 1, succeeded: 1, active: 0, failed: 0, creation_timestamp: null }, () => import("./JobsView.svelte")],
    ["cronjobs", "listCronJobs", { name: "backup", namespace: ns, schedule: "0 3 * * *", suspend: false, active: 0, last_schedule: null, creation_timestamp: null }, () => import("./CronJobsView.svelte")],
    ["statefulsets", "listStatefulSets", { name: "db", namespace: ns, replicas: 1, ready_replicas: 1, creation_timestamp: null }, () => import("./StatefulSetsView.svelte")],
    ["pvcs", "listPvcs", { name: "data", namespace: ns, status: "Bound", volume: null, capacity: null, access_modes: [], storage_class: null, creation_timestamp: null }, () => import("./PvcsView.svelte")],
    ["secrets", "listSecrets", { name: "creds", namespace: ns, secret_type: "Opaque", data: {}, creation_timestamp: null }, async () => ({ default: SecretsView })],
  ];

  it.each(cases)("%s shows the namespace with a sortable header", async (_kind, lister, row, load) => {
    const { default: View } = await load();
    await renderList(View, lister, [row]);
    expect(screen.getByRole("button", { name: "Sort by Namespace" })).toBeInTheDocument();
    expect(screen.getByText(ns)).toBeInTheDocument();
  });

  it("nodes, cluster-scoped, have no namespace column and no group toggle", async () => {
    await renderList(NodesView, "listNodes", [{ name: "node-1", status: "Ready", roles: [], version: "v1.30.2", creation_timestamp: null }]);
    expect(screen.queryByRole("button", { name: "Sort by Namespace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Group by namespace" })).toBeNull();
  });
});
