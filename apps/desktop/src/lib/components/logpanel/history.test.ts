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
  elasticSearch: vi.fn(),
  openKibanaDiscover: vi.fn(async () => {}),
}));

import LogToolbar from "./LogToolbar.svelte";
import LogBody from "./LogBody.svelte";
import { LogSession } from "#lib/stores/logSession.svelte.ts";
import { logPanel } from "#lib/stores/logPanel.svelte.ts";
import { app } from "#lib/stores/app.svelte.ts";
import { elastic } from "#lib/stores/elastic.svelte.ts";
import { HISTORY_CAP } from "#lib/stores/logHistory.svelte.ts";
import { elasticSearch, openKibanaDiscover, type EsEndpoint, type HistoryLine, type HistoryPage } from "#lib/tauri.ts";
import { hitsLabel, isHistoryRange } from "#lib/elastic.ts";

const endpoint: EsEndpoint = {
  target: { kind: "in-cluster", namespace: "logging", service: "quickstart-es-http", port: 9200, https: true },
  indexPattern: "logs-*",
  preset: "ecs",
  kibanaUrl: "https://kibana.example",
  skipTlsVerify: false,
};

function hit(message: string, time: string, extra: Partial<HistoryLine> = {}): HistoryLine {
  return {
    time,
    level: "info",
    message,
    container: "web",
    document: JSON.stringify({ "@timestamp": time, message, "service.name": "shop" }),
    ...extra,
  };
}

function page(lines: HistoryLine[], next: unknown[] | null = null, total = lines.length): HistoryPage {
  return { lines, total, totalIsLowerBound: false, next };
}

function session(): LogSession {
  const s = new LogSession("shop", "api-0");
  s.container = "web";
  return s;
}

beforeEach(() => {
  vi.mocked(elasticSearch).mockReset();
  vi.mocked(openKibanaDiscover).mockClear();
  app.activeCluster = "prod";
  app.kubeconfigPath = "/k";
  elastic.setEndpoint("prod", endpoint);
  logPanel.viewMode = "raw";
});

describe("LogHistory (#501)", () => {
  it("loads newest-first pages into an oldest-first buffer and pages older", async () => {
    vi.mocked(elasticSearch)
      .mockResolvedValueOnce(page([hit("c", "t3"), hit("b", "t2")], [2, 0], 3))
      .mockResolvedValueOnce(page([hit("a", "t1")]));
    const s = session();
    s.setSource("history");
    await waitFor(() => expect(s.history.lines.map((l) => l.message)).toEqual(["b", "c"]));
    expect(elasticSearch).toHaveBeenCalledWith("/k", "prod", endpoint, {
      namespace: "shop",
      pod: "api-0",
      container: "web",
      from: "now-1h",
      to: "now",
      text: null,
      searchAfter: null,
      size: null,
    });
    expect(s.lines).toBe(s.history.lines);
    expect(s.history.lines[0]!.id).toBeGreaterThan(1e12);
    expect(s.history.canLoadOlder).toBe(true);
    await s.history.loadOlder();
    expect(vi.mocked(elasticSearch).mock.calls[1]![3].searchAfter).toEqual([2, 0]);
    expect(s.history.lines.map((l) => l.message)).toEqual(["a", "b", "c"]);
    expect(s.history.canLoadOlder).toBe(false);
  });

  it("reports errors and a missing endpoint without touching the live buffer", async () => {
    vi.mocked(elasticSearch).mockRejectedValueOnce("Elasticsearch returned 401: authentication failed");
    const s = session();
    s.ring.append([{ pod: "api-0", namespace: "shop", time: null, level: "info", message: "live" }]);
    await s.history.reload();
    expect(s.history.error).toContain("401");
    expect(s.ring.lines).toHaveLength(1);
    elastic.setEndpoint("prod", null);
    await s.history.reload();
    expect(s.history.error).toContain("Preferences");
  });

  it("ignores a superseded reload", async () => {
    let first!: (p: HistoryPage) => void;
    vi.mocked(elasticSearch)
      .mockReturnValueOnce(new Promise((r) => (first = r)))
      .mockResolvedValueOnce(page([hit("new", "t2")]));
    const s = session();
    const a = s.history.reload();
    await s.history.reload();
    first(page([hit("old", "t1")]));
    await a;
    expect(s.history.lines.map((l) => l.message)).toEqual(["new"]);
  });

  it("caps the buffer", () => {
    expect(HISTORY_CAP).toBe(10_000);
  });
});

