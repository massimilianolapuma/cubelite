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
  revealSecretValue: vi.fn(),
  copySecretValue: vi.fn(),
  exportSecretEnv: vi.fn(),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import SecretsView from "./SecretsView.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { lists } from "#lib/stores/lists.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { settings } from "#lib/stores/settings.svelte.ts";
import { toasts } from "#lib/stores/toasts.svelte.ts";
import { installLocalStorageMock } from "#lib/stores/storage-mock.ts";
import * as tauri from "#lib/tauri.ts";
import type { CopyFormat, RevealedSecretValue, SecretInfo } from "#lib/tauri.ts";

/** Values the backend holds; only the one asked for may reach the DOM. */
const VALUES: Record<string, string> = {
  API_KEY: "ak-0d9f8e7c6b5a",
  DB_PASSWORD: "s3cr3t-p4ss!",
  DB_USER: "shop_owner",
};

const apiCredentials = (rv = "41", keys = ["API_KEY", "DB_PASSWORD", "DB_USER"]): SecretInfo => ({
  name: "api-credentials",
  namespace: "shop",
  secret_type: "Opaque",
  keys: [
    ...keys.map((key) => ({ key, size: VALUES[key].length, binary: false })),
    { key: "ca.crt", size: 1843, binary: true },
    { key: "EMPTY", size: 0, binary: false },
    { key: "huge.json", size: 70_000, binary: false },
  ].sort((a, b) => (a.key < b.key ? -1 : 1)),
  helm_release: false,
  resource_version: rv,
  creation_timestamp: null,
});

