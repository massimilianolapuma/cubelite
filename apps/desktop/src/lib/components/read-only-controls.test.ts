import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";

// Every write control of a read-only cluster (#662, spec §5.4): in place,
// aria-disabled, its reason as title and description, and a press calls no
// write wrapper of #lib/tauri.ts. On a writable cluster the same press does.
vi.mock("#lib/tauri.ts", () => ({
  listPods: vi.fn(async () => []),
  listNamespaces: vi.fn(async () => []),
  listDeployments: vi.fn(async () => []),
  listEvents: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  listServices: vi.fn(async () => []),
  listIngresses: vi.fn(async () => []),
  listConfigMaps: vi.fn(async () => []),
  listSecrets: vi.fn(async () => []),
  listHelmReleases: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
  getResourceYaml: vi.fn(() => new Promise(() => {})),
  resourceFacts: vi.fn(() => new Promise(() => {})),
  evaluateResources: vi.fn(),
  // The write wrappers: none may be called on a read-only cluster.
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  applyResourceYaml: vi.fn(async () => undefined),
  applyResources: vi.fn(),
  clearResourcesOverride: vi.fn(async () => undefined),
  startExec: vi.fn(async () => undefined),
  execSend: vi.fn(async () => undefined),
  stopExec: vi.fn(async () => undefined),
  startPortForward: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import * as tauri from "#lib/tauri.ts";
import type { DeploymentInfo, OverrideInfo, PodInfo, TemplateContainerInfo } from "#lib/tauri.ts";
import PodDrawer from "./pods/PodDrawer.svelte";
import DeploymentDrawer from "./deployments/DeploymentDrawer.svelte";
import DeploymentTable from "./DeploymentTable.svelte";
import OverrideBanner from "./deployments/OverrideBanner.svelte";
import PodsView from "./views/PodsView.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { clusterSettings } from "#lib/stores/cluster-settings.svelte.ts";
import { layout } from "#lib/stores/layout.svelte.ts";
import { lists } from "#lib/stores/lists.svelte.ts";
import { mutations, SCALE_DEBOUNCE_MS } from "#lib/stores/mutations.svelte.ts";
import { resourceEditor } from "#lib/stores/resourceEditor.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { setAccess } from "#lib/stores/access-mock.ts";

const WRITES = [
  "deletePod",
  "restartDeployment",
  "scaleDeployment",
  "applyResourceYaml",
  "applyResources",
  "clearResourcesOverride",
  "startExec",
  "execSend",
] as const;

function expectNoWrite() {
  for (const name of WRITES) expect(vi.mocked(tauri[name]), name).not.toHaveBeenCalled();
}

const REASON = "prod is read-only";

/** Off with the reason: in place, focusable, described, titled. */
function expectBlocked(control: HTMLElement) {
  expect(control).toHaveAttribute("aria-disabled", "true");
  expect(control).not.toBeDisabled();
  expect(control).toHaveAccessibleDescription(REASON);
  expect(control).toHaveAttribute("title", REASON);
}

function expectOpen(control: HTMLElement) {
  expect(control).not.toHaveAttribute("aria-disabled", "true");
  expect(control).not.toHaveAttribute("data-blocked");
}

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
    deployment: "api",
    ...overrides,
  } as PodInfo;
}

const TEMPLATE: TemplateContainerInfo[] = [
  {
    name: "api",
    image: "registry.example/api:1.4",
    sidecar: false,
    resources: { cpu: { request: { text: "250m", amount: 250 }, limit: null }, memory: { request: null, limit: null } },
  },
];

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
    containers: TEMPLATE,
    ...overrides,
  };
}

