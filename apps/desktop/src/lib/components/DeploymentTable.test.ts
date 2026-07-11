import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("$lib/tauri", () => ({
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  listPods: vi.fn(async () => []),
  listNamespaces: vi.fn(async () => []),
  listDeployments: vi.fn(async () => []),
  listEvents: vi.fn(async () => []),
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
import { restartDeployment, scaleDeployment, type DeploymentInfo } from "$lib/tauri";
import { app } from "$lib/stores/app.svelte";

beforeEach(() => {
  vi.clearAllMocks();
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod";
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

describe("DeploymentTable", () => {
  it("renders the spec'd column headers", () => {
    render(DeploymentTable, { props: { deployments: [] } });
    for (const h of ["Name", "Ready", "Status", "Age", "Replicas · Actions"]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
  });

  it("shows the empty state when there are no deployments", () => {
    render(DeploymentTable, { props: { deployments: [] } });
    expect(screen.getByText("No deployments found.")).toBeInTheDocument();
  });

  it("derives Available when all replicas are ready", () => {
    render(DeploymentTable, { props: { deployments: [dep()] } });
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getByText("3/3")).toBeInTheDocument();
  });

  it("derives Progressing when replicas are missing", () => {
    render(DeploymentTable, { props: { deployments: [dep({ ready_replicas: 1 })] } });
    expect(screen.getByText("Progressing")).toBeInTheDocument();
  });

  it("scales up via the stepper", async () => {
    render(DeploymentTable, { props: { deployments: [dep()] } });
    await fireEvent.click(screen.getByLabelText("Scale up"));
    expect(scaleDeployment).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api", 4, "prod");
  });

  it("scales down via the stepper", async () => {
    render(DeploymentTable, { props: { deployments: [dep()] } });
    await fireEvent.click(screen.getByLabelText("Scale down"));
    expect(scaleDeployment).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api", 2, "prod");
  });

  it("triggers a rollout restart from the row", async () => {
    render(DeploymentTable, { props: { deployments: [dep()] } });
    await fireEvent.click(screen.getByText("Restart"));
    expect(restartDeployment).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api", "prod");
  });

  it("calls onRowClick with the deployment", async () => {
    const onRowClick = vi.fn();
    render(DeploymentTable, { props: { deployments: [dep()], onRowClick } });
    await fireEvent.click(screen.getByText("api"));
    expect(onRowClick).toHaveBeenCalledWith(dep());
  });
});
