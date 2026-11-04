import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  elasticTest: vi.fn(),
  elasticSaveAuth: vi.fn(async () => {}),
  elasticAuthMethod: vi.fn(async () => "none"),
  elasticDisconnect: vi.fn(async () => {}),
  prometheusDetect: vi.fn(),
  prometheusTest: vi.fn(),
  prometheusSaveAuth: vi.fn(async () => {}),
  prometheusAuthMethod: vi.fn(async () => "none"),
  prometheusDisconnect: vi.fn(async () => {}),
}));

import ElasticPreferences from "./ElasticPreferences.svelte";
import PrometheusPreferences from "./PrometheusPreferences.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { clusters } from "#lib/stores/clusters.svelte.ts";
import { elastic } from "#lib/stores/elastic.svelte.ts";
import { integrations } from "#lib/stores/integrations.svelte.ts";
import { prometheus } from "#lib/stores/prometheus.svelte.ts";
import { settings } from "#lib/stores/settings.svelte.ts";
import {
  elasticSaveAuth,
  elasticTest,
  prometheusAuthMethod,
  prometheusSaveAuth,
  prometheusTest,
  type ContextInfo,
  type EsEndpoint,
  type PromEndpoint,
} from "#lib/tauri.ts";

const SHARED: PromEndpoint = {
  target: { kind: "external", url: "https://ws-1.westeurope.prometheus.monitor.azure.com" },
  cluster: null,
  grafanaUrl: null,
  grafanaDatasource: null,
  grafanaService: null,
  skipTlsVerify: false,
};

const context = (name: string) => ({ name }) as ContextInfo;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prometheusAuthMethod).mockResolvedValue("none");
  app.activeCluster = "aks-prod";
  app.kubeconfigPath = "/k";
  clusters.contexts = [context("aks-prod"), context("aks-test"), context("minikube")];
  settings.integrationDismissals.value = {};
  for (const store of [prometheus, elastic] as const) {
    store.setDefault(null);
    for (const c of ["aks-prod", "aks-test", "minikube"]) {
      store.setEndpoint(c, null);
      store.setOff(c, false);
      store.setContextSettings(c, null);
    }
  }
});

