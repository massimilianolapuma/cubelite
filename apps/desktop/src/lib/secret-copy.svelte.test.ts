import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { COPIED_MS, SecretCopy, copiedText } from "#lib/secret-copy.svelte.ts";
import { app } from "#lib/stores/app.svelte.ts";
import type { ClusterRef } from "#lib/stores/cluster-ref.ts";
import type { ToastTone } from "#lib/stores/toasts.svelte.ts";
import type { CopyFormat } from "#lib/tauri.ts";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PROD: ClusterRef = { kubeconfig: "/home/u/.kube/config", cluster: "prod" };

let copy: ReturnType<
  typeof vi.fn<(ns: string, name: string, key: string, seconds: number, on: ClusterRef) => Promise<CopyFormat>>
>;
let announce: ReturnType<typeof vi.fn<(m: string) => void>>;
let notify: ReturnType<typeof vi.fn<(m: string, tone: ToastTone) => void>>;
let reload: ReturnType<typeof vi.fn<() => void>>;
let clearAfter: number;
let copies: SecretCopy;

beforeEach(() => {
  vi.useFakeTimers();
  app.kubeconfigPath = PROD.kubeconfig;
  app.activeCluster = PROD.cluster;
  app.connecting = null;
  clearAfter = 30;
  copy = vi.fn(async () => "text" as CopyFormat);
  announce = vi.fn();
  notify = vi.fn();
  reload = vi.fn();
  copies = new SecretCopy({ copy, clearAfter: () => clearAfter, announce, notify, reload });
});