const OVERRIDE: OverrideInfo = {
  at: "2026-11-13T11:20:00Z",
  containers: [
    {
      name: "api",
      original: { cpu: { request: "250m", limit: "500m" }, memory: { request: "256Mi", limit: "512Mi" } },
      applied: { cpu: { request: "250m", limit: "500m" }, memory: { request: "256Mi", limit: "768Mi" } },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  clusterSettings.reset();
  resourceEditor.close();
  mutations.draftScales = {};
  mutations.pendingScales = {};
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod";
  app.namespace = null;
  app.selectedPod = null;
  lists.resetSession();
  lists.groupByNamespace = false;
  layout.contentWidth = 0;
  resources.clear();
  resources.deployments = [dep()];
});

afterEach(() => {
  vi.useRealTimers();
  resourceEditor.close();
});

describe("PodDrawer", () => {
  const footer = () => document.querySelector<HTMLElement>("footer")!;

  it("on a read-only cluster: Shell, Restart, Delete and Adjust on deployment say why and do nothing", async () => {
    setAccess("prod", "read_only");
    const onDelete = vi.fn();
    const open = vi.spyOn(resourceEditor, "open");
    render(PodDrawer, { props: { pod: pod(), onClose: vi.fn(), onDelete } });

    const controls = [
      screen.getByRole("button", { name: "Shell" }),
      within(footer()).getByRole("button", { name: "Restart" }),
      within(footer()).getByRole("button", { name: "Delete" }),
      screen.getByRole("button", { name: "Adjust on deployment api" }),
    ];
    for (const control of controls) {
      expectBlocked(control);
      await fireEvent.click(control);
    }
    expect(onDelete).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "api-0 shell" })).toBeNull();
    expectNoWrite();
    open.mockRestore();
  });

  it("keeps Logs, YAML and Forward open on a read-only cluster", async () => {
    setAccess("prod", "read_only");
    render(PodDrawer, { props: { pod: pod(), onClose: vi.fn() } });
    expectOpen(screen.getByRole("button", { name: "Open logs" }));
    expectOpen(screen.getByRole("button", { name: "YAML" }));
    expectOpen(screen.getByRole("button", { name: "Forward" }));
    await fireEvent.click(screen.getByRole("button", { name: "YAML" }));
    expect(await screen.findByRole("dialog", { name: "api-0.yaml" })).toBeInTheDocument();
  });

  it("says it once above the actions, with the way out", () => {
    setAccess("prod", "read_only");
    render(PodDrawer, { props: { pod: pod(), onClose: vi.fn() } });
    const notice = screen.getByTestId("read-only-notice");
    expect(notice).toHaveTextContent("prod is read-only");
    expect(within(notice).getByRole("button", { name: "Make writable" })).toBeInTheDocument();
    // Above the actions: before the first of them, in the same footer.
    const first = within(footer()).getByRole("button", { name: "Open logs" });
    expect(footer().contains(notice)).toBe(true);
    expect(notice.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("on a writable cluster: no notice, and the controls act", async () => {
    setAccess("prod", "writable");
    const onDelete = vi.fn();
    const open = vi.spyOn(resourceEditor, "open").mockResolvedValue();
    render(PodDrawer, { props: { pod: pod(), onClose: vi.fn(), onDelete } });
    expect(screen.queryByTestId("read-only-notice")).toBeNull();

    // First: the reload after the restart answers no deployment.
    await fireEvent.click(screen.getByRole("button", { name: "Adjust on deployment api" }));
    expect(open).toHaveBeenCalledOnce();
    await fireEvent.click(within(footer()).getByRole("button", { name: "Restart" }));
    expect(tauri.deletePod).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api-0", "prod");
    await fireEvent.click(within(footer()).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledOnce();
    // Last: the shell is a modal over the rest.
    await fireEvent.click(screen.getByRole("button", { name: "Shell" }));
    expect(await screen.findByRole("dialog", { name: "api-0 shell" })).toBeInTheDocument();
    await vi.waitFor(() => expect(tauri.startExec).toHaveBeenCalledOnce());
    open.mockRestore();
  });
});

describe("DeploymentDrawer", () => {
  it("on a read-only cluster: Rollout Restart, Adjust and the stepper say why and do nothing", async () => {
    vi.useFakeTimers();
    setAccess("prod", "read_only");
    const open = vi.spyOn(resourceEditor, "open");
    render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });

    const controls = [
      screen.getByRole("button", { name: "Rollout Restart" }),
      screen.getByRole("button", { name: "Adjust" }),
      screen.getByRole("button", { name: "Scale up" }),
      screen.getByRole("button", { name: "Scale down" }),
    ];
    for (const control of controls) {
      expectBlocked(control);
      await fireEvent.click(control);
    }
    await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
    expect(open).not.toHaveBeenCalled();
    expect(mutations.pendingScale("default", "api")).toBeNull();
    expectNoWrite();
    open.mockRestore();
  });

  it("keeps Logs and YAML open, and shows the notice above the actions", () => {
    setAccess("prod", "read_only");
    render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });
    expectOpen(screen.getByRole("button", { name: "Logs" }));
    expectOpen(screen.getByRole("button", { name: "YAML" }));
    const footer = document.querySelector<HTMLElement>("footer")!;
    const notice = within(footer).getByTestId("read-only-notice");
    expect(notice).toHaveTextContent("prod is read-only");
    const first = within(footer).getByRole("button", { name: "Logs" });
    expect(notice.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("on a writable cluster: the controls act", async () => {
    vi.useFakeTimers();
    const open = vi.spyOn(resourceEditor, "open").mockResolvedValue();
    render(DeploymentDrawer, { props: { deployment: dep(), onClose: vi.fn() } });
    expect(screen.queryByTestId("read-only-notice")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Rollout Restart" }));
    expect(tauri.restartDeployment).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
    expect(open).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole("button", { name: "Scale up" }));
    await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
    expect(tauri.scaleDeployment).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api", 4, "prod");
    open.mockRestore();
  });
});

describe("DeploymentTable row", () => {
  it("on a read-only cluster: Restart and the stepper say why, do nothing and do not open the row", async () => {
    vi.useFakeTimers();
    setAccess("prod", "read_only");
    const onRowClick = vi.fn();
    render(DeploymentTable, { props: { deployments: [dep()], onRowClick } });
    const controls = [
      screen.getByRole("button", { name: "Restart" }),
      screen.getByRole("button", { name: "Scale up" }),
      screen.getByRole("button", { name: "Scale down" }),
    ];
    for (const control of controls) {
      expectBlocked(control);
      await fireEvent.click(control);
    }
    await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
    expect(onRowClick).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("on a writable cluster: Restart acts", async () => {
    render(DeploymentTable, { props: { deployments: [dep()] } });
    await fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(tauri.restartDeployment).toHaveBeenCalledOnce();
  });
});

describe("OverrideBanner", () => {
  it("on a read-only cluster: Keep these values and Restore say why and do nothing", async () => {
    setAccess("prod", "read_only");
    const open = vi.spyOn(resourceEditor, "open");
    render(OverrideBanner, { props: { deployment: dep(), override: OVERRIDE } });
    for (const name of ["Keep these values", "Restore"]) {
      const control = screen.getByRole("button", { name });
      expectBlocked(control);
      await fireEvent.click(control);
    }
    expect(screen.queryByRole("button", { name: "Remove mark" })).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expectNoWrite();
    open.mockRestore();
  });

  it("Remove mark says why once the cluster turns read-only while it asks", async () => {
    render(OverrideBanner, { props: { deployment: dep(), override: OVERRIDE } });
    await fireEvent.click(screen.getByRole("button", { name: "Keep these values" }));
    setAccess("prod", "read_only");
    await tick();
    const remove = screen.getByRole("button", { name: "Remove mark" });
    expectBlocked(remove);
    await fireEvent.click(remove);
    expectNoWrite();
  });

  it("on a writable cluster: Remove mark and Restore act", async () => {
    const open = vi.spyOn(resourceEditor, "open").mockResolvedValue();
    render(OverrideBanner, { props: { deployment: dep(), override: OVERRIDE } });
    await fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ name: "api" }), "restore");
    await fireEvent.click(screen.getByRole("button", { name: "Keep these values" }));
    await fireEvent.click(screen.getByRole("button", { name: "Remove mark" }));
    expect(tauri.clearResourcesOverride).toHaveBeenCalledOnce();
    open.mockRestore();
  });
});

describe("PodsView delete", () => {
  it("the confirmation's Delete Pod says why once the cluster turns read-only, and deletes nothing", async () => {
    app.selectedPod = pod();
    render(PodsView);
    const drawerFooter = document.querySelector<HTMLElement>("footer")!;
    await fireEvent.click(within(drawerFooter).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("button", { name: "Delete Pod" });
    expectOpen(confirm);

    setAccess("prod", "read_only");
    await tick();
    expectBlocked(screen.getByRole("button", { name: "Delete Pod" }));
    await fireEvent.click(screen.getByRole("button", { name: "Delete Pod" }));
    expectNoWrite();
  });

  it("on a writable cluster the confirmation deletes", async () => {
    app.selectedPod = pod();
    render(PodsView);
    const drawerFooter = document.querySelector<HTMLElement>("footer")!;
    await fireEvent.click(within(drawerFooter).getByRole("button", { name: "Delete" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Delete Pod" }));
    expect(tauri.deletePod).toHaveBeenCalledOnce();
  });
});
