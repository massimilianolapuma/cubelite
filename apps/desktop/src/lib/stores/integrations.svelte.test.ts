import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  integrationsDetect: vi.fn(),
  elasticTest: vi.fn(),
  elasticSaveAuth: vi.fn(async () => {}),
  elasticUseEckCredentials: vi.fn(async () => "eck-user"),
  elasticAuthMethod: vi.fn(async () => "none"),
  elasticDisconnect: vi.fn(async () => {}),
  prometheusTest: vi.fn(),
  prometheusSaveAuth: vi.fn(async () => {}),
  prometheusAuthMethod: vi.fn(async () => "none"),
  prometheusDisconnect: vi.fn(async () => {}),
}));

import IntegrationsBanner from "#lib/components/IntegrationsBanner.svelte";
import ElasticPreferences from "#lib/components/ElasticPreferences.svelte";
import PrometheusPreferences from "#lib/components/PrometheusPreferences.svelte";
import { bannerTitle, failureText, isDismissals, NOTHING_DETECTED, SUGGESTED_TEXT } from "#lib/integration-suggest.ts";
import {
  elasticSaveAuth,
  elasticTest,
  elasticUseEckCredentials,
  integrationsDetect,
  prometheusSaveAuth,
  prometheusTest,
  type DetectedIntegrations,
} from "#lib/tauri.ts";
import { app } from "./app.svelte";
import { elastic } from "./elastic.svelte";
import { integrations } from "./integrations.svelte";
import { prometheus } from "./prometheus.svelte";
import { settings } from "./settings.svelte";
import { toasts } from "./toasts.svelte";

const ECK: DetectedIntegrations = {
  elasticsearch: { kind: "elasticsearch", namespace: "logging", name: "quickstart-es-http", port: 9200, https: true },
  kibana: { kind: "kibana", namespace: "logging", name: "quickstart-kb-http", port: 5601, https: true },
  prometheus: { kind: "prometheus", namespace: "monitoring", name: "prometheus-operated", port: 9090, https: false },
  grafana: { kind: "grafana", namespace: "monitoring", name: "kps-grafana", port: 80, https: false },
};

const ES_INFO = { version: "8.15.0", clusterName: "quickstart", health: "green", indices: 3 };
const PROM_INFO = { version: "2.54.1", cadvisor: true, kubeStateMetrics: true, clusters: [] };

async function detected(found: DetectedIntegrations | null, context = "prod") {
  vi.mocked(integrationsDetect).mockResolvedValueOnce(found as DetectedIntegrations);
  await integrations.detect(context);
}

beforeEach(() => {
  vi.clearAllMocks();
  toasts.items = [];
  app.activeCluster = "prod";
  app.kubeconfigPath = "/k";
  app.preferencesOpen = false;
  app.preferencesSection = null;
  settings.integrationHints.value = true;
  settings.integrationDismissals.value = {};
  elastic.setEndpoint("prod", null);
  prometheus.setEndpoint("prod", null);
  integrations.detected = {};
  integrations.failure = {};
  vi.mocked(elasticTest).mockResolvedValue(ES_INFO);
  vi.mocked(prometheusTest).mockResolvedValue(PROM_INFO);
});

