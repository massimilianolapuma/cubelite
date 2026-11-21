import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CONFIGMAP_ERRORS } from "#lib/configmap-values.ts";
import { app } from "#lib/stores/app.svelte.ts";
import type { ClusterRef } from "#lib/stores/cluster-ref.ts";
import type { ToastTone } from "#lib/stores/toasts.svelte.ts";
import type { ConfigMapCommandError, CopyFormat } from "#lib/tauri.ts";
import { ValueCopy } from "#lib/value-copy.svelte.ts";

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
let copies: ValueCopy<ConfigMapCommandError>;

beforeEach(() => {
  vi.useFakeTimers();
  app.kubeconfigPath = PROD.kubeconfig;
  app.activeCluster = PROD.cluster;
  app.connecting = null;
  copy = vi.fn(async () => "text" as CopyFormat);
  announce = vi.fn();
  notify = vi.fn();
  // A ConfigMap's copy: no clearing time.
  copies = new ValueCopy({ copy, announce, notify, errors: CONFIGMAP_ERRORS });
});

afterEach(() => {
  copies.destroy();
  vi.useRealTimers();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("ValueCopy without a clearing time (#668, #690)", () => {
  it("copies on the cluster active at the click; a copy still in its row tells nothing in a toast", async () => {
    await copies.copy("shop", "app-config", "LOG_LEVEL");
    expect(copy).toHaveBeenCalledWith("shop", "app-config", "LOG_LEVEL", 0, PROD);
    expect(copies.entry("shop", "app-config", "LOG_LEVEL")).toEqual({ status: "copied" });
    expect(announce).toHaveBeenLastCalledWith("LOG_LEVEL copied");
    expect(notify).not.toHaveBeenCalled();
  });

  it("a copy that ends after a switch names its cluster, and says nothing of clearing", async () => {
    const answer = deferred<CopyFormat>();
    copy.mockReturnValueOnce(answer.promise);
    void copies.copy("shop", "app-config", "LOG_LEVEL");
    app.activeCluster = "staging";
    copies.reset();
    answer.resolve("text");
    await flush();
    expect(copies.snapshot()).toEqual({});
    expect(announce).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledExactlyOnceWith("LOG_LEVEL of app-config copied on prod", "ok");
  });

  it("a copy that fails after the view is left says why, on the cluster on screen without naming it", async () => {
    const answer = deferred<CopyFormat>();
    copy.mockReturnValueOnce(answer.promise);
    void copies.copy("shop", "app-config", "LOG_LEVEL");
    copies.destroy();
    answer.reject({ kind: "forbidden", message: 'configmaps "app-config" is forbidden' });
    await flush();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Could not copy LOG_LEVEL of app-config: Not allowed to read this ConfigMap (403)",
      "err",
    );
  });
});
