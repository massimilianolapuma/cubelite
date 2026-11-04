import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
  prometheusMetrics: vi.fn(async () => ({ start: 0, end: 1, step: 1, charts: [] })),
  kibanaPortForward: vi.fn(async () => 41000),
  grafanaPortForward: vi.fn(async () => 42000),
  openKibanaDiscover: vi.fn(async () => {}),
  openKibanaWorkload: vi.fn(async () => {}),
  openGrafanaWorkload: vi.fn(async () => {}),
}));

import LogToolbar from "#lib/components/logpanel/LogToolbar.svelte";
import MetricsSection from "#lib/components/metrics/MetricsSection.svelte";
import WorkloadLinks from "./WorkloadLinks.svelte";
import { HISTORY_HINT, METRICS_HINT, showsIntegrationHint } from "#lib/integration-links.ts";
import { app } from "#lib/stores/app.svelte.ts";
import { elastic } from "#lib/stores/elastic.svelte.ts";
import { prometheus } from "#lib/stores/prometheus.svelte.ts";
import { settings } from "#lib/stores/settings.svelte.ts";
import { toasts } from "#lib/stores/toasts.svelte.ts";
import { LogSession } from "#lib/stores/logSession.svelte.ts";
import {
  grafanaPortForward,
  kibanaPortForward,
  openGrafanaWorkload,
  openKibanaWorkload,
  openKibanaDiscover,
  type EsEndpoint,
  type PromEndpoint,
} from "#lib/tauri.ts";

const es: EsEndpoint = {
  target: { kind: "in-cluster", namespace: "logging", service: "es-http", port: 9200, https: true },
  indexPattern: "logs-*",
  preset: "fluent-bit",
  kibanaUrl: "https://kibana.example",
  skipTlsVerify: false,
};

const prom: PromEndpoint = {
  target: { kind: "in-cluster", namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false },
  cluster: "eu",
  grafanaUrl: null,
  grafanaDatasource: "prom",
  grafanaService: { namespace: "monitoring", service: "kps-grafana", port: 80, https: false },
  skipTlsVerify: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  toasts.items = [];
  app.activeCluster = "prod";
  app.kubeconfigPath = "/k";
  app.preferencesOpen = false;
  app.preferencesSection = null;
  settings.integrationHints.value = true;
  elastic.setEndpoint("prod", null);
  prometheus.setEndpoint("prod", null);
});