describe("integrations banner model (#527)", () => {
  it("offers what was found and is not configured, dismissed or hidden", async () => {
    await detected(ECK);
    expect(integrationsDetect).toHaveBeenCalledWith("/k", "prod");
    expect(integrations.offered("prod")).toEqual(["elasticsearch", "prometheus"]);
    expect(bannerTitle(integrations.banner!.kinds)).toBe("Elasticsearch and Prometheus found in this cluster");

    // Configured: no offer for that integration.
    prometheus.setEndpoint("prod", { target: { kind: "external", url: "https://p.example" }, cluster: null, grafanaUrl: null, grafanaDatasource: null, skipTlsVerify: false });
    expect(integrations.offered("prod")).toEqual(["elasticsearch"]);
    expect(bannerTitle(["elasticsearch"])).toBe("Elasticsearch found in this cluster");

    // Hints off: nothing.
    settings.integrationHints.value = false;
    expect(integrations.banner).toBeNull();
    settings.integrationHints.value = true;

    // Other contexts are not affected; nothing found means no banner.
    expect(integrations.offered("staging")).toEqual([]);
    await detected(null, "staging");
    expect(integrations.offered("staging")).toEqual([]);
    await detected({ ...NOTHING_DETECTED }, "prod");
    expect(integrations.banner).toBeNull();
  });

  it("detection failures are silent", async () => {
    vi.mocked(integrationsDetect).mockRejectedValueOnce("services is forbidden");
    await integrations.detect("prod");
    expect(integrations.banner).toBeNull();
    expect(toasts.items).toEqual([]);
  });

  it("dismissals hide the banner per context and persist", async () => {
    await detected(ECK);
    await detected(ECK, "staging");
    integrations.dismiss("prod");
    expect(integrations.offered("prod")).toEqual([]);
    expect(integrations.offered("staging")).toEqual(["elasticsearch", "prometheus"]);
    const stored = JSON.parse(window.localStorage.getItem("cubelite.integrationDismissals") ?? "null");
    expect(stored).toEqual({ prod: ["elasticsearch", "prometheus"] });
    expect(isDismissals(stored)).toBe(true);
    expect(isDismissals({ prod: ["kafka"] })).toBe(false);

    vi.resetModules();
    const reloaded = await import("./settings.svelte");
    expect(reloaded.settings.integrationDismissals.value).toEqual({ prod: ["elasticsearch", "prometheus"] });

    integrations.resetDismissals("prod");
    expect(integrations.offered("prod")).toEqual(["elasticsearch", "prometheus"]);
  });

  it("Enable tests ECK with its user, then saves both endpoints with the defaults", async () => {
    await detected(ECK);
    // Nothing reached Elasticsearch or Prometheus before the click.
    expect(elasticTest).not.toHaveBeenCalled();
    expect(elasticUseEckCredentials).not.toHaveBeenCalled();
    expect(prometheusTest).not.toHaveBeenCalled();

    await integrations.enable("prod");
    const es = elastic.endpointFor("prod");
    expect(es).toEqual({
      target: { kind: "in-cluster", namespace: "logging", service: "quickstart-es-http", port: 9200, https: true },
      indexPattern: "logs-*,filebeat-*,logstash-*",
      preset: "ecs",
      kibanaUrl: null,
      kibanaService: { namespace: "logging", service: "quickstart-kb-http", port: 5601, https: true },
      skipTlsVerify: false,
    });
    expect(elasticTest).toHaveBeenCalledWith("/k", "prod", es, { method: "eck-user" });
    expect(elasticUseEckCredentials).toHaveBeenCalledWith("/k", "prod", es);
    expect(elasticSaveAuth).not.toHaveBeenCalled();

    const prom = prometheus.endpointFor("prod");
    expect(prom).toEqual({
      target: { kind: "in-cluster", namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false },
      cluster: null,
      grafanaUrl: null,
      grafanaDatasource: null,
      grafanaService: { namespace: "monitoring", service: "kps-grafana", port: 80, https: false },
      skipTlsVerify: false,
    });
    expect(prometheusTest).toHaveBeenCalledWith("/k", "prod", prom, { method: "none" });
    expect(prometheusSaveAuth).toHaveBeenCalledWith("prod", prom, { method: "none" });
    expect(toasts.items.map((t) => t.message)).toEqual(["Elasticsearch enabled for prod", "Prometheus enabled for prod"]);
    expect(integrations.banner).toBeNull();
  });

  it("a failed Test saves nothing and the banner says why", async () => {
    const plain = { ...ECK.elasticsearch!, namespace: "search", name: "elasticsearch-master" };
    await detected({ ...ECK, elasticsearch: plain, kibana: null });
    vi.mocked(elasticTest).mockRejectedValueOnce("security_exception: missing authentication credentials");
    await integrations.enable("prod");
    expect(vi.mocked(elasticTest).mock.calls[0]![3]).toEqual({ method: "none" });
    expect(elastic.endpointFor("prod")).toBeNull();
    expect(elasticSaveAuth).not.toHaveBeenCalled();
    expect(elasticUseEckCredentials).not.toHaveBeenCalled();
    // Prometheus answered: it is saved.
    expect(prometheus.endpointFor("prod")).not.toBeNull();
    expect(integrations.banner).toEqual({
      context: "prod",
      kinds: ["elasticsearch"],
      failure:
        "Couldn't connect to Elasticsearch: security_exception: missing authentication credentials (credentials may be needed)",
    });
    expect(failureText("prometheus", "timed out", false)).toBe("Couldn't connect to Prometheus: timed out");
  });

  it("Review opens Preferences pre-filled, without saving", async () => {
    await detected(ECK);
    integrations.review("prod");
    expect(app.preferencesOpen).toBe(true);
    expect(app.preferencesSection).toBe("elasticsearch");

    render(ElasticPreferences);
    expect(screen.getByLabelText("Namespace")).toHaveValue("logging");
    expect(screen.getByLabelText("Service")).toHaveValue("quickstart-es-http");
    expect(screen.getByTestId("kibana-service")).toHaveTextContent("logging/quickstart-kb-http:5601");
    expect(screen.getByLabelText("Authentication")).toHaveValue("eck-user");
    expect(screen.getAllByText(SUGGESTED_TEXT)).toHaveLength(1);

    render(PrometheusPreferences);
    expect(screen.getAllByLabelText("Service")[1]).toHaveValue("prometheus-operated");
    expect(elastic.endpointFor("prod")).toBeNull();
    expect(prometheus.endpointFor("prod")).toBeNull();
    // Taken once: the next opening shows the saved state again.
    expect(integrations.takeElastic("prod")).toBeNull();
    expect(integrations.takePrometheus("prod")).toBeNull();
  });

  it("the banner enables and dismisses", async () => {
    await detected(ECK);
    render(IntegrationsBanner);
    expect(screen.getByTestId("integrations-banner")).toHaveTextContent("Elasticsearch and Prometheus found in this cluster");
    await fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(screen.queryByTestId("integrations-banner")).not.toBeInTheDocument());
    expect(elastic.endpointFor("prod")).not.toBeNull();

    await detected(ECK, "staging");
    app.activeCluster = "staging";
    await waitFor(() => expect(screen.getByTestId("integrations-banner")).toBeInTheDocument());
    await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("integrations-banner")).not.toBeInTheDocument();
    expect(settings.integrationDismissals.value).toEqual({ staging: ["elasticsearch", "prometheus"] });
  });
});
