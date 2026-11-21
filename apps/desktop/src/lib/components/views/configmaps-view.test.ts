import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  listEvents: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  listServices: vi.fn(async () => []),
  listIngresses: vi.fn(async () => []),
  listConfigMaps: vi.fn(async () => []),
  listSecrets: vi.fn(async () => []),
  listHelmReleases: vi.fn(async () => []),
  listJobs: vi.fn(async () => []),
  listCronJobs: vi.fn(async () => []),
  listStatefulSets: vi.fn(async () => []),
  listPvcs: vi.fn(async () => []),
  listNodes: vi.fn(async () => []),
  readConfigMapValue: vi.fn(),
  copyConfigMapValue: vi.fn(),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import ConfigMapsView from "./ConfigMapsView.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { lists } from "#lib/stores/lists.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { toasts } from "#lib/stores/toasts.svelte.ts";
import { installLocalStorageMock } from "#lib/stores/storage-mock.ts";
import * as tauri from "#lib/tauri.ts";
import type { ConfigMapInfo, CopyFormat, RevealedSecretValue } from "#lib/tauri.ts";

/** Values the backend holds; only the one asked for may reach the DOM. */
const VALUES: Record<string, string> = {
  LOG_LEVEL: "info-level-v4lue",
  "application.yaml": "server:\n  port: 8080\n  name: shop-api\n",
  FEATURE_FLAGS: "checkout=on,search=off",
};

const appConfig = (rv = "77", keys = ["FEATURE_FLAGS", "LOG_LEVEL", "application.yaml"]): ConfigMapInfo => ({
  name: "app-config",
  namespace: "shop",
  keys: [
    ...keys.map((key) => ({ key, size: new TextEncoder().encode(VALUES[key]).length, binary: false })),
    { key: "logo.png", size: 14_336, binary: true },
    { key: "unused", size: 0, binary: false },
    { key: "big.json", size: 70_000, binary: false },
  ].sort((a, b) => (a.key < b.key ? -1 : 1)),
  resource_version: rv,
  creation_timestamp: null,
});

const caBundle: ConfigMapInfo = {
  name: "kube-root-ca.crt",
  namespace: "shop",
  keys: [{ key: "ca.crt", size: 1107, binary: false }],
  resource_version: "3",
  creation_timestamp: null,
};

