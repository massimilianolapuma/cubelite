import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  elasticSearch: vi.fn(),
  elasticCloseCursor: vi.fn(async () => {}),
}));

import { LogHistory } from "./logHistory.svelte";
import { app } from "./app.svelte";
import { elastic } from "./elastic.svelte";
import {
  elasticCloseCursor,
  elasticSearch,
  type EsEndpoint,
  type HistoryCursor,
  type HistoryPage,
} from "#lib/tauri.ts";

const endpoint: EsEndpoint = {
  target: { kind: "external", url: "https://es.example" },
  indexPattern: "logs-*",
  preset: "ecs",
  kibanaUrl: null,
  kibanaService: null,
  skipTlsVerify: false,
};

/** What the backend sends: opaque to the store. */
const cursor = (pit: string, sort: number): HistoryCursor => ({ pitId: pit, sort: [sort, 0] });

function page(messages: string[], next: HistoryCursor | null): HistoryPage {
  return {
    // Each message is its own Elasticsearch hit (`_id` = the message).
    lines: messages.map((message) => ({
      time: "t",
      level: "info",
      message,
      container: "web",
      document: "{}",
      docIndex: ".ds-logs-1",
      docId: message,
    })),
    total: messages.length,
    totalIsLowerBound: false,
    next,
  };
}

beforeEach(() => {
  vi.mocked(elasticSearch).mockReset();
  vi.mocked(elasticCloseCursor).mockClear();
  app.activeCluster = "prod";
  app.kubeconfigPath = "/k";
  elastic.setEndpoint("prod", endpoint);
});

describe("LogHistory paging cursor (#531)", () => {
  it("passes the cursor back untouched and keeps its point in time while paging", async () => {
    const first = cursor("pit-a", 2);
    const second = cursor("pit-b", 1);
    vi.mocked(elasticSearch)
      .mockResolvedValueOnce(page(["c", "b"], first))
      .mockResolvedValueOnce(page(["a"], second));
    const h = new LogHistory("shop", "api-0", () => "web");
    await h.reload();
    await h.loadOlder();
    expect(vi.mocked(elasticSearch).mock.calls[1]![3].searchAfter).toEqual(first);
    expect(h.next).toEqual(second);
    expect(elasticCloseCursor).not.toHaveBeenCalled();
  });

  it("releases the previous search's cursor on a new query and on close", async () => {
    const old = cursor("pit-a", 2);
    const fresh = cursor("pit-b", 9);
    vi.mocked(elasticSearch)
      .mockResolvedValueOnce(page(["b"], old))
      .mockResolvedValueOnce(page(["z"], fresh));
    const h = new LogHistory("shop", "api-0", () => "web");
    await h.reload();
    h.text = "timeout";
    await h.reload();
    expect(elasticCloseCursor).toHaveBeenCalledTimes(1);
    expect(elasticCloseCursor).toHaveBeenCalledWith("/k", "prod", endpoint, old);
    h.close();
    expect(elasticCloseCursor).toHaveBeenLastCalledWith("/k", "prod", endpoint, fresh);
    expect(h.next).toBeNull();
  });

  it("releases the cursor of a superseded reload, and a failed release is ignored", async () => {
    let resolveFirst!: (p: HistoryPage) => void;
    const stale = cursor("pit-stale", 1);
    vi.mocked(elasticSearch)
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(page(["new"], null));
    vi.mocked(elasticCloseCursor).mockRejectedValueOnce("Elasticsearch returned 404: not found");
    const h = new LogHistory("shop", "api-0", () => "web");
    const slow = h.reload();
    await h.reload();
    resolveFirst(page(["old"], stale));
    await slow;
    expect(elasticCloseCursor).toHaveBeenCalledWith("/k", "prod", endpoint, stale);
    expect(h.lines.map((l) => l.message)).toEqual(["new"]);
    expect(h.error).toBeNull();
  });

  it("drops the boundary lines a page resumed on a new point in time repeats", async () => {
    vi.mocked(elasticSearch)
      .mockResolvedValueOnce(page(["d", "c"], cursor("pit-a", 3)))
      .mockResolvedValueOnce(page(["c", "b"], cursor("pit-new", 2)))
      .mockResolvedValueOnce(page(["a"], null));
    const h = new LogHistory("shop", "api-0", () => "web");
    await h.reload();
    await h.loadOlder();
    expect(h.lines.map((l) => l.message)).toEqual(["b", "c", "d"]);
    await h.loadOlder();
    expect(h.lines.map((l) => l.message)).toEqual(["a", "b", "c", "d"]);
    // A new search starts over: the same hits are shown again.
    vi.mocked(elasticSearch).mockResolvedValueOnce(page(["d"], null));
    await h.reload();
    expect(h.lines.map((l) => l.message)).toEqual(["d"]);
  });

  it("releases a stale page's cursor on the cluster it came from", async () => {
    let resolveFirst!: (p: HistoryPage) => void;
    const stale = cursor("pit-prod", 1);
    const dev: EsEndpoint = { ...endpoint, indexPattern: "dev-*" };
    vi.mocked(elasticSearch)
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(page(["dev line"], cursor("pit-dev", 5)));
    const h = new LogHistory("shop", "api-0", () => "web");
    const slow = h.reload();
    app.activeCluster = "dev";
    elastic.setEndpoint("dev", dev);
    await h.reload();
    resolveFirst(page(["old"], stale));
    await slow;
    expect(elasticCloseCursor).toHaveBeenCalledWith("/k", "prod", endpoint, stale);
    h.close();
    expect(elasticCloseCursor).toHaveBeenLastCalledWith("/k", "dev", dev, cursor("pit-dev", 5));
  });
});

describe("LogHistory targets (#529)", () => {
  const withPods = (pods: (string | null)[]): HistoryPage => {
    const p = page(pods.map((_, i) => `m${i}`), null);
    return { ...p, lines: p.lines.map((l, i) => ({ ...l, pod: pods[i] })) };
  };

  it("searches a workload's pods and tags each line with its own pod", async () => {
    vi.mocked(elasticSearch).mockResolvedValueOnce(withPods(["db-1", "db-0"]));
    const h = new LogHistory("shop", { kind: "stateful-set", name: "db" }, () => null);
    await h.reload();
    const query = vi.mocked(elasticSearch).mock.calls[0]![3];
    expect(query).toMatchObject({ namespace: "shop", pod: "", workload: { kind: "stateful-set", name: "db" } });
    expect(h.lines.map((l) => l.pod)).toEqual(["db-0", "db-1"]);
  });

  it("searches the whole namespace without a target, and one pod by name", async () => {
    vi.mocked(elasticSearch).mockResolvedValue(withPods([null]));
    await new LogHistory("shop", null, () => null).reload();
    await new LogHistory("shop", { kind: "pod", name: "api-0" }, () => null).reload();
    const [namespace, onePod] = vi.mocked(elasticSearch).mock.calls.map((c) => c[3]);
    expect(namespace).toMatchObject({ pod: "" });
    expect(namespace).not.toHaveProperty("workload");
    expect(onePod).toMatchObject({ pod: "api-0" });
    expect(onePod).not.toHaveProperty("workload");
  });
});
