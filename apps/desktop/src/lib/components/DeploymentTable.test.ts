import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", () => ({
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  listPods: vi.fn(async () => []),
  listNamespaces: vi.fn(async () => []),
  listDeployments: vi.fn(async () => []),
  listEvents: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  listServices: vi.fn(async () => []),
  listIngresses: vi.fn(async () => []),
  listConfigMaps: vi.fn(async () => []),
  listSecrets: vi.fn(async () => []),
  listHelmReleases: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import DeploymentTable from "./DeploymentTable.svelte";
import { restartDeployment, scaleDeployment, type DeploymentInfo } from "#lib/tauri.ts";
import { SCALE_DEBOUNCE_MS } from "#lib/stores/mutations.svelte.ts";
import { app } from "#lib/stores/app.svelte.ts";
import { layout } from "#lib/stores/layout.svelte.ts";
import { lists } from "#lib/stores/lists.svelte.ts";

beforeEach(() => {
  vi.clearAllMocks();
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod";
  app.namespace = null;
  lists.resetSession();
  lists.groupByNamespace = false;
  layout.contentWidth = 0;
});

function dep(overrides: Partial<DeploymentInfo> = {}): DeploymentInfo {
  return {
    name: "api",
    namespace: "default",
    replicas: 3,
    ready_replicas: 3,
    images: [],
    selector: {},
    strategy: null,
    conditions: [],
    creation_timestamp: null,
    ...overrides,
  };
}

const badge = (label: string) => screen.getByText(label, { selector: "[data-state] *" }).closest("[data-state]")!;