const empty: ConfigMapInfo = {
  name: "no-data",
  namespace: "shop",
  keys: [],
  resource_version: "1",
  creation_timestamp: null,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

const read = () => vi.mocked(tauri.readConfigMapValue);
const copy = () => vi.mocked(tauri.copyConfigMapValue);
const serve = (rows: ConfigMapInfo[]) => vi.mocked(tauri.listConfigMaps).mockResolvedValueOnce(rows);

async function renderView(rows: ConfigMapInfo[] = [appConfig(), caBundle, empty]) {
  serve(rows);
  const view = render(ConfigMapsView);
  await screen.findByTestId("list-scroller");
  await screen.findByRole("group", { name: "Keys of app-config" });
  return view;
}

const keys = () => screen.getByRole("group", { name: "Keys of app-config" });
const row = (key: string) => keys().querySelector(`[data-key-row="${key}"]`) as HTMLElement;
const status = () => screen.getByTestId("configmap-status");
const show = (key: string) => within(row(key)).getByRole("button", { name: `Show ${key}` });

/**
 * A cluster switch, in the steps of `switchCluster` (stores/clusters.svelte.ts):
 * `startSwitch` marks the switch running, the old cluster still active and its
 * list still there (the window while the watchers stop); `landSwitch` empties
 * the lists, makes the new context active, waits for its list, and only then
 * ends the switch.
 */
function startSwitch(cluster: string) {
  app.connecting = cluster;
}

async function landSwitch(cluster: string, rows: ConfigMapInfo[]) {
  resources.clear();
  serve(rows);
  app.activeCluster = cluster;
  await vi.waitFor(() => expect(vi.mocked(tauri.listConfigMaps)).toHaveBeenCalledTimes(2));
  await screen.findByRole("group", { name: "Keys of app-config" });
  app.connecting = null;
}

async function switchTo(cluster: string, rows: ConfigMapInfo[]) {
  startSwitch(cluster);
  await landSwitch(cluster, rows);
}

beforeEach(() => {
  installLocalStorageMock();
  vi.mocked(tauri.listConfigMaps).mockReset().mockResolvedValue([]);
  read().mockReset();
  read().mockImplementation(async (_kc, _ns, _name, key) => ({ value: VALUES[key], resource_version: "77" }));
  copy().mockReset();
  copy().mockImplementation(async (_kc, _ns, _name, key) => (key === "logo.png" ? "base64" : "text"));
  app.view = "configmaps";
  app.activeCluster = "prod";
  app.kubeconfigPath = "/home/u/.kube/config";
  app.connecting = null;
  toasts.items = [];
  app.namespace = null;
  resources.clear();
  lists.resetSession();
  lists.groupByNamespace = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ConfigMapsView (#668)", () => {
  it("lists each ConfigMap's keys under it; Data counts them; no chip, no value read", async () => {
    await renderView();
    for (const h of ["Data", "Age"]) expect(screen.getByText(h)).toBeInTheDocument();
    expect(within(screen.getByText("app-config").closest(".list-row")!).getByText("6")).toBeInTheDocument();
    expect(within(screen.getByText("no-data").closest(".list-row")!).getByText("0")).toBeInTheDocument();
    expect(screen.queryByText(/a value is read/)).toBeNull();
    expect(screen.getByRole("group", { name: "Keys of kube-root-ca.crt" })).toBeInTheDocument();
    // A ConfigMap with no key has no block.
    expect(screen.queryByRole("group", { name: "Keys of no-data" })).toBeNull();
    for (const value of Object.values(VALUES)) expect(document.body).not.toHaveTextContent(value);
    expect(read()).not.toHaveBeenCalled();
    expect(copy()).not.toHaveBeenCalled();
  });

  it("draws each key row: sizes, an empty area, Show then Copy; binary, empty and too large as the spec says", async () => {
    await renderView();
    const level = row("LOG_LEVEL");
    expect(level).toHaveTextContent("16 B");
    expect(level).not.toHaveTextContent("••••••••");
    expect(within(level).queryByText("hidden")).toBeNull();
    expect(within(level).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Show LOG_LEVEL",
      "Copy LOG_LEVEL",
    ]);
    expect(show("LOG_LEVEL")).toHaveTextContent("Show");
    expect(row("logo.png")).toHaveTextContent("14 KiB");
    expect(row("logo.png")).toHaveTextContent("binary");
    expect(within(row("logo.png")).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Copy logo.png as base64",
    ]);
    expect(within(row("logo.png")).getByRole("button")).toHaveTextContent("Copy base64");
    expect(row("unused")).toHaveTextContent("empty");
    expect(within(row("unused")).queryByRole("button")).toBeNull();
    expect(row("big.json")).toHaveTextContent("too large to show");
    expect(within(row("big.json")).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Copy big.json",
    ]);
  });

  it("shows one key: the backend is asked once, for that key; line breaks kept; same button, focus kept", async () => {
    await renderView();
    const button = show("application.yaml");
    button.focus();
    await fireEvent.click(button);
    await vi.waitFor(() => expect(row("application.yaml").querySelector("[data-key-shown]")).not.toBeNull());
    expect(row("application.yaml").querySelector("[data-key-shown]")!.textContent).toBe(VALUES["application.yaml"]);
    expect(read()).toHaveBeenCalledTimes(1);
    expect(read()).toHaveBeenCalledWith("/home/u/.kube/config", "shop", "app-config", "application.yaml", "prod");
    expect(document.body).not.toHaveTextContent(VALUES.LOG_LEVEL);
    const hide = within(row("application.yaml")).getByRole("button", { name: "Hide application.yaml" });
    expect(hide).toBe(button);
    expect(document.activeElement).toBe(hide);
    expect(hide).toHaveTextContent("Hide");
    expect(status()).toHaveTextContent("application.yaml shown");
    expect(status()).not.toHaveTextContent("8080");
  });

  it("several keys can be shown at once, and no timer hides them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderView();
    await fireEvent.click(show("LOG_LEVEL"));
    await fireEvent.click(show("FEATURE_FLAGS"));
    await within(row("LOG_LEVEL")).findByText(VALUES.LOG_LEVEL);
    await within(row("FEATURE_FLAGS")).findByText(VALUES.FEATURE_FLAGS);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    window.dispatchEvent(new Event("focus"));
    expect(within(row("LOG_LEVEL")).getByText(VALUES.LOG_LEVEL)).toBeInTheDocument();
    expect(within(row("FEATURE_FLAGS")).getByText(VALUES.FEATURE_FLAGS)).toBeInTheDocument();
  });

  it("reads while the request runs, then Hide drops the value", async () => {
    const answer = deferred<RevealedSecretValue>();
    read().mockReturnValueOnce(answer.promise);
    await renderView();
    await fireEvent.click(show("LOG_LEVEL"));
    const reading = within(row("LOG_LEVEL")).getByRole("button", { name: "Reading LOG_LEVEL" });
    expect(reading).toHaveAttribute("aria-disabled", "true");
    expect(reading).toHaveTextContent("Reading…");
    answer.resolve({ value: VALUES.LOG_LEVEL, resource_version: "77" });
    await within(row("LOG_LEVEL")).findByText(VALUES.LOG_LEVEL);
    await fireEvent.click(within(row("LOG_LEVEL")).getByRole("button", { name: "Hide LOG_LEVEL" }));
    expect(document.body).not.toHaveTextContent(VALUES.LOG_LEVEL);
    expect(status()).toHaveTextContent("LOG_LEVEL hidden");
    expect(show("LOG_LEVEL")).toBeInTheDocument();
  });

  it("an unchanged reload keeps the value; a changed resource version or a vanished key drops it", async () => {
    await renderView();
    await fireEvent.click(show("LOG_LEVEL"));
    await within(row("LOG_LEVEL")).findByText(VALUES.LOG_LEVEL);

    serve([appConfig("77"), caBundle]);
    await resources.loadKind("configmaps");
    expect(within(row("LOG_LEVEL")).getByText(VALUES.LOG_LEVEL)).toBeInTheDocument();

    serve([appConfig("78"), caBundle]);
    await resources.loadKind("configmaps");
    await vi.waitFor(() => expect(document.body).not.toHaveTextContent(VALUES.LOG_LEVEL));

    read().mockImplementation(async (_kc, _ns, _name, key) => ({ value: VALUES[key], resource_version: "78" }));
    await fireEvent.click(show("FEATURE_FLAGS"));
    await within(row("FEATURE_FLAGS")).findByText(VALUES.FEATURE_FLAGS);
    serve([appConfig("78", ["LOG_LEVEL", "application.yaml"])]);
    await resources.loadKind("configmaps");
    await vi.waitFor(() => expect(document.body).not.toHaveTextContent(VALUES.FEATURE_FLAGS));
  });

  it("a namespace change drops shown values, and a late answer is thrown away", async () => {
    await renderView();
    await fireEvent.click(show("LOG_LEVEL"));
    await within(row("LOG_LEVEL")).findByText(VALUES.LOG_LEVEL);
    const late = deferred<RevealedSecretValue>();
    read().mockReturnValueOnce(late.promise);
    await fireEvent.click(show("FEATURE_FLAGS"));

    serve([appConfig()]);
    app.namespace = "shop";
    await vi.waitFor(() => expect(vi.mocked(tauri.listConfigMaps)).toHaveBeenCalledTimes(2));
    late.resolve({ value: VALUES.FEATURE_FLAGS, resource_version: "77" });
    await new Promise((r) => setTimeout(r, 0));
    await screen.findByRole("group", { name: "Keys of app-config" });
    expect(document.body).not.toHaveTextContent(VALUES.LOG_LEVEL);
    expect(document.body).not.toHaveTextContent(VALUES.FEATURE_FLAGS);
  });

  it("leaving the view drops the value, and an answer after it is thrown away", async () => {
    const view = await renderView();
    await fireEvent.click(show("LOG_LEVEL"));
    await within(row("LOG_LEVEL")).findByText(VALUES.LOG_LEVEL);
    const late = deferred<RevealedSecretValue>();
    read().mockReturnValueOnce(late.promise);
    await fireEvent.click(show("FEATURE_FLAGS"));
    view.unmount();
    late.resolve({ value: VALUES.FEATURE_FLAGS, resource_version: "77" });
    await new Promise((r) => setTimeout(r, 0));
    await renderView();
    expect(document.body).not.toHaveTextContent(VALUES.LOG_LEVEL);
    expect(document.body).not.toHaveTextContent(VALUES.FEATURE_FLAGS);
    expect(show("LOG_LEVEL")).toBeInTheDocument();
    expect(show("FEATURE_FLAGS")).toBeInTheDocument();
  });

  it("a late answer after a cluster change is thrown away", async () => {
    const late = deferred<RevealedSecretValue>();
    read().mockReturnValueOnce(late.promise);
    await renderView();
    await fireEvent.click(show("LOG_LEVEL"));
    serve([appConfig()]);
    app.activeCluster = "staging";
    await vi.waitFor(() => expect(vi.mocked(tauri.listConfigMaps)).toHaveBeenCalledTimes(2));
    late.resolve({ value: VALUES.LOG_LEVEL, resource_version: "77" });
    await new Promise((r) => setTimeout(r, 0));
    await screen.findByRole("group", { name: "Keys of app-config" });
    expect(document.body).not.toHaveTextContent(VALUES.LOG_LEVEL);
  });

  describe("bound to the cluster it was clicked on (#690)", () => {
    it("a value read on prod that lands while the switch to staging runs is not shown, then or after", async () => {
      await renderView();
      const late = deferred<RevealedSecretValue>();
      read().mockReturnValueOnce(late.promise);
      await fireEvent.click(show("LOG_LEVEL"));
      expect(read()).toHaveBeenCalledExactlyOnceWith("/home/u/.kube/config", "shop", "app-config", "LOG_LEVEL", "prod");

      // The window before the lists are emptied: prod is still the active
      // context and its ConfigMap still listed; only the switch running says prod is left.
      startSwitch("staging");
      late.resolve({ value: VALUES.LOG_LEVEL, resource_version: "77" });
      await new Promise((r) => setTimeout(r, 0));
      expect(document.body).not.toHaveTextContent(VALUES.LOG_LEVEL);
      expect(status()).not.toHaveTextContent("LOG_LEVEL shown");

      await landSwitch("staging", [appConfig()]);
      expect(document.body).not.toHaveTextContent(VALUES.LOG_LEVEL);
      expect(show("LOG_LEVEL")).toBeInTheDocument();
    });

    it("a value read on prod that lands after the switch never shows on staging's ConfigMap of the same name", async () => {
      await renderView();
      const late = deferred<RevealedSecretValue>();
      read().mockReturnValueOnce(late.promise);
      await fireEvent.click(show("LOG_LEVEL"));
      // Characterisation: the emptied list drops the read already, as before #690.
      await switchTo("staging", [appConfig()]);
      late.resolve({ value: VALUES.LOG_LEVEL, resource_version: "77" });
      await new Promise((r) => setTimeout(r, 0));
      expect(document.body).not.toHaveTextContent(VALUES.LOG_LEVEL);
      expect(show("LOG_LEVEL")).toBeInTheDocument();
      expect(status()).not.toHaveTextContent("LOG_LEVEL shown");
    });

    it("a copy that ends after a switch is told in a toast naming prod, and staging's row stays at rest", async () => {
      await renderView();
      const late = deferred<CopyFormat>();
      copy().mockReturnValueOnce(late.promise);
      await fireEvent.click(within(row("LOG_LEVEL")).getByRole("button", { name: "Copy LOG_LEVEL" }));
      expect(copy()).toHaveBeenCalledExactlyOnceWith("/home/u/.kube/config", "shop", "app-config", "LOG_LEVEL", "prod");

      app.kubeconfigPath = "/home/u/.kube/other";
      await switchTo("staging", [appConfig()]);
      late.resolve("text");
      await vi.waitFor(() =>
        expect(toasts.items.map((t) => [t.message, t.tone])).toEqual([["LOG_LEVEL of app-config copied on prod", "ok"]]),
      );
      expect(within(row("LOG_LEVEL")).getByRole("button", { name: "Copy LOG_LEVEL" })).toHaveTextContent("Copy");
      expect(status()).not.toHaveTextContent("LOG_LEVEL copied");
      for (const value of Object.values(VALUES)) expect(document.body).not.toHaveTextContent(value);
    });

    it("a copy that ends on the cluster on screen says so in its row, with no toast", async () => {
      await renderView();
      await fireEvent.click(within(row("LOG_LEVEL")).getByRole("button", { name: "Copy LOG_LEVEL" }));
      expect(await within(row("LOG_LEVEL")).findByRole("button", { name: "Copied LOG_LEVEL" })).toBeInTheDocument();
      expect(toasts.items).toEqual([]);
    });
  });

  describe("row errors (§3.3)", () => {
    it("a 403 says it is not allowed, and Show is there again", async () => {
      read().mockRejectedValueOnce({ kind: "forbidden", message: 'configmaps "app-config" is forbidden' });
      await renderView();
      await fireEvent.click(show("LOG_LEVEL"));
      expect(await within(row("LOG_LEVEL")).findByText("Not allowed to read this ConfigMap (403)")).toBeInTheDocument();
      expect(row("LOG_LEVEL").querySelector('[data-glyph="err"]')).not.toBeNull();
      expect(show("LOG_LEVEL")).toBeInTheDocument();
      expect(status()).toHaveTextContent("LOG_LEVEL: Not allowed to read this ConfigMap (403)");
    });

    it("a vanished ConfigMap says so and reloads the list", async () => {
      read().mockRejectedValueOnce({ kind: "configmap_missing", message: "ConfigMap shop/app-config no longer exists" });
      await renderView();
      serve([appConfig()]);
      await fireEvent.click(show("LOG_LEVEL"));
      expect(await within(row("LOG_LEVEL")).findByText("No longer exists")).toBeInTheDocument();
      await vi.waitFor(() => expect(vi.mocked(tauri.listConfigMaps)).toHaveBeenCalledTimes(2));
    });

    it("any other failure shows the API error's message", async () => {
      read().mockRejectedValueOnce({ kind: "other", message: "connection refused" });
      await renderView();
      await fireEvent.click(show("LOG_LEVEL"));
      expect(await within(row("LOG_LEVEL")).findByText("connection refused")).toBeInTheDocument();
    });
  });

  describe("Copy (§3.1, §6.2)", () => {
    it("copies through the backend and no value reaches the page", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await renderView();
      const button = within(row("application.yaml")).getByRole("button", { name: "Copy application.yaml" });
      button.focus();
      await fireEvent.click(button);
      expect(copy()).toHaveBeenCalledTimes(1);
      expect(copy()).toHaveBeenCalledWith("/home/u/.kube/config", "shop", "app-config", "application.yaml", "prod");
      const copied = await within(row("application.yaml")).findByRole("button", { name: "Copied application.yaml" });
      expect(copied).toBe(button);
      expect(document.activeElement).toBe(button);
      expect(copied).toHaveTextContent("Copied");
      await vi.waitFor(() => expect(status()).toHaveTextContent(/^application\.yaml copied$/));
      // Copy does not show, and nothing read is in the page.
      expect(show("application.yaml")).toBeInTheDocument();
      expect(read()).not.toHaveBeenCalled();
      for (const value of Object.values(VALUES)) expect(document.body).not.toHaveTextContent(value);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(within(row("application.yaml")).getByRole("button", { name: "Copy application.yaml" })).toHaveTextContent(
        "Copy",
      );
    });

    it("copies a binary value as base64", async () => {
      await renderView();
      await fireEvent.click(within(row("logo.png")).getByRole("button", { name: "Copy logo.png as base64" }));
      expect(copy()).toHaveBeenCalledWith("/home/u/.kube/config", "shop", "app-config", "logo.png", "prod");
      expect(await within(row("logo.png")).findByRole("button", { name: "Copied logo.png as base64" })).toBeInTheDocument();
      await vi.waitFor(() => expect(status()).toHaveTextContent(/^logo\.png copied$/));
    });

    it("a refused copy says so in the row, with the glyph", async () => {
      copy().mockRejectedValueOnce({ kind: "forbidden", message: 'configmaps "app-config" is forbidden' });
      await renderView();
      await fireEvent.click(within(row("big.json")).getByRole("button", { name: "Copy big.json" }));
      expect(await within(row("big.json")).findByText("Not allowed to read this ConfigMap (403)")).toBeInTheDocument();
      expect(row("big.json").querySelector('[data-glyph="err"]')).not.toBeNull();
      expect(status()).toHaveTextContent("big.json: Not allowed to read this ConfigMap (403)");
    });

    it("a vanished key on copy says so and reloads the list", async () => {
      copy().mockRejectedValueOnce({ kind: "key_missing", message: "ConfigMap shop/app-config has no key LOG_LEVEL" });
      await renderView();
      serve([appConfig()]);
      await fireEvent.click(within(row("LOG_LEVEL")).getByRole("button", { name: "Copy LOG_LEVEL" }));
      expect(await within(row("LOG_LEVEL")).findByText("No longer exists")).toBeInTheDocument();
      await vi.waitFor(() => expect(vi.mocked(tauri.listConfigMaps)).toHaveBeenCalledTimes(2));
    });
  });
});