describe("History in the log panel (#501)", () => {
  it("offers Live · History only when the cluster has an endpoint", () => {
    elastic.setEndpoint("prod", null);
    const { unmount } = render(LogToolbar, { props: { session: session() } });
    expect(screen.queryByTestId("logpanel-source")).toBeNull();
    unmount();
    elastic.setEndpoint("prod", endpoint);
    render(LogToolbar, { props: { session: session() } });
    expect(screen.getByRole("radio", { name: "History" })).toBeInTheDocument();
  });

  it("History shows the range, query, hit count and Load older; ECS renders the stored document", async () => {
    vi.mocked(elasticSearch).mockResolvedValue(page([hit("disk full", "2026-11-03T08:00:00Z")], [1, 1], 1234));
    const s = session();
    render(LogToolbar, { props: { session: s } });
    render(LogBody, { props: { session: s } });
    await fireEvent.click(screen.getByRole("radio", { name: "History" }));
    expect(await screen.findByText(/1,234 hits · showing 1 · last 1 h/)).toBeInTheDocument();
    expect(screen.getByLabelText("History range")).toHaveValue("now-1h");
    expect(screen.getByRole("button", { name: "Load older" })).toBeEnabled();
    expect(screen.queryByText("● Following")).toBeNull();
    expect(screen.getByText("disk full")).toBeInTheDocument();

    logPanel.viewMode = "ecs";
    expect(await screen.findByTestId("ecs-service")).toHaveTextContent("shop");

    await fireEvent.input(screen.getByLabelText("Elasticsearch query"), { target: { value: "timeout" } });
    await fireEvent.keyDown(screen.getByLabelText("Elasticsearch query"), { key: "Enter" });
    await waitFor(() => expect(vi.mocked(elasticSearch).mock.calls.at(-1)![3].text).toBe("timeout"));
    await fireEvent.change(screen.getByLabelText("History range"), { target: { value: "now-24h" } });
    await waitFor(() => expect(vi.mocked(elasticSearch).mock.calls.at(-1)![3].from).toBe("now-24h"));
  });

  it("shows the error with Retry", async () => {
    vi.mocked(elasticSearch).mockRejectedValueOnce("Cannot reach Elasticsearch: no ready pod");
    const s = session();
    render(LogBody, { props: { session: s } });
    s.setSource("history");
    expect(await screen.findByRole("alert")).toHaveTextContent("no ready pod");
    vi.mocked(elasticSearch).mockResolvedValueOnce(page([]));
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No lines in Elasticsearch for this pod and range.")).toBeInTheDocument();
  });

  it("Open in Kibana passes the pod, container and range", async () => {
    vi.mocked(elasticSearch).mockResolvedValue(page([]));
    const s = session();
    render(LogToolbar, { props: { session: s } });
    s.setSource("history");
    s.history.range = "now-7d";
    await fireEvent.click(screen.getByLabelText("More log options"));
    await fireEvent.click(screen.getByText("Open in Kibana"));
    expect(openKibanaDiscover).toHaveBeenCalledWith({
      kibanaUrl: "https://kibana.example",
      preset: "ecs",
      namespace: "shop",
      pod: "api-0",
      container: "web",
      from: "now-7d",
      to: "now",
    });
  });
});

describe("elastic helpers", () => {
  it("labels hits and validates ranges", () => {
    expect(hitsLabel(1, false)).toBe("1 hit");
    expect(hitsLabel(10000, true)).toBe("10,000+ hits");
    expect(hitsLabel(null, false)).toBe("");
    expect(isHistoryRange("now-24h")).toBe(true);
    expect(isHistoryRange("now-2h")).toBe(false);
  });
});
