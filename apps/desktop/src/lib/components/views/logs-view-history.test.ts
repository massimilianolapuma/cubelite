import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  streamLogs: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  listStatefulSets: vi.fn(async () => []),
  listJobs: vi.fn(async () => []),
  elasticSearch: vi.fn(),
  elasticCloseCursor: vi.fn(async () => {}),
  openKibanaWorkload: vi.fn(async () => {}),
}));

import LogsView from "./LogsView.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { logs } from "#lib/stores/logs.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { elastic } from "#lib/stores/elastic.svelte.ts";
import { SELECTOR_HISTORY_HINT } from "#lib/log-scope.ts";
import {
  elasticSearch,
  openKibanaWorkload,
  streamLogs,
  type DeploymentInfo,
  type EsEndpoint,
  type HistoryLine,
  type PodInfo,
} from "#lib/tauri.ts";

const endpoint: EsEndpoint = {
  target: { kind: "external", url: "https://es.example" },
  indexPattern: "logs-*",
  preset: "ecs",
  kibanaUrl: "https://kibana.example",
  kibanaService: null,
  skipTlsVerify: false,
};

function pod(name: string, namespace = "shop"): PodInfo {
  return {
    name,
    namespace,
    phase: "Running",
    ready: true,
    restarts: 0,
    ready_containers: 1,
    total_containers: 1,
    node: null,
    pod_ip: null,
    qos_class: null,
    containers: [],
    labels: { app: name.split("-")[0] ?? name },
    creation_timestamp: null,
  };
}

function deployment(name: string): DeploymentInfo {
  return {
    name,
    namespace: "shop",
    replicas: 2,
    ready_replicas: 2,
    images: [],
    selector: { app: name },
    strategy: null,
    conditions: [],
    creation_timestamp: null,
  };
}

function hit(message: string, podName: string): HistoryLine {
  return { time: "2026-11-03T08:00:00Z", level: "info", message, container: "api", pod: podName, document: "{}" };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await logs.stop();
  logs.clear();
  logs.scope = null;
  logs.setSource("live");
  logs.textFilter = "";
  logs.level = "all";
  app.view = "logs";
  app.activeCluster = "prod";
  app.kubeconfigPath = "/k";
  app.namespace = "shop";
  resources.pods = [pod("api-7d9f8b6c5-x7k2p"), pod("api-7d9f8b6c5-m4n5q"), pod("api-gateway-6c5d4f7b8-z9z9z")];
  resources.deployments = [deployment("api"), deployment("api-gateway")];
  elastic.setEndpoint("prod", endpoint);
});

const lastStreamed = () => vi.mocked(streamLogs).mock.calls.at(-1)?.[1].map((p) => p.name);

describe("LogsView workload scope and history (#529)", () => {
  it("narrows the live stream to a workload's pods, not its siblings'", async () => {
    render(LogsView);
    await fireEvent.change(screen.getByRole("combobox", { name: "Workload" }), {
      target: { value: "deployment:shop/api" },
    });
    await waitFor(() => expect(lastStreamed()).toEqual(["api-7d9f8b6c5-x7k2p", "api-7d9f8b6c5-m4n5q"]));
    expect(logs.scope).toEqual({ namespace: "shop", workload: { kind: "deployment", name: "api" } });
  });

  it("History searches the workload's pods and shows each line's pod", async () => {
    vi.mocked(elasticSearch).mockResolvedValue({
      lines: [hit("newest", "api-7d9f8b6c5-m4n5q"), hit("older", "api-7d9f8b6c5-x7k2p")],
      total: 2,
      totalIsLowerBound: false,
      next: null,
    });
    logs.scope = { namespace: "shop", workload: { kind: "deployment", name: "api" } };
    render(LogsView);
    await fireEvent.click(await screen.findByRole("radio", { name: "History" }));
    expect(await screen.findByText("newest")).toBeInTheDocument();
    expect(elasticSearch).toHaveBeenCalledWith("/k", "prod", endpoint, expect.objectContaining({
      namespace: "shop",
      pod: "",
      workload: { kind: "deployment", name: "api" },
      container: null,
      from: "now-1h",
    }));
    expect(screen.getByText("api-7d9f8b6c5-m4n5q")).toBeInTheDocument();
    expect(screen.getByText("api-7d9f8b6c5-x7k2p")).toBeInTheDocument();
    expect(screen.getByTestId("history-strip")).toBeInTheDocument();
    expect(screen.queryByText("● Following")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "Open in Kibana" }));
    await waitFor(() =>
      expect(openKibanaWorkload).toHaveBeenCalledWith({
        kibanaUrl: "https://kibana.example",
        preset: "ecs",
        namespace: "shop",
        workload: { kind: "deployment", name: "api" },
        from: "now-1h",
        to: "now",
      }),
    );
  });

  it("without a workload, History searches the whole namespace", async () => {
    vi.mocked(elasticSearch).mockResolvedValue({ lines: [], total: 0, totalIsLowerBound: false, next: null });
    render(LogsView);
    await fireEvent.click(await screen.findByRole("radio", { name: "History" }));
    await waitFor(() => expect(elasticSearch).toHaveBeenCalled());
    const query = vi.mocked(elasticSearch).mock.calls[0]![3];
    expect(query.pod).toBe("");
    expect(query.workload).toBeUndefined();
    expect(await screen.findByText("No lines in Elasticsearch for this filter and range.")).toBeInTheDocument();
  });

  it("keeps History disabled with a reason for a label selector", async () => {
    render(LogsView);
    await fireEvent.input(screen.getByPlaceholderText("label=value,…"), { target: { value: "app=api" } });
    await waitFor(() => expect(screen.getByRole("radio", { name: "History" })).toBeDisabled(), { timeout: 2000 });
    expect(screen.getByRole("radio", { name: "History" })).toHaveAttribute("title", SELECTOR_HISTORY_HINT);
    expect(elasticSearch).not.toHaveBeenCalled();
  });

  it("drops the scope when the namespace changes", async () => {
    logs.scope = { namespace: "shop", workload: { kind: "deployment", name: "api" } };
    render(LogsView);
    app.namespace = "billing";
    await waitFor(() => expect(logs.scope).toBeNull());
  });
});