const helmRelease: SecretInfo = {
  name: "sh.helm.release.v1.api.v7",
  namespace: "shop",
  secret_type: "helm.sh/release.v1",
  keys: [{ key: "release", size: 49_357, binary: false }],
  helm_release: true,
  resource_version: "9",
  creation_timestamp: null,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

const reveal = () => vi.mocked(tauri.revealSecretValue);
const copy = () => vi.mocked(tauri.copySecretValue);
const exportEnv = () => vi.mocked(tauri.exportSecretEnv);
const serve = (rows: SecretInfo[]) => vi.mocked(tauri.listSecrets).mockResolvedValueOnce(rows);

async function renderView(rows: SecretInfo[] = [apiCredentials(), helmRelease]) {
  serve(rows);
  const view = render(SecretsView);
  await screen.findByTestId("list-scroller");
  await screen.findByRole("group", { name: "Keys of api-credentials" });
  return view;
}

const keys = () => screen.getByRole("group", { name: "Keys of api-credentials" });
const row = (key: string) => keys().querySelector(`[data-key-row="${key}"]`) as HTMLElement;
const status = () => screen.getByTestId("secret-status");

/** A cluster switch as `switchCluster` makes it: lists emptied, then the new context, then its list. */
async function switchTo(cluster: string, rows: SecretInfo[]) {
  app.connecting = cluster;
  resources.clear();
  serve(rows);
  app.activeCluster = cluster;
  app.connecting = null;
  await vi.waitFor(() => expect(vi.mocked(tauri.listSecrets)).toHaveBeenCalledTimes(2));
  await screen.findByRole("group", { name: "Keys of api-credentials" });
}

beforeEach(() => {
  installLocalStorageMock();
  vi.mocked(tauri.listSecrets).mockReset().mockResolvedValue([]);
  reveal().mockReset();
  reveal().mockImplementation(async (_kc, _ns, _name, key) => ({ value: VALUES[key], resource_version: "41" }));
  copy().mockReset();
  copy().mockImplementation(async (_kc, _ns, _name, key) => (key === "ca.crt" ? "base64" : "text"));
  exportEnv().mockReset();
  toasts.items = [];
  settings.secretHideAfter.value = 30;
  app.view = "secrets";
  app.activeCluster = "prod";
  app.kubeconfigPath = "/home/u/.kube/config";
  app.connecting = null;
  app.namespace = null;
  resources.clear();
  lists.resetSession();
  lists.groupByNamespace = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SecretsView (#661)", () => {
  it("says a value is read only on reveal or copy, and has an Export column", async () => {
    await renderView();
    expect(screen.getByText("a value is read only when you reveal or copy it")).toBeInTheDocument();
    expect(screen.queryByText(/decoded on this machine/)).toBeNull();
    for (const h of ["Type", "Data", "Age", "Export"]) expect(screen.getByText(h)).toBeInTheDocument();
    expect(screen.queryByText("Reveal", { selector: ".list-head *" })).toBeNull();
    // Data counts the keys.
    expect(within(screen.getByText("api-credentials").closest(".list-row")!).getByText("6")).toBeInTheDocument();
  });

  it("draws each key row in its state, with sizes and no value", async () => {
    await renderView();
    const pw = row("DB_PASSWORD");
    expect(pw).toHaveTextContent("12 B");
    expect(within(pw).getByText("••••••••")).toHaveAttribute("aria-hidden", "true");
    expect(within(pw).getByText("hidden")).toHaveClass("sr-only");
    expect(within(pw).getByRole("button", { name: "Reveal DB_PASSWORD" })).toBeInTheDocument();

    expect(row("ca.crt")).toHaveTextContent("1.8 KiB");
    expect(row("ca.crt")).toHaveTextContent("binary");
    expect(row("EMPTY")).toHaveTextContent("empty");
    expect(row("huge.json")).toHaveTextContent("too large to show");
    // Binary: no Reveal, Copy base64. Too large: Copy only. Empty: nothing.
    expect(within(row("ca.crt")).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Copy ca.crt as base64",
    ]);
    expect(within(row("ca.crt")).getByRole("button")).toHaveTextContent("Copy base64");
    expect(within(row("huge.json")).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Copy huge.json",
    ]);
    expect(within(row("EMPTY")).queryByRole("button")).toBeNull();
    // Per key, Reveal then Copy.
    expect(within(pw).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Reveal DB_PASSWORD",
      "Copy DB_PASSWORD",
    ]);
    expect(within(pw).getByRole("button", { name: "Copy DB_PASSWORD" })).toHaveTextContent("Copy");

    const helm = screen.getByRole("group", { name: "Keys of sh.helm.release.v1.api.v7" });
    const release = helm.querySelector('[data-key-row="release"]') as HTMLElement;
    expect(release).toHaveTextContent("release");
    expect(release).toHaveTextContent("48.2 KiB");
    expect(release).toHaveTextContent("Helm release payload, shown in Helm");
    expect(within(helm).queryByRole("button")).toBeNull();

    for (const value of Object.values(VALUES)) expect(document.body).not.toHaveTextContent(value);
    expect(reveal()).not.toHaveBeenCalled();
    expect(copy()).not.toHaveBeenCalled();
  });

  it("reveals one key: the backend is asked once, for that key, and no other value reaches the page", async () => {
    await renderView();
    const button = within(row("DB_PASSWORD")).getByRole("button", { name: "Reveal DB_PASSWORD" });
    button.focus();
    await fireEvent.click(button);
    expect(await within(row("DB_PASSWORD")).findByText(VALUES.DB_PASSWORD)).toBeInTheDocument();
    expect(reveal()).toHaveBeenCalledTimes(1);
    expect(reveal()).toHaveBeenCalledWith("/home/u/.kube/config", "shop", "api-credentials", "DB_PASSWORD", "prod");
    expect(document.body).not.toHaveTextContent(VALUES.API_KEY);
    expect(document.body).not.toHaveTextContent(VALUES.DB_USER);
    // Same button, new name, focus kept.
    const hide = within(row("DB_PASSWORD")).getByRole("button", { name: "Hide DB_PASSWORD" });
    expect(hide).toBe(button);
    expect(document.activeElement).toBe(hide);
    expect(status()).toHaveTextContent("DB_PASSWORD shown");
    expect(status()).not.toHaveTextContent(VALUES.DB_PASSWORD);
  });

  it("reads while the request runs, then Hide drops the value", async () => {
    const answer = deferred<RevealedSecretValue>();
    reveal().mockReturnValueOnce(answer.promise);
    await renderView();
    await fireEvent.click(within(row("DB_PASSWORD")).getByRole("button", { name: "Reveal DB_PASSWORD" }));
    const reading = within(row("DB_PASSWORD")).getByRole("button", { name: "Reading DB_PASSWORD" });
    expect(reading).toHaveAttribute("aria-disabled", "true");
    expect(reading).toHaveTextContent("Reading…");
    answer.resolve({ value: VALUES.DB_PASSWORD, resource_version: "41" });
    await within(row("DB_PASSWORD")).findByText(VALUES.DB_PASSWORD);
    await fireEvent.click(within(row("DB_PASSWORD")).getByRole("button", { name: "Hide DB_PASSWORD" }));
    expect(document.body).not.toHaveTextContent(VALUES.DB_PASSWORD);
    expect(status()).toHaveTextContent("DB_PASSWORD hidden");
  });

  it("hides a value when the time set in Preferences ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    settings.secretHideAfter.value = 15;
    await renderView();
    await fireEvent.click(within(row("DB_USER")).getByRole("button", { name: "Reveal DB_USER" }));
    await within(row("DB_USER")).findByText(VALUES.DB_USER);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(document.body).not.toHaveTextContent(VALUES.DB_USER);
    expect(within(row("DB_USER")).getByRole("button", { name: "Reveal DB_USER" })).toBeInTheDocument();
  });

  it("an unchanged reload keeps the value; a changed resource version or a vanished key drops it", async () => {
    await renderView();
    await fireEvent.click(within(row("DB_PASSWORD")).getByRole("button", { name: "Reveal DB_PASSWORD" }));
    await within(row("DB_PASSWORD")).findByText(VALUES.DB_PASSWORD);

    serve([apiCredentials("41"), helmRelease]);
    await resources.loadKind("secrets");
    expect(within(row("DB_PASSWORD")).getByText(VALUES.DB_PASSWORD)).toBeInTheDocument();

    serve([apiCredentials("42"), helmRelease]);
    await resources.loadKind("secrets");
    await vi.waitFor(() => expect(document.body).not.toHaveTextContent(VALUES.DB_PASSWORD));

    // The Secret is at 42 now: so is what the backend reads.
    reveal().mockImplementation(async (_kc, _ns, _name, key) => ({ value: VALUES[key], resource_version: "42" }));
    await fireEvent.click(within(row("DB_USER")).getByRole("button", { name: "Reveal DB_USER" }));
    await within(row("DB_USER")).findByText(VALUES.DB_USER);
    serve([apiCredentials("42", ["API_KEY", "DB_PASSWORD"])]);
    await resources.loadKind("secrets");
    await vi.waitFor(() => expect(document.body).not.toHaveTextContent(VALUES.DB_USER));
  });

  it("a namespace change drops shown values, and a late answer is thrown away", async () => {
    await renderView();
    await fireEvent.click(within(row("DB_USER")).getByRole("button", { name: "Reveal DB_USER" }));
    await within(row("DB_USER")).findByText(VALUES.DB_USER);
    const late = deferred<RevealedSecretValue>();
    reveal().mockReturnValueOnce(late.promise);
    await fireEvent.click(within(row("DB_PASSWORD")).getByRole("button", { name: "Reveal DB_PASSWORD" }));

    serve([apiCredentials()]);
    app.namespace = "shop";
    await vi.waitFor(() => expect(vi.mocked(tauri.listSecrets)).toHaveBeenCalledTimes(2));
    late.resolve({ value: VALUES.DB_PASSWORD, resource_version: "41" });
    await new Promise((r) => setTimeout(r, 0));
    await screen.findByRole("group", { name: "Keys of api-credentials" });
    expect(document.body).not.toHaveTextContent(VALUES.DB_USER);
    expect(document.body).not.toHaveTextContent(VALUES.DB_PASSWORD);
  });

  it("leaving the view drops the value, and an answer after it is thrown away", async () => {
    const view = await renderView();
    const late = deferred<RevealedSecretValue>();
    reveal().mockReturnValueOnce(late.promise);
    await fireEvent.click(within(row("DB_PASSWORD")).getByRole("button", { name: "Reveal DB_PASSWORD" }));
    view.unmount();
    late.resolve({ value: VALUES.DB_PASSWORD, resource_version: "41" });
    await new Promise((r) => setTimeout(r, 0));
    // Back in the view: the key is hidden, nothing was stored.
    await renderView();
    expect(document.body).not.toHaveTextContent(VALUES.DB_PASSWORD);
    expect(within(row("DB_PASSWORD")).getByRole("button", { name: "Reveal DB_PASSWORD" })).toBeInTheDocument();
  });

  describe("bound to the cluster it was clicked on (#690)", () => {
    it("a value read on prod never shows on staging's Secret of the same name", async () => {
      await renderView();
      const late = deferred<RevealedSecretValue>();
      reveal().mockReturnValueOnce(late.promise);
      await fireEvent.click(within(row("API_KEY")).getByRole("button", { name: "Reveal API_KEY" }));
      expect(reveal()).toHaveBeenCalledExactlyOnceWith("/home/u/.kube/config", "shop", "api-credentials", "API_KEY", "prod");

      app.kubeconfigPath = "/home/u/.kube/other";
      await switchTo("staging", [apiCredentials()]);
      late.resolve({ value: VALUES.API_KEY, resource_version: "41" });
      await new Promise((r) => setTimeout(r, 0));
      expect(document.body).not.toHaveTextContent(VALUES.API_KEY);
      expect(within(row("API_KEY")).getByRole("button", { name: "Reveal API_KEY" })).toBeInTheDocument();
      expect(status()).not.toHaveTextContent("API_KEY shown");
    });

    it("a copy that ends after a switch is told in a toast naming prod, and staging's row stays at rest", async () => {
      await renderView();
      const late = deferred<CopyFormat>();
      copy().mockReturnValueOnce(late.promise);
      await fireEvent.click(within(row("API_KEY")).getByRole("button", { name: "Copy API_KEY" }));
      expect(copy()).toHaveBeenCalledExactlyOnceWith("/home/u/.kube/config", "shop", "api-credentials", "API_KEY", 30, "prod");

      app.kubeconfigPath = "/home/u/.kube/other";
      await switchTo("staging", [apiCredentials()]);
      late.resolve("text");
      await vi.waitFor(() =>
        expect(toasts.items.map((t) => [t.message, t.tone])).toEqual([
          ["API_KEY of api-credentials copied on prod, the clipboard is cleared in 30 seconds", "ok"],
        ]),
      );
      expect(within(row("API_KEY")).getByRole("button", { name: "Copy API_KEY" })).toHaveTextContent("Copy");
      expect(status()).not.toHaveTextContent("API_KEY copied");
      for (const value of Object.values(VALUES)) expect(document.body).not.toHaveTextContent(value);
    });

    it("a copy that ends on the cluster on screen says so in its row, with no toast", async () => {
      await renderView();
      await fireEvent.click(within(row("API_KEY")).getByRole("button", { name: "Copy API_KEY" }));
      expect(await within(row("API_KEY")).findByRole("button", { name: "Copied API_KEY" })).toBeInTheDocument();
      expect(toasts.items).toEqual([]);
    });
  });

  it("announces the same words again for another Secret's key of the same name", async () => {
    const other: SecretInfo = { ...apiCredentials(), name: "worker-credentials" };
    await renderView([apiCredentials(), other]);
    const heard: string[] = [];
    const observer = new MutationObserver(() => heard.push(status().textContent ?? ""));
    observer.observe(status(), { childList: true, characterData: true, subtree: true });
    await fireEvent.click(within(row("DB_USER")).getByRole("button", { name: "Reveal DB_USER" }));
    await vi.waitFor(() => expect(status()).toHaveTextContent("DB_USER shown"));
    const second = screen.getByRole("group", { name: "Keys of worker-credentials" });
    await fireEvent.click(within(second).getByRole("button", { name: "Reveal DB_USER" }));
    await vi.waitFor(() => expect(heard.filter((t) => t === "DB_USER shown")).toHaveLength(2));
    observer.disconnect();
  });

  it("a new time in Preferences applies to a value already shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderView();
    await fireEvent.click(within(row("DB_USER")).getByRole("button", { name: "Reveal DB_USER" }));
    await within(row("DB_USER")).findByText(VALUES.DB_USER);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(within(row("DB_USER")).getByText(VALUES.DB_USER)).toBeInTheDocument();
    settings.secretHideAfter.value = 15;
    await vi.waitFor(() => expect(document.body).not.toHaveTextContent(VALUES.DB_USER));
  });

  for (const [what, fire] of [
    ["the window takes the focus", () => window.dispatchEvent(new Event("focus"))],
    ["the page becomes visible", () => document.dispatchEvent(new Event("visibilitychange"))],
  ] as const) {
    it(`after a sleep, a value past its time hides when ${what}`, async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await renderView();
      await fireEvent.click(within(row("DB_USER")).getByRole("button", { name: "Reveal DB_USER" }));
      await within(row("DB_USER")).findByText(VALUES.DB_USER);
      vi.setSystemTime(Date.now() + 31_000);
      expect(within(row("DB_USER")).getByText(VALUES.DB_USER)).toBeInTheDocument();
      fire();
      await vi.waitFor(() => expect(document.body).not.toHaveTextContent(VALUES.DB_USER));
    });
  }

  it("an answer read at an older version than the list is not shown, and the list reloads", async () => {
    await renderView([apiCredentials("42")]);
    const answer = deferred<RevealedSecretValue>();
    reveal().mockReturnValueOnce(answer.promise);
    serve([apiCredentials("42")]);
    await fireEvent.click(within(row("DB_PASSWORD")).getByRole("button", { name: "Reveal DB_PASSWORD" }));
    answer.resolve({ value: VALUES.DB_PASSWORD, resource_version: "41" });
    await vi.waitFor(() => expect(vi.mocked(tauri.listSecrets)).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(within(row("DB_PASSWORD")).getByRole("button", { name: "Reveal DB_PASSWORD" })).toBeInTheDocument(),
    );
    expect(document.body).not.toHaveTextContent(VALUES.DB_PASSWORD);
  });

  describe("row errors (§3.5)", () => {
    it("a 403 says it is not allowed, and Reveal is there again", async () => {
      reveal().mockRejectedValueOnce({ kind: "forbidden", message: 'secrets "api-credentials" is forbidden' });
      await renderView();
      await fireEvent.click(within(row("API_KEY")).getByRole("button", { name: "Reveal API_KEY" }));
      expect(await within(row("API_KEY")).findByText("Not allowed to read this Secret (403)")).toBeInTheDocument();
      expect(row("API_KEY").querySelector('[data-glyph="err"]')).not.toBeNull();
      expect(within(row("API_KEY")).getByRole("button", { name: "Reveal API_KEY" })).toBeInTheDocument();
      expect(status()).toHaveTextContent("API_KEY: Not allowed to read this Secret (403)");
    });

    it("a vanished key says so and reloads the list", async () => {
      reveal().mockRejectedValueOnce({ kind: "key_missing", message: "Secret shop/api-credentials has no key API_KEY" });
      await renderView();
      serve([apiCredentials()]);
      await fireEvent.click(within(row("API_KEY")).getByRole("button", { name: "Reveal API_KEY" }));
      expect(await within(row("API_KEY")).findByText("No longer exists")).toBeInTheDocument();
      await vi.waitFor(() => expect(vi.mocked(tauri.listSecrets)).toHaveBeenCalledTimes(2));
    });

    it("any other failure shows the API error's message", async () => {
      reveal().mockRejectedValueOnce({ kind: "other", message: "connection refused" });
      await renderView();
      await fireEvent.click(within(row("API_KEY")).getByRole("button", { name: "Reveal API_KEY" }));
      expect(await within(row("API_KEY")).findByText("connection refused")).toBeInTheDocument();
    });
  });

  describe("Copy (§3.1, §6.2)", () => {
    it("copies through the backend with the Preferences time, and no value reaches the page", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await renderView();
      const button = within(row("DB_PASSWORD")).getByRole("button", { name: "Copy DB_PASSWORD" });
      button.focus();
      await fireEvent.click(button);
      expect(copy()).toHaveBeenCalledTimes(1);
      expect(copy()).toHaveBeenCalledWith("/home/u/.kube/config", "shop", "api-credentials", "DB_PASSWORD", 30, "prod");
      const copied = await within(row("DB_PASSWORD")).findByRole("button", { name: "Copied DB_PASSWORD" });
      expect(copied).toBe(button);
      expect(document.activeElement).toBe(button);
      expect(copied).toHaveTextContent("Copied");
      await vi.waitFor(() =>
        expect(status()).toHaveTextContent("DB_PASSWORD copied, the clipboard is cleared in 30 seconds"),
      );
      // Copy does not reveal, and nothing read is in the page.
      expect(within(row("DB_PASSWORD")).getByRole("button", { name: "Reveal DB_PASSWORD" })).toBeInTheDocument();
      expect(reveal()).not.toHaveBeenCalled();
      for (const value of Object.values(VALUES)) expect(document.body).not.toHaveTextContent(value);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(within(row("DB_PASSWORD")).getByRole("button", { name: "Copy DB_PASSWORD" })).toHaveTextContent("Copy");
    });

    it("with Never, sends no time and says only copied", async () => {
      settings.secretHideAfter.value = 0;
      await renderView();
      await fireEvent.click(within(row("DB_USER")).getByRole("button", { name: "Copy DB_USER" }));
      expect(copy()).toHaveBeenCalledWith("/home/u/.kube/config", "shop", "api-credentials", "DB_USER", 0, "prod");
      await vi.waitFor(() => expect(status()).toHaveTextContent(/^DB_USER copied$/));
    });

    it("copies a binary value as base64", async () => {
      await renderView();
      await fireEvent.click(within(row("ca.crt")).getByRole("button", { name: "Copy ca.crt as base64" }));
      expect(copy()).toHaveBeenCalledWith("/home/u/.kube/config", "shop", "api-credentials", "ca.crt", 30, "prod");
      expect(await within(row("ca.crt")).findByRole("button", { name: "Copied ca.crt as base64" })).toBeInTheDocument();
    });

    it("a copy overtaken by a later one is not shown as copied", async () => {
      copy().mockRejectedValueOnce({ kind: "other", message: "Not copied: a later copy took its place" });
      await renderView();
      await fireEvent.click(within(row("DB_USER")).getByRole("button", { name: "Copy DB_USER" }));
      expect(await within(row("DB_USER")).findByText("Not copied: a later copy took its place")).toBeInTheDocument();
      expect(within(row("DB_USER")).queryByRole("button", { name: /Copied/ })).toBeNull();
      expect(status()).toHaveTextContent("DB_USER: Not copied: a later copy took its place");
      expect(status()).not.toHaveTextContent(/copied, the clipboard/);
    });

    it("a refused copy says so in the row, with the glyph", async () => {
      copy().mockRejectedValueOnce({ kind: "forbidden", message: 'secrets "api-credentials" is forbidden' });
      await renderView();
      await fireEvent.click(within(row("ca.crt")).getByRole("button", { name: "Copy ca.crt as base64" }));
      expect(await within(row("ca.crt")).findByText("Not allowed to read this Secret (403)")).toBeInTheDocument();
      expect(row("ca.crt").querySelector('[data-glyph="err"]')).not.toBeNull();
      expect(status()).toHaveTextContent("ca.crt: Not allowed to read this Secret (403)");
      // The next copy clears it.
      await fireEvent.click(within(row("ca.crt")).getByRole("button", { name: "Copy ca.crt as base64" }));
      await vi.waitFor(() => expect(within(row("ca.crt")).queryByText(/Not allowed/)).toBeNull());
    });
  });

  describe("Download as .env (§3.3)", () => {
    const envButton = (name = "api-credentials") => screen.getByRole("button", { name: `Download ${name} as .env` });
    const dialog = () => screen.getByRole("dialog", { name: "Download api-credentials as .env" });

    it("offers .env per Secret, not for a Helm release", async () => {
      await renderView();
      expect(envButton()).toHaveTextContent(".env");
      expect(screen.queryByRole("button", { name: "Download sh.helm.release.v1.api.v7 as .env" })).toBeNull();
      // Its .env comes before its key rows.
      const order = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
      expect(order.indexOf("Download api-credentials as .env")).toBeLessThan(order.indexOf("Reveal API_KEY"));
    });

    it("draws the confirmation from the list, reading nothing, with the focus on Cancel", async () => {
      await renderView();
      await fireEvent.click(envButton());
      const d = dialog();
      expect(d).toHaveTextContent("4 values will be written to a file in plain text:");
      expect(within(d).getByText("API_KEY, DB_PASSWORD, DB_USER, EMPTY")).toBeInTheDocument();
      expect(d).toHaveTextContent("2 keys are left out:");
      expect(within(d).getByText("ca.crt (binary), huge.json (not a variable name)")).toBeInTheDocument();
      expect(d).toHaveTextContent("Written for a shell: set -a; . ./api-credentials.env");
      expect(d).toHaveTextContent("Anyone who can read the file can read these values. CubeLite does not delete it.");
      expect(d.querySelector('[data-glyph="warn"]')).not.toBeNull();
      expect(document.activeElement).toBe(within(d).getByRole("button", { name: "Cancel" }));
      expect(within(d).getByRole("button", { name: "Choose where to save…" })).toBeInTheDocument();
      expect(exportEnv()).not.toHaveBeenCalled();
      expect(reveal()).not.toHaveBeenCalled();
      expect(copy()).not.toHaveBeenCalled();
      await fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(exportEnv()).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(document.activeElement).toBe(envButton()));
    });

    it("saves through the backend and says how many values went where", async () => {
      exportEnv().mockResolvedValueOnce({
        saved: true,
        path: "/home/u/api-credentials.env",
        written: ["API_KEY", "DB_PASSWORD", "DB_USER", "EMPTY"],
        left_out: [
          { key: "ca.crt", reason: "binary" },
          { key: "huge.json", reason: "not_a_name" },
        ],
      });
      await renderView();
      await fireEvent.click(envButton());
      await fireEvent.click(within(dialog()).getByRole("button", { name: "Choose where to save…" }));
      expect(exportEnv()).toHaveBeenCalledWith("/home/u/.kube/config", "shop", "api-credentials", "prod");
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(toasts.items.map((t) => [t.message, t.tone])).toEqual([
        ["4 values of api-credentials saved to /home/u/api-credentials.env", "ok"],
      ]);
    });

    it("a cancelled save dialog says nothing", async () => {
      exportEnv().mockResolvedValueOnce({ saved: false, path: null, written: [], left_out: [] });
      await renderView();
      await fireEvent.click(envButton());
      await fireEvent.click(within(dialog()).getByRole("button", { name: "Choose where to save…" }));
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(toasts.items).toEqual([]);
    });

    it("a refused export is a toast with the reason, never a value", async () => {
      exportEnv().mockRejectedValueOnce({ kind: "forbidden", message: "secrets is forbidden" });
      await renderView();
      await fireEvent.click(envButton());
      await fireEvent.click(within(dialog()).getByRole("button", { name: "Choose where to save…" }));
      await vi.waitFor(() =>
        expect(toasts.items.map((t) => [t.message, t.tone])).toEqual([
          ["Could not save api-credentials as .env: Not allowed to read this Secret (403)", "err"],
        ]),
      );
    });

    it("with no key that can be written, says so and has only Close", async () => {
      const certs: SecretInfo = {
        name: "tls-only",
        namespace: "shop",
        secret_type: "kubernetes.io/tls",
        keys: [
          { key: "tls.crt", size: 1200, binary: false },
          { key: "tls.key", size: 1700, binary: false },
        ],
        helm_release: false,
        resource_version: "3",
        creation_timestamp: null,
      };
      await renderView([apiCredentials(), certs]);
      await fireEvent.click(envButton("tls-only"));
      const d = screen.getByRole("dialog", { name: "Download tls-only as .env" });
      expect(d).toHaveTextContent("No value of tls-only can be written to a .env file.");
      expect(d).toHaveTextContent("2 keys are left out:");
      expect(within(d).getByText("tls.crt (not a variable name), tls.key (not a variable name)")).toBeInTheDocument();
      const buttons = within(d).getAllByRole("button").map((b) => b.textContent?.trim() || b.getAttribute("aria-label"));
      // The header's Close (an icon) and the footer's.
      expect(buttons).toEqual(["Close", "Close"]);
      expect(document.activeElement).toBe(within(d).getAllByRole("button", { name: "Close" })[1]);
      expect(within(d).queryByRole("button", { name: /Choose where to save/ })).toBeNull();
    });
  });
});
