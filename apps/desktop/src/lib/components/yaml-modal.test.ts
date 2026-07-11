import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/svelte";

vi.mock("$lib/tauri", () => ({
  getResourceYaml: vi.fn(),
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  listEvents: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import YamlModal from "./YamlModal.svelte";
import { getResourceYaml } from "$lib/tauri";
import { app } from "$lib/stores/app.svelte";

beforeEach(() => {
  vi.clearAllMocks();
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod";
});

describe("YamlModal", () => {
  it("fetches and renders the resource YAML", async () => {
    vi.mocked(getResourceYaml).mockResolvedValue("kind: Pod\nmetadata:\n  name: api-0\n");
    render(YamlModal, {
      props: { resourceType: "pod", namespace: "default", name: "api-0", onClose: vi.fn() },
    });
    expect(getResourceYaml).toHaveBeenCalledWith(
      "/home/u/.kube/config",
      "pod",
      "default",
      "api-0",
      "prod",
    );
    expect(await screen.findByText(/kind: Pod/)).toBeInTheDocument();
    expect(screen.getByText("api-0.yaml")).toBeInTheDocument();
    expect(screen.getByText("Copy")).toBeInTheDocument();
  });

  it("shows the fetch error", async () => {
    vi.mocked(getResourceYaml).mockRejectedValue(new Error("not found"));
    render(YamlModal, {
      props: { resourceType: "pod", namespace: "default", name: "gone", onClose: vi.fn() },
    });
    expect(await screen.findByText("not found")).toBeInTheDocument();
  });
});
