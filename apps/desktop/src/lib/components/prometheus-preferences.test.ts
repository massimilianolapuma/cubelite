import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  prometheusDetect: vi.fn(),
  prometheusTest: vi.fn(),
  prometheusSaveAuth: vi.fn(async () => {}),
  prometheusAuthMethod: vi.fn(async () => "none"),
  prometheusDisconnect: vi.fn(async () => {}),
}));

import PrometheusPreferences from "./PrometheusPreferences.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { prometheus } from "#lib/stores/prometheus.svelte.ts";
import {
  prometheusAuthMethod,
  prometheusDetect,
  prometheusDisconnect,
  prometheusSaveAuth,
  prometheusTest,
} from "#lib/tauri.ts";

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
      { kind: "prometheus", namespace: "monitoring", name: "prometheus-operated", port: 9090, https: false },
    ]);
    render(PrometheusPreferences);
    await fireEvent.click(screen.getByRole("radio", { name: "In cluster" }));
    await fireEvent.click(screen.getByRole("button", { name: "Detect" }));
    await fireEvent.click(await screen.findByRole("button", { name: /Use prometheus/ }));
    expect(screen.getByLabelText("Service")).toHaveValue("prometheus-operated");
    expect(screen.queryByLabelText("Authentication")).not.toBeInTheDocument();
    expect(screen.getByText(/with your cluster credentials/)).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText("Grafana URL"), { target: { value: "https://grafana.example" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(prometheus.endpointFor("prod")).toEqual({
        target: { kind: "in-cluster", namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false },
        cluster: null,
        grafanaUrl: "https://grafana.example",
        grafanaDatasource: null,
        grafanaService: null,
        skipTlsVerify: false,
      }),
    );
  });

  it("picks the detected Grafana, opened through a port-forward without a URL (#525)", async () => {
    vi.mocked(prometheusDetect).mockResolvedValueOnce([
      { kind: "prometheus", namespace: "monitoring", name: "prometheus-operated", port: 9090, https: false },
      { kind: "grafana", namespace: "monitoring", name: "kps-grafana", port: 80, https: false },
    ]);
    render(PrometheusPreferences);
    await fireEvent.click(screen.getByRole("radio", { name: "In cluster" }));
    await fireEvent.click(screen.getByRole("button", { name: "Detect" }));
    await fireEvent.click(await screen.findByRole("button", { name: /Use prometheus/ }));
    await fireEvent.click(screen.getByRole("button", { name: /Use grafana monitoring\/kps-grafana/ }));
    expect(screen.getByLabelText("Service")).toHaveValue("prometheus-operated");
    expect(screen.getByTestId("grafana-service")).toHaveTextContent(
      "Grafana in the cluster: monitoring/kps-grafana:80, opened through a port-forward",
    );
    await fireEvent.input(screen.getByLabelText("Grafana URL"), { target: { value: "https://grafana.example" } });
    expect(screen.getByTestId("grafana-service")).toHaveTextContent("(the URL above wins)");
    await fireEvent.input(screen.getByLabelText("Grafana URL"), { target: { value: "" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(prometheus.endpointFor("prod")?.grafanaService).toEqual({
        namespace: "monitoring",
        service: "kps-grafana",
        port: 80,
        https: false,
      }),
    );
    // Saving closes the context's old forwards.
    await waitFor(() => expect(prometheusDisconnect).toHaveBeenCalledWith("prod"));

    // Only in-cluster endpoints use it.
    await fireEvent.click(screen.getByRole("radio", { name: "External" }));
    expect(screen.queryByTestId("grafana-service")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("radio", { name: "In cluster" }));
    await fireEvent.click(screen.getByRole("button", { name: "Clear the in-cluster Grafana" }));
    expect(screen.queryByTestId("grafana-service")).not.toBeInTheDocument();
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

  it("keeps a stored Azure CLI choice when switching modes back and forth", async () => {
    prometheus.setEndpoint("prod", {
      target: { kind: "external", url: "https://ws.westeurope.prometheus.monitor.azure.com" },
      cluster: null,
      grafanaUrl: null,
      grafanaDatasource: null,
      skipTlsVerify: false,
    });
    vi.mocked(prometheusAuthMethod).mockResolvedValue("azure-cli");
    render(PrometheusPreferences);
    await waitFor(() => expect(screen.getByLabelText("Authentication")).toHaveValue("azure-cli"));
    await fireEvent.click(screen.getByRole("radio", { name: "In cluster" }));
    await fireEvent.click(screen.getByRole("radio", { name: "External" }));
    expect(screen.getByLabelText("Authentication")).toHaveValue("azure-cli");
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
