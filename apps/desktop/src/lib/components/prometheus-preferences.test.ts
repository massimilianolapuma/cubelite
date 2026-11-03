import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  prometheusDetect: vi.fn(),
  prometheusTest: vi.fn(),
  prometheusSaveAuth: vi.fn(async () => {}),
  prometheusAuthMethod: vi.fn(async () => "none"),
}));

import PrometheusPreferences from "./PrometheusPreferences.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { prometheus } from "#lib/stores/prometheus.svelte.ts";
import { prometheusAuthMethod, prometheusDetect, prometheusSaveAuth, prometheusTest } from "#lib/tauri.ts";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prometheusAuthMethod).mockResolvedValue("none");
  app.activeCluster = "prod";
  app.kubeconfigPath = "/k";
  prometheus.setEndpoint("prod", null);
});

describe("PrometheusPreferences (#510)", () => {
  it("detects an in-cluster Prometheus and saves it with cluster credentials", async () => {
    vi.mocked(prometheusDetect).mockResolvedValueOnce([
      { namespace: "monitoring", name: "prometheus-operated", port: 9090, https: false },
    ]);
    render(PrometheusPreferences);
    await fireEvent.click(screen.getByRole("radio", { name: "In cluster" }));
    await fireEvent.click(screen.getByRole("button", { name: "Detect" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Use" }));
    expect(screen.getByLabelText("Service")).toHaveValue("prometheus-operated");
    expect(screen.getByLabelText("Authentication")).toHaveValue("none");
    expect(screen.queryByRole("option", { name: "Bearer token" })).not.toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText("Grafana URL"), { target: { value: "https://grafana.example" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(prometheus.endpointFor("prod")).toEqual({
        target: { kind: "in-cluster", namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false },
        cluster: null,
        grafanaUrl: "https://grafana.example",
        grafanaDatasource: null,
        skipTlsVerify: false,
      }),
    );
  });

  it("tests and saves an Azure Monitor endpoint with the Azure CLI", async () => {
    vi.mocked(prometheusTest).mockResolvedValueOnce({
      version: "unknown",
      cadvisor: true,
      kubeStateMetrics: true,
      clusters: ["aks-prod", "aks-test"],
    });
    render(PrometheusPreferences);
    await fireEvent.click(screen.getByRole("radio", { name: "External" }));
    await fireEvent.input(screen.getByLabelText("Prometheus URL"), {
      target: { value: "https://grafana.example" },
    });
    await fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "azure-cli" } });
    expect(screen.getByText(/works only with/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await fireEvent.input(screen.getByLabelText("Prometheus URL"), {
      target: { value: "https://ws-1.westeurope.prometheus.monitor.azure.com" },
    });
    await fireEvent.input(screen.getByLabelText("Cluster label"), { target: { value: "aks-prod" } });
    await fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("clusters: aks-prod, aks-test"));
    expect(vi.mocked(prometheusTest).mock.calls[0][3]).toEqual({ method: "azure-cli" });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(prometheusSaveAuth).toHaveBeenCalled());
    expect(vi.mocked(prometheusSaveAuth).mock.calls[0][2]).toEqual({ method: "azure-cli" });
    expect(prometheus.endpointFor("prod")?.cluster).toBe("aks-prod");
  });

  it("turning it off removes the endpoint and its secret", async () => {
    prometheus.setEndpoint("prod", {
      target: { kind: "external", url: "https://p.example" },
      cluster: null,
      grafanaUrl: null,
      grafanaDatasource: null,
      skipTlsVerify: false,
    });
    vi.mocked(prometheusAuthMethod).mockResolvedValue("bearer");
    render(PrometheusPreferences);
    await waitFor(() => expect(screen.getByLabelText("Authentication")).toHaveValue("bearer"));
    await fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(prometheus.endpointFor("prod")).toBeNull());
    expect(vi.mocked(prometheusSaveAuth).mock.calls[0][2]).toEqual({ method: "none" });
  });
});