describe("Prometheus default endpoint (#528)", () => {
  it("saves an external default with its credentials under the default and lists its users", async () => {
    prometheus.setEndpoint("minikube", { ...SHARED, target: { kind: "external", url: "http://localhost:9090" } });
    render(PrometheusPreferences);
    await fireEvent.click(screen.getByRole("radio", { name: "All contexts (default)" }));
    // In-cluster services are per cluster: the default is external only.
    expect(screen.queryByRole("radio", { name: "In cluster" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("radio", { name: "External" }));
    await fireEvent.input(screen.getByLabelText("Prometheus URL"), { target: { value: SHARED.target.kind === "external" ? SHARED.target.url : "" } });
    await fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "azure-cli" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(prometheus.defaultEndpoint?.target).toEqual(SHARED.target));
    const [ctx, endpoint, auth] = vi.mocked(prometheusSaveAuth).mock.calls[0];
    expect(ctx).toBe("aks-prod");
    expect(endpoint.shared).toBe(true);
    expect(auth).toEqual({ method: "azure-cli" });
    expect(prometheus.defaultEndpoint?.shared).toBeUndefined();
    expect(screen.getByTestId("default-used-by")).toHaveTextContent("Used by: aks-prod, aks-test");
    // The banner treats a context covered by the default as configured.
    expect(prometheus.endpointFor("aks-test")?.shared).toBe(true);
  });

  it("uses the default for a context, picks its cluster label from Test connection", async () => {
    prometheus.setDefault(SHARED);
    vi.mocked(prometheusTest).mockResolvedValueOnce({
      version: "unknown",
      cadvisor: true,
      kubeStateMetrics: true,
      clusters: ["aks-dev", "aks-prod-weu", "aks-test"],
    });
    render(PrometheusPreferences);
    expect(screen.getByTestId("default-in-use")).toHaveTextContent(
      "Using the default endpoint · https://ws-1.westeurope.prometheus.monitor.azure.com",
    );
    await fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    // The test reaches the default with the default's credentials.
    expect(vi.mocked(prometheusTest).mock.calls[0][2].shared).toBe(true);
    expect(vi.mocked(prometheusTest).mock.calls[0][3]).toBeUndefined();
    await waitFor(() => expect(screen.getByLabelText("Clusters found")).toHaveValue("aks-prod-weu"));
    expect(screen.getByLabelText("Cluster label")).toHaveValue("aks-prod-weu");
    await fireEvent.change(screen.getByLabelText("Clusters found"), { target: { value: "aks-test" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(prometheus.contextSettings("aks-prod")).toEqual({ cluster: "aks-test" });
    expect(prometheus.endpointFor("aks-prod")?.cluster).toBe("aks-test");
    expect(prometheus.endpointFor("aks-test")?.cluster).toBeNull();
    expect(prometheusSaveAuth).not.toHaveBeenCalled();
  });

  it("turns the default off for a context and back on", async () => {
    prometheus.setDefault(SHARED);
    render(PrometheusPreferences);
    await fireEvent.click(screen.getByRole("button", { name: "Turn off for this context" }));
    await waitFor(() => expect(prometheus.endpointFor("aks-prod")).toBeNull());
    expect(prometheus.useOf("aks-prod")).toBe("off");
    expect(settings.integrationDismissals.value["aks-prod"]).toContain("prometheus");
    expect(integrations.offered("aks-prod")).toEqual([]);
    expect(await screen.findByTestId("default-not-used")).toHaveTextContent("Off for this context");
    await fireEvent.click(screen.getByRole("button", { name: "Use the default endpoint" }));
    await waitFor(() => expect(prometheus.endpointFor("aks-prod")?.shared).toBe(true));
  });

  it("overrides the default from its values, and goes back to it", async () => {
    prometheus.setDefault({ ...SHARED, cluster: "fallback" });
    render(PrometheusPreferences);
    await fireEvent.click(screen.getByRole("button", { name: "Override" }));
    expect(await screen.findByLabelText("Prometheus URL")).toHaveValue(
      "https://ws-1.westeurope.prometheus.monitor.azure.com",
    );
    await fireEvent.input(screen.getByLabelText("Prometheus URL"), { target: { value: "https://own.example" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(prometheus.ownEndpoint("aks-prod")?.target).toEqual({ kind: "external", url: "https://own.example" }));
    expect(await screen.findByTestId("default-not-used")).toHaveTextContent("This context overrides the default endpoint.");
    await fireEvent.click(screen.getByRole("button", { name: "Use the default endpoint" }));
    await waitFor(() => expect(prometheus.ownEndpoint("aks-prod")).toBeNull());
    // The own endpoint's credentials are removed with it.
    expect(vi.mocked(prometheusSaveAuth).mock.calls.at(-1)?.[2]).toEqual({ method: "none" });
    expect(prometheus.endpointFor("aks-prod")?.shared).toBe(true);
  });

  it("Off on a context's own form keeps the default away", async () => {
    prometheus.setDefault(SHARED);
    prometheus.setEndpoint("aks-prod", { ...SHARED, target: { kind: "external", url: "https://own.example" } });
    render(PrometheusPreferences);
    await fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(prometheus.useOf("aks-prod")).toBe("off"));
  });
});

describe("Elasticsearch default endpoint (#528)", () => {
  const ES: EsEndpoint = {
    target: { kind: "external", url: "https://deployment.es.example:9243" },
    indexPattern: "logs-*",
    preset: "ecs",
    kibanaUrl: null,
    kibanaService: null,
    skipTlsVerify: false,
  };

  it("saves a per-context cluster filter on the default", async () => {
    elastic.setDefault(ES);
    vi.mocked(elasticTest).mockResolvedValueOnce({ version: "8.15.0", clusterName: "x", health: "green", indices: 2 });
    render(ElasticPreferences);
    expect(screen.getByLabelText("Cluster filter field")).toHaveAttribute("placeholder", "orchestrator.cluster.name");
    await fireEvent.input(screen.getByLabelText("Cluster filter value"), { target: { value: "aks-prod" } });
    await fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(elasticTest).toHaveBeenCalled());
    expect(vi.mocked(elasticTest).mock.calls[0][2]).toMatchObject({
      shared: true,
      clusterFilter: { field: "", value: "aks-prod" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(elastic.endpointFor("aks-prod")?.clusterFilter).toEqual({ field: "", value: "aks-prod" });
    expect(elastic.endpointFor("aks-test")?.clusterFilter).toBeUndefined();
  });

  it("saves the default's credentials once, for every context", async () => {
    render(ElasticPreferences);
    await fireEvent.click(screen.getByRole("radio", { name: "All contexts (default)" }));
    await fireEvent.click(screen.getByRole("radio", { name: "External" }));
    await fireEvent.input(screen.getByLabelText("Elasticsearch URL"), { target: { value: "https://deployment.es.example:9243" } });
    await fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "api-key" } });
    await fireEvent.input(screen.getByLabelText("API key"), { target: { value: "c2VjcmV0" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(elastic.defaultEndpoint).not.toBeNull());
    expect(vi.mocked(elasticSaveAuth).mock.calls[0][1].shared).toBe(true);
    expect(elastic.endpointFor("minikube")?.shared).toBe(true);
  });
});
