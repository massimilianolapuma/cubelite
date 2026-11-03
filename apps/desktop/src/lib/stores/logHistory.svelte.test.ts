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
    lines: messages.map((message) => ({ time: "t", level: "info", message, container: "web", document: "{}" })),
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
});
