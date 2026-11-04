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
import {
  REVIEW_ONLY_HINT,
  SUGGESTED_TEXT,
  bannerTitle,
  failureText,
  isDismissals,
  NOTHING_DETECTED,
} from "#lib/integration-suggest.ts";
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

const ES = { kind: "elasticsearch", namespace: "logging", name: "quickstart-es-http", port: 9200, https: true } as const;
const KB = { kind: "kibana", namespace: "logging", name: "quickstart-kb-http", port: 5601, https: true } as const;
const PROM = { kind: "prometheus", namespace: "monitoring", name: "prometheus-operated", port: 9090, https: false } as const;
const GRAFANA = { kind: "grafana", namespace: "monitoring", name: "kps-grafana", port: 80, https: false } as const;
const LOOK_ALIKE = { kind: "elasticsearch", namespace: "team-a", name: "foo-es-http", port: 9200, https: true } as const;

/** ECK and kube-prometheus-stack, each the single operator-managed service. */
const ECK: DetectedIntegrations = {
  elasticsearch: ES,
  kibana: KB,
  prometheus: PROM,
  grafana: GRAFANA,
  elasticsearchOneClick: true,
  prometheusOneClick: true,
  elasticServices: [ES, KB],
  prometheusServices: [PROM, GRAFANA],
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
    expect(integrations.banner?.canEnable).toBe(true);
    // The banner always names the services Enable would use.
    expect(bannerTitle(ECK, integrations.banner!.kinds)).toBe(
      "Elasticsearch found (logging/quickstart-es-http) and Prometheus (monitoring/prometheus-operated)",
    );

    // Configured: no offer for that integration.
    prometheus.setEndpoint("prod", { target: { kind: "external", url: "https://p.example" }, cluster: null, grafanaUrl: null, grafanaDatasource: null, skipTlsVerify: false });
    expect(integrations.offered("prod")).toEqual(["elasticsearch"]);
    expect(bannerTitle(ECK, ["prometheus"])).toBe("Prometheus found (monitoring/prometheus-operated)");

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

  it("several candidates or an unmanaged one: Review only, Enable refused", async () => {
    // A lone look-alike `*-es-http` in a namespace anyone may use.
    await detected({
      ...NOTHING_DETECTED,
      elasticsearch: LOOK_ALIKE,
      elasticServices: [LOOK_ALIKE],
    });
    expect(integrations.banner).toMatchObject({ kinds: ["elasticsearch"], canEnable: false });
    await integrations.enable("prod");
    expect(elasticTest).not.toHaveBeenCalled();
    expect(elastic.endpointFor("prod")).toBeNull();

    // One integration needing a review keeps Enable away for both.
    await detected({ ...ECK, prometheusOneClick: false, prometheusServices: [PROM, { ...PROM, namespace: "team-a" }, GRAFANA] });
    expect(integrations.banner?.canEnable).toBe(false);
    render(IntegrationsBanner);
    expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute("title", REVIEW_ONLY_HINT);
    expect(screen.getByTestId("integrations-banner")).toHaveTextContent(
      "Elasticsearch found (logging/quickstart-es-http) and Prometheus (monitoring/prometheus-operated)",
    );
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

  it("turning an integration off in Preferences dismisses it", async () => {
    await detected(ECK);
    elastic.setEndpoint("prod", {
      target: { kind: "external", url: "https://es.example" },
      indexPattern: "logs-*",
      preset: "ecs",
      kibanaUrl: null,
      skipTlsVerify: false,
    });
    render(ElasticPreferences);
    await fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(elastic.endpointFor("prod")).toBeNull());
    expect(integrations.dismissed("prod")).toEqual(["elasticsearch"]);
    expect(integrations.offered("prod")).toEqual(["prometheus"]);
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
    expect(toasts.items.map((t) => [t.message, t.tone])).toEqual([
      ["Elasticsearch enabled for prod", "ok"],
      ["Prometheus enabled for prod", "ok"],
    ]);
    expect(integrations.banner).toBeNull();
  });

  it("a Prometheus without cAdvisor series is saved with a warning", async () => {
    await detected({ ...ECK, elasticsearch: null, kibana: null, elasticsearchOneClick: false, elasticServices: [] });
    vi.mocked(prometheusTest).mockResolvedValueOnce({ ...PROM_INFO, cadvisor: false });
    await integrations.enable("prod");
    expect(prometheus.endpointFor("prod")).not.toBeNull();
    expect(toasts.items.map((t) => [t.message, t.tone])).toEqual([
      ["Prometheus enabled for prod — no container metrics (cAdvisor) found yet", "warn"],
    ]);
  });

  it("a failed Test saves nothing and the banner says why", async () => {
    await detected(ECK);
    vi.mocked(elasticTest).mockRejectedValueOnce("security_exception: unable to authenticate user [elastic]");
    await integrations.enable("prod");
    expect(elastic.endpointFor("prod")).toBeNull();
    expect(elasticSaveAuth).not.toHaveBeenCalled();
    expect(elasticUseEckCredentials).not.toHaveBeenCalled();
    // Prometheus answered: it is saved.
    expect(prometheus.endpointFor("prod")).not.toBeNull();
    expect(integrations.banner).toMatchObject({
      context: "prod",
      kinds: ["elasticsearch"],
      failure: "Couldn't connect to Elasticsearch: security_exception: unable to authenticate user [elastic]",
    });
    expect(failureText("elasticsearch", "401", false)).toBe(
      "Couldn't connect to Elasticsearch: 401 (credentials may be needed)",
    );
    expect(failureText("prometheus", "timed out", false)).toBe("Couldn't connect to Prometheus: timed out");
  });

  it("Review opens Preferences pre-filled with every candidate, without saving", async () => {
    await detected({ ...ECK, elasticsearchOneClick: false, elasticServices: [ES, LOOK_ALIKE, KB] });
    integrations.review("prod");
    expect(app.preferencesOpen).toBe(true);
    expect(app.preferencesSection).toBe("elasticsearch");

    render(ElasticPreferences);
    expect(screen.getByLabelText("Namespace")).toHaveValue("logging");
    expect(screen.getByLabelText("Service")).toHaveValue("quickstart-es-http");
    expect(screen.getByTestId("kibana-service")).toHaveTextContent("logging/quickstart-kb-http:5601");
    expect(screen.getByLabelText("Authentication")).toHaveValue("eck-user");
    expect(screen.getAllByText(SUGGESTED_TEXT)).toHaveLength(1);
    // The other candidates can be picked instead.
    expect(screen.getByText("team-a/foo-es-http:9200", { exact: false })).toBeInTheDocument();

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
    expect(screen.getByTestId("integrations-banner")).toHaveTextContent(
      "Elasticsearch found (logging/quickstart-es-http) and Prometheus (monitoring/prometheus-operated)",
    );
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