afterEach(() => {
  copies.destroy();
  vi.useRealTimers();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("copiedText (#661 §3.6)", () => {
  it("says when the clipboard is cleared, or nothing more with Never", () => {
    expect(copiedText("DB_PASSWORD", 30)).toBe("DB_PASSWORD copied, the clipboard is cleared in 30 seconds");
    expect(copiedText("K", 15)).toBe("K copied, the clipboard is cleared in 15 seconds");
    expect(copiedText("K", 60)).toBe("K copied, the clipboard is cleared in 1 minute");
    expect(copiedText("K", 300)).toBe("K copied, the clipboard is cleared in 5 minutes");
    expect(copiedText("K", 0)).toBe("K copied");
  });
});

describe("SecretCopy (#661 §3.1)", () => {
  it("asks the backend for that key with the time from Preferences, then reads Copied for 2 seconds", async () => {
    const answer = deferred<CopyFormat>();
    copy.mockReturnValueOnce(answer.promise);
    void copies.copy("shop", "api", "DB_PASSWORD");
    expect(copies.entry("shop", "api", "DB_PASSWORD")).toEqual({ status: "copying" });
    expect(copy).toHaveBeenCalledWith("shop", "api", "DB_PASSWORD", 30, PROD);
    answer.resolve("text");
    await flush();
    expect(copies.entry("shop", "api", "DB_PASSWORD")).toEqual({ status: "copied" });
    expect(announce).toHaveBeenLastCalledWith("DB_PASSWORD copied, the clipboard is cleared in 30 seconds");
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(COPIED_MS - 1);
    expect(copies.entry("shop", "api", "DB_PASSWORD")).toEqual({ status: "copied" });
    await vi.advanceTimersByTimeAsync(1);
    expect(copies.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
    expect(COPIED_MS).toBe(2000);
  });

  it("sends Never as 0 and says only copied", async () => {
    clearAfter = 0;
    await copies.copy("shop", "api", "K");
    expect(copy).toHaveBeenCalledWith("shop", "api", "K", 0, PROD);
    expect(announce).toHaveBeenLastCalledWith("K copied");
  });

  it("ignores a second press while the first runs", async () => {
    const answer = deferred<CopyFormat>();
    copy.mockReturnValueOnce(answer.promise);
    void copies.copy("shop", "api", "K");
    void copies.copy("shop", "api", "K");
    expect(copy).toHaveBeenCalledTimes(1);
    answer.resolve("text");
    await flush();
  });

  it("a refusal stays in the row and is announced; a vanished key reloads the list", async () => {
    copy.mockRejectedValueOnce({ kind: "forbidden", message: "secrets is forbidden" });
    await copies.copy("shop", "api", "K");
    expect(copies.entry("shop", "api", "K")).toEqual({
      status: "error",
      error: { kind: "forbidden", message: "secrets is forbidden" },
    });
    expect(announce).toHaveBeenLastCalledWith("K: Not allowed to read this Secret (403)");
    expect(reload).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(copies.entry("shop", "api", "K")?.status).toBe("error");

    copy.mockRejectedValueOnce({ kind: "key_missing", message: "Secret shop/api has no key K" });
    await copies.copy("shop", "api", "K");
    expect(reload).toHaveBeenCalledTimes(1);
    copies.dismiss("shop", "api", "K");
    expect(copies.entry("shop", "api", "K")).toBeUndefined();
  });

  it("an answer after a reset or after leaving is not in a row: a toast tells it", async () => {
    const late = deferred<CopyFormat>();
    copy.mockReturnValueOnce(late.promise);
    void copies.copy("shop", "api", "K");
    copies.reset();
    expect(copies.entry("shop", "api", "K")).toBeUndefined();
    late.resolve("text");
    await flush();
    expect(copies.entry("shop", "api", "K")).toBeUndefined();
    expect(announce).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledExactlyOnceWith("K of api copied, the clipboard is cleared in 30 seconds", "ok");

    notify.mockClear();
    const after = deferred<CopyFormat>();
    copy.mockReturnValueOnce(after.promise);
    void copies.copy("shop", "api", "K");
    copies.destroy();
    after.reject({ kind: "forbidden", message: "secrets is forbidden" });
    await flush();
    expect(copies.entry("shop", "api", "K")).toBeUndefined();
    expect(announce).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledExactlyOnceWith("Could not copy K of api: Not allowed to read this Secret (403)", "err");
    await copies.copy("shop", "api", "K");
    expect(copy).toHaveBeenCalledTimes(2);
  });

  describe("bound to the cluster it was made on (#690)", () => {
    it("copies on the kubeconfig and context active at the click, whatever is active later", async () => {
      const answer = deferred<CopyFormat>();
      copy.mockReturnValueOnce(answer.promise);
      void copies.copy("shop", "api", "K");
      app.kubeconfigPath = "/other/config";
      app.activeCluster = "staging";
      expect(copy).toHaveBeenCalledWith("shop", "api", "K", 30, PROD);
      answer.resolve("text");
      await flush();
    });

    it("copies nothing without an active cluster", async () => {
      app.activeCluster = null;
      await copies.copy("shop", "api", "K");
      expect(copy).not.toHaveBeenCalled();
      expect(copies.snapshot()).toEqual({});
    });

    it("a copy that ends after a switch names its cluster in a toast, not in a row", async () => {
      const answer = deferred<CopyFormat>();
      copy.mockReturnValueOnce(answer.promise);
      void copies.copy("shop", "db-creds", "API_KEY");
      app.connecting = "staging";
      answer.resolve("text");
      await flush();
      expect(copies.snapshot()).toEqual({});
      expect(announce).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        "API_KEY of db-creds copied on prod, the clipboard is cleared in 30 seconds",
        "ok",
      );
    });

    it("a copy that fails after the cluster changed names its cluster and the reason, never a value", async () => {
      const answer = deferred<CopyFormat>();
      copy.mockReturnValueOnce(answer.promise);
      void copies.copy("shop", "db-creds", "API_KEY");
      app.activeCluster = "staging";
      copies.reset();
      answer.reject({ kind: "key_missing", message: "Secret shop/db-creds has no key API_KEY" });
      await flush();
      expect(copies.snapshot()).toEqual({});
      expect(announce).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledExactlyOnceWith("Could not copy API_KEY of db-creds on prod: No longer exists", "err");
    });

    it("dismiss leaves a running copy and a done one in their row: it drops only an error", async () => {
      const answer = deferred<CopyFormat>();
      copy.mockReturnValueOnce(answer.promise);
      void copies.copy("shop", "api", "K");
      // Reveal pressed on the same key while its copy runs.
      copies.dismiss("shop", "api", "K");
      expect(copies.entry("shop", "api", "K")).toEqual({ status: "copying" });
      void copies.copy("shop", "api", "K");
      expect(copy).toHaveBeenCalledTimes(1);
      answer.resolve("text");
      await flush();
      expect(copies.entry("shop", "api", "K")).toEqual({ status: "copied" });
      expect(announce).toHaveBeenLastCalledWith("K copied, the clipboard is cleared in 30 seconds");
      copies.dismiss("shop", "api", "K");
      expect(copies.entry("shop", "api", "K")).toEqual({ status: "copied" });
      expect(notify).not.toHaveBeenCalled();
    });

    it("a second press while the first runs still sends one copy and tells one outcome", async () => {
      const answer = deferred<CopyFormat>();
      copy.mockReturnValueOnce(answer.promise);
      void copies.copy("shop", "api", "K");
      void copies.copy("shop", "api", "K");
      app.activeCluster = "staging";
      copies.reset();
      answer.resolve("text");
      await flush();
      expect(copy).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps no value: the entries hold states only", async () => {
    await copies.copy("shop", "api", "K");
    expect(JSON.stringify(copies.snapshot())).toBe('{"shop/api/K":{"status":"copied"}}');
  });
});