describe("DeploymentTable", () => {
  it("renders the spec'd column headers", () => {
    render(DeploymentTable, { props: { deployments: [dep()] } });
    for (const h of ["Name", "Namespace", "Ready", "Status", "Age", "Replicas · Actions"]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
  });

  it("shows the empty state when there are no deployments", () => {
    render(DeploymentTable, { props: { deployments: [] } });
    expect(screen.getByRole("heading", { name: "No deployments in any namespace" })).toBeInTheDocument();
  });

  it("shows placeholder rows while the first load is in flight, and a failed load as an error (#606)", async () => {
    const loading = render(DeploymentTable, { props: { deployments: [], loaded: false } });
    expect(screen.getByRole("status", { name: "Loading deployments" })).toBeInTheDocument();
    expect(screen.queryByText(/^No deployments/)).not.toBeInTheDocument();
    loading.unmount();

    render(DeploymentTable, { props: { deployments: [], error: "timeout" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load deployments");
    expect(screen.getByRole("alert")).toHaveTextContent("timeout");
  });

  it("derives Available when all replicas are ready", () => {
    render(DeploymentTable, { props: { deployments: [dep()] } });
    expect(badge("Available")).toHaveAttribute("data-state", "ok");
    expect(screen.getByText("3/3")).toBeInTheDocument();
  });

  it("derives Progressing when replicas are missing", () => {
    render(DeploymentTable, { props: { deployments: [dep({ ready_replicas: 1 })] } });
    expect(badge("Progressing")).toHaveAttribute("data-state", "warn");
  });

  it("batches stepper clicks and applies once after the debounce", async () => {
    vi.useFakeTimers();
    try {
      render(DeploymentTable, { props: { deployments: [dep()] } });
      await fireEvent.click(screen.getByLabelText("Scale up"));
      await fireEvent.click(screen.getByLabelText("Scale up"));
      // Pending target is shown immediately; nothing is sent yet.
      // It is bold with a triangle, not coloured.
      const pending = screen.getByText("5");
      expect(pending).toHaveAttribute("data-pending", "true");
      expect(pending.querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "warn");
      expect(scaleDeployment).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
      expect(scaleDeployment).toHaveBeenCalledTimes(1);
      expect(scaleDeployment).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api", 5, "prod");
    } finally {
      vi.useRealTimers();
    }
  });

  it("scales down via the stepper", async () => {
    vi.useFakeTimers();
    try {
      render(DeploymentTable, { props: { deployments: [dep()] } });
      await fireEvent.click(screen.getByLabelText("Scale down"));
      await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
      expect(scaleDeployment).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api", 2, "prod");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing when the stepper returns to the current count", async () => {
    vi.useFakeTimers();
    try {
      render(DeploymentTable, { props: { deployments: [dep()] } });
      await fireEvent.click(screen.getByLabelText("Scale up"));
      await fireEvent.click(screen.getByLabelText("Scale down"));
      await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
      expect(scaleDeployment).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws one segment per replica with ready ones filled", () => {
    render(DeploymentTable, { props: { deployments: [dep({ ready_replicas: 2 })] } });
    expect(screen.getByRole("img", { name: "2 of 3 replicas ready" })).toBeInTheDocument();
  });

  it("triggers a rollout restart from the row", async () => {
    render(DeploymentTable, { props: { deployments: [dep()] } });
    await fireEvent.click(screen.getByText("Restart"));
    expect(restartDeployment).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api", "prod");
  });

  it("Enter on a control inside the row does not also select the row", async () => {
    const onRowClick = vi.fn();
    render(DeploymentTable, { props: { deployments: [dep()], onRowClick } });
    await fireEvent.keyDown(screen.getByLabelText("Scale up"), { key: "Enter" });
    expect(onRowClick).not.toHaveBeenCalled();
    await fireEvent.keyDown(screen.getByText("api").closest('[role="button"]')!, { key: "Enter" });
    expect(onRowClick).toHaveBeenCalledWith(dep());
  });

  it("keeps Restart focusable and marks it busy while a restart runs", async () => {
    let done: () => void = () => {};
    vi.mocked(restartDeployment).mockReturnValueOnce(new Promise<void>((resolve) => (done = resolve)));
    render(DeploymentTable, { props: { deployments: [dep()] } });
    const restart = screen.getByRole("button", { name: "Restart" });
    await fireEvent.click(restart);
    expect(restart).toHaveAttribute("aria-busy", "true");
    expect(restart).not.toBeDisabled();
    done();
    await vi.waitFor(() => expect(restart).not.toHaveAttribute("aria-busy"));
  });

  it("calls onRowClick with the deployment", async () => {
    const onRowClick = vi.fn();
    render(DeploymentTable, { props: { deployments: [dep()], onRowClick } });
    await fireEvent.click(screen.getByText("api"));
    expect(onRowClick).toHaveBeenCalledWith(dep());
  });
});

describe("DeploymentTable: the override badge (#650 §3.3)", () => {
  const OVERRIDE = {
    at: "2026-11-13T11:20:00Z",
    containers: [
      {
        name: "api",
        original: { cpu: { request: "250m", limit: "500m" }, memory: { request: "256Mi", limit: "512Mi" } },
        applied: { cpu: { request: "250m", limit: "500m" }, memory: { request: "256Mi", limit: "768Mi" } },
      },
    ],
  };

  it("marks a row whose resources were overridden from CubeLite, after the name, and no other", () => {
    render(DeploymentTable, {
      props: { deployments: [dep({ resources_override: OVERRIDE }), dep({ name: "web", resources_override: null })] },
    });
    const override = badge("Override");
    expect(override).toHaveAttribute("data-state", "warn");
    const row = override.closest('[role="button"]')!;
    expect(row).toHaveTextContent(/^api/);
    // In the name cell, after the name.
    const nameCell = screen.getByTitle("api").parentElement!;
    expect(nameCell).toContainElement(override as HTMLElement);
    expect(screen.getAllByText("Override")).toHaveLength(1);
  });
});

describe("DeploymentTable beside a docked detail panel (Tonal §3 #2 #11)", () => {
  it("keeps the identifying columns and leaves scale and restart to the panel", () => {
    layout.contentWidth = 1200;
    const d = dep();
    render(DeploymentTable, { props: { deployments: [d], selected: d } });
    expect(screen.queryByText("Replicas · Actions")).toBeNull();
    expect(screen.queryByLabelText("Scale up")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
    for (const h of ["Name", "Namespace", "Ready", "Status", "Age"]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
  });

  it("keeps the controls in the row while the panel overlays the list or nothing is selected", () => {
    layout.contentWidth = 964;
    const d = dep();
    const overlay = render(DeploymentTable, { props: { deployments: [d], selected: d } });
    expect(screen.getByLabelText("Scale up")).toBeInTheDocument();
    overlay.unmount();

    layout.contentWidth = 1200;
    render(DeploymentTable, { props: { deployments: [d] } });
    expect(screen.getByLabelText("Scale up")).toBeInTheDocument();
  });
});
