import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("$lib/tauri", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  listEvents: vi.fn(async () => []),
  listServices: vi.fn(async () => []),
  listIngresses: vi.fn(async () => []),
  listConfigMaps: vi.fn(async () => []),
  listSecrets: vi.fn(async () => []),
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
import { app } from "$lib/stores/app.svelte";
import { resources } from "$lib/stores/resources.svelte";

beforeEach(() => {
  app.view = "services";
  app.activeCluster = "prod";
  app.kubeconfigPath = "/home/u/.kube/config";
  app.namespace = null;
  resources.clear();
});

describe("ServicesView", () => {
  it("renders kubectl-convention columns and rows", () => {
    resources.services = [
      {
        name: "web",
        namespace: "default",
        service_type: "LoadBalancer",
        cluster_ip: "10.0.0.1",
        external_ips: ["203.0.113.9"],
        ports: ["80/TCP", "443:30443/TCP"],
        creation_timestamp: null,
      },
    ];
    render(ServicesView);
    for (const h of ["Name", "Type", "Cluster-IP", "External-IP", "Ports", "Age"]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("LoadBalancer")).toBeInTheDocument();
    expect(screen.getByText("80/TCP, 443:30443/TCP")).toBeInTheDocument();
  });

  it("shows the empty state", () => {
    render(ServicesView);
    expect(screen.getByText("No services found.")).toBeInTheDocument();
  });

  it("shows the load error", async () => {
    const { listServices } = await import("$lib/tauri");
    vi.mocked(listServices).mockRejectedValueOnce(new Error("forbidden"));
    render(ServicesView);
    expect(await screen.findByText("forbidden")).toBeInTheDocument();
  });
});

describe("IngressesView", () => {
  it("renders hosts, tls ports and address", () => {
    resources.ingresses = [
      {
        name: "web",
        namespace: "default",
        class: "nginx",
        hosts: ["app.example.com"],
        addresses: ["203.0.113.9"],
        tls: true,
        creation_timestamp: null,
      },
    ];
    render(IngressesView);
    expect(screen.getByText("app.example.com")).toBeInTheDocument();
    expect(screen.getByText("80, 443")).toBeInTheDocument();
    expect(screen.getByText("nginx")).toBeInTheDocument();
  });
});

describe("ConfigMapsView", () => {
  it("renders name and data count", () => {
    resources.configmaps = [
      { name: "settings", namespace: "default", data_count: 3, creation_timestamp: null },
    ];
    render(ConfigMapsView);
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

  async function renderWithSecret() {
    const { listSecrets } = await import("$lib/tauri");
    vi.mocked(listSecrets).mockResolvedValue([secret]);
    render(SecretsView);
    await screen.findByText("creds");
  }

  it("masks values and shows the local-only warning pill", async () => {
    await renderWithSecret();
    expect(screen.getByText(/never leave this machine/)).toBeInTheDocument();
    expect(screen.getByText("••••••••")).toBeInTheDocument();
    expect(screen.queryByText("hunter2")).toBeNull();
  });

  it("reveals and hides values per row", async () => {
    await renderWithSecret();
    await fireEvent.click(screen.getByRole("button", { name: /Reveal/ }));
    expect(screen.getByText("hunter2")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Hide/ }));
    expect(screen.queryByText("hunter2")).toBeNull();
  });
});