describe("integration hints (#526)", () => {
  it("shows a hint only without an endpoint and while hints are on", () => {
    expect(showsIntegrationHint(null, true)).toBe(true);
    expect(showsIntegrationHint(null, false)).toBe(false);
    expect(showsIntegrationHint(es, true)).toBe(false);
  });

  it("log toolbar: disabled History with help text, and Set up opens Elasticsearch preferences", async () => {
    render(LogToolbar, { props: { session: new LogSession("shop", "api-0") } });
    const history = screen.getByRole("radio", { name: "History" });
    expect(history).toBeDisabled();
    expect(history).toHaveAttribute("title", HISTORY_HINT);
    expect(screen.getByRole("radio", { name: "Live" })).toHaveAttribute("aria-checked", "true");
    await fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    expect(app.preferencesOpen).toBe(true);
    expect(app.preferencesSection).toBe("elasticsearch");
  });

  it("log toolbar: no hint when hints are off, and no Set up in a detached window", () => {
    settings.integrationHints.value = false;
    const { unmount } = render(LogToolbar, { props: { session: new LogSession("shop", "api-0") } });
    expect(screen.queryByTestId("logpanel-history-hint")).toBeNull();
    expect(screen.queryByRole("radio", { name: "History" })).toBeNull();
    unmount();
    settings.integrationHints.value = true;
    render(LogToolbar, { props: { session: new LogSession("shop", "api-0"), detached: true } });
    expect(screen.getByTestId("logpanel-history-hint")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
  });

  it("log toolbar: no hint once Elasticsearch is configured", () => {
    elastic.setEndpoint("prod", es);
    render(LogToolbar, { props: { session: new LogSession("shop", "api-0") } });
    expect(screen.queryByTestId("logpanel-history-hint")).toBeNull();
    expect(screen.getByRole("radio", { name: "History" })).toBeEnabled();
  });

  it("metrics: placeholder with Set up Prometheus and Hide", async () => {
    render(MetricsSection, { namespace: "shop", workload: { kind: "pod", name: "api-0" } });
    expect(screen.getByTestId("metrics-hint")).toHaveTextContent(METRICS_HINT);
    await fireEvent.click(screen.getByRole("button", { name: "Set up Prometheus" }));
    expect(app.preferencesSection).toBe("prometheus");
    expect(app.preferencesOpen).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(settings.integrationHints.value).toBe(false);
    expect(screen.queryByTestId("metrics-hint")).toBeNull();
  });

  it("metrics: no placeholder when hints are off or Prometheus is configured", () => {
    settings.integrationHints.value = false;
    const { unmount } = render(MetricsSection, { namespace: "shop", workload: { kind: "pod", name: "api-0" } });
    expect(screen.queryByTestId("metrics-hint")).toBeNull();
    unmount();
    settings.integrationHints.value = true;
    prometheus.setEndpoint("prod", prom);
    render(MetricsSection, { namespace: "shop", workload: { kind: "pod", name: "api-0" } });
    expect(screen.queryByTestId("metrics-hint")).toBeNull();
    expect(screen.getByTestId("metrics-section")).toBeInTheDocument();
  });
});

describe("Kibana and Grafana links in the drawers (#526)", () => {
  it("are hidden when no web UI is available", () => {
    elastic.setEndpoint("prod", { ...es, kibanaUrl: null });
    prometheus.setEndpoint("prod", { ...prom, grafanaService: null });
    render(WorkloadLinks, { namespace: "shop", workload: { kind: "pod", name: "api-0" } });
    expect(screen.queryByTestId("workload-links")).toBeNull();
  });

  it("open Discover on the pod and Explore on its CPU", async () => {
    elastic.setEndpoint("prod", es);
    prometheus.setEndpoint("prod", prom);
    render(WorkloadLinks, { namespace: "shop", workload: { kind: "pod", name: "api-0" } });
    await fireEvent.click(screen.getByRole("button", { name: "Logs in Kibana" }));
    await waitFor(() =>
      expect(openKibanaDiscover).toHaveBeenCalledWith({
        kibanaUrl: "https://kibana.example",
        preset: "fluent-bit",
        namespace: "shop",
        pod: "api-0",
        container: null,
        from: "now-1h",
        to: "now",
      }),
    );
    expect(kibanaPortForward).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Metrics in Grafana" }));
    await waitFor(() =>
      expect(openGrafanaWorkload).toHaveBeenCalledWith({
        grafanaUrl: "http://127.0.0.1:42000",
        datasource: "prom",
        cluster: "eu",
        namespace: "shop",
        workload: { kind: "pod", name: "api-0" },
        range: "1h",
      }),
    );
    expect(grafanaPortForward).toHaveBeenCalledWith("/k", "prod", prom.grafanaService);
  });

  it("open Discover on a deployment's pods through an in-cluster Kibana", async () => {
    const kibanaService = { namespace: "logging", service: "kb-http", port: 5601, https: true };
    elastic.setEndpoint("prod", { ...es, kibanaUrl: null, kibanaService });
    render(WorkloadLinks, { namespace: "shop", workload: { kind: "deployment", name: "api" } });
    expect(screen.queryByRole("button", { name: "Metrics in Grafana" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Logs in Kibana" }));
    await waitFor(() =>
      expect(openKibanaWorkload).toHaveBeenCalledWith({
        kibanaUrl: "https://127.0.0.1:41000",
        preset: "fluent-bit",
        namespace: "shop",
        workload: { kind: "deployment", name: "api" },
        from: "now-1h",
        to: "now",
      }),
    );
    expect(kibanaPortForward).toHaveBeenCalledWith("/k", "prod", kibanaService);
  });

  it("report a failure as a toast", async () => {
    elastic.setEndpoint("prod", es);
    vi.mocked(openKibanaDiscover).mockRejectedValueOnce("Cannot open the browser: denied");
    render(WorkloadLinks, { namespace: "shop", workload: { kind: "pod", name: "api-0" } });
    await fireEvent.click(screen.getByRole("button", { name: "Logs in Kibana" }));
    await waitFor(() => expect(toasts.items.at(-1)?.message).toBe("Cannot open the browser: denied"));
  });
});
