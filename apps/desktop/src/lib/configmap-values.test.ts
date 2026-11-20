import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CONFIGMAP_ERRORS, configMapCommandError, configMapErrorText } from "#lib/configmap-values.ts";
import { ValueCopy } from "#lib/value-copy.svelte.ts";
import { ValueReveal } from "#lib/value-reveal.svelte.ts";
import type { ConfigMapCommandError, ConfigMapInfo, RevealedSecretValue } from "#lib/tauri.ts";

const configmap = (rv: string | null, keys = ["LOG_LEVEL", "application.yaml"]): ConfigMapInfo => ({
  name: "app-config",
  namespace: "shop",
  keys: keys.map((key) => ({ key, size: 8, binary: false })),
  resource_version: rv,
  creation_timestamp: null,
});

describe("configMapCommandError (#668 §6.3)", () => {
  it("keeps the backend's object for each kind it knows", () => {
    for (const kind of ["forbidden", "configmap_missing", "key_missing", "binary", "too_large", "other"] as const) {
      expect(configMapCommandError({ kind, message: "m" })).toEqual({ kind, message: "m" });
    }
  });

  it("reads anything else as other, with its message", () => {
    // A Secret's kind is not a ConfigMap's.
    expect(configMapCommandError({ kind: "secret_missing", message: "m" })).toEqual({
      kind: "other",
      message: '{"kind":"secret_missing","message":"m"}',
    });
    expect(configMapCommandError(new Error("connection refused"))).toEqual({ kind: "other", message: "connection refused" });
    expect(configMapCommandError("plain")).toEqual({ kind: "other", message: "plain" });
  });
});

describe("configMapErrorText (#668 §3.3)", () => {
  it("says a 403 is not allowed, a vanished ConfigMap or key no longer exists, else the API's message", () => {
    const text = (kind: ConfigMapCommandError["kind"], message = "the API's words") => configMapErrorText({ kind, message });
    expect(text("forbidden")).toBe("Not allowed to read this ConfigMap (403)");
    expect(text("configmap_missing")).toBe("No longer exists");
    expect(text("key_missing")).toBe("No longer exists");
    expect(text("other", "connection refused")).toBe("connection refused");
    expect(text("too_large", "big.json of ConfigMap shop/app-config: a value over 64 KiB is not shown")).toBe(
      "big.json of ConfigMap shop/app-config: a value over 64 KiB is not shown",
    );
  });

  it("asks for a reload when the ConfigMap or the key is gone, and only then", () => {
    expect(CONFIGMAP_ERRORS.gone({ kind: "configmap_missing", message: "" })).toBe(true);
    expect(CONFIGMAP_ERRORS.gone({ kind: "key_missing", message: "" })).toBe(true);
    expect(CONFIGMAP_ERRORS.gone({ kind: "forbidden", message: "" })).toBe(false);
  });
});

describe("ValueReveal without a timer, for ConfigMaps (#668 §3.2)", () => {
  let read: ReturnType<typeof vi.fn<(ns: string, name: string, key: string) => Promise<RevealedSecretValue>>>;
  let announce: ReturnType<typeof vi.fn<(m: string) => void>>;
  let reload: ReturnType<typeof vi.fn<() => void>>;
  let reveal: ValueReveal<ConfigMapCommandError>;

  beforeEach(() => {
    vi.useFakeTimers();
    read = vi.fn(async (_ns: string, _name: string, key: string) => ({ value: `value-of-${key}`, resource_version: "77" }));
    announce = vi.fn();
    reload = vi.fn();
    reveal = new ValueReveal({ read, announce, reload, errors: CONFIGMAP_ERRORS });
  });

  afterEach(() => {
    reveal.destroy();
    vi.useRealTimers();
  });

  it("keeps a shown value until another cause hides it: no timer", async () => {
    await reveal.reveal("shop", "app-config", "LOG_LEVEL");
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    reveal.recheck();
    expect(reveal.entry("shop", "app-config", "LOG_LEVEL")).toEqual({
      status: "shown",
      value: "value-of-LOG_LEVEL",
      resourceVersion: "77",
    });
    expect(announce).toHaveBeenLastCalledWith("LOG_LEVEL shown");
    reveal.hide("shop", "app-config", "LOG_LEVEL");
    expect(reveal.entry("shop", "app-config", "LOG_LEVEL")).toBeUndefined();
    expect(announce).toHaveBeenLastCalledWith("LOG_LEVEL hidden");
  });

  it("drops a value when the ConfigMap changes or the key goes, and keeps it on an unchanged reload", async () => {
    reveal.reconcile([configmap("77")]);
    await reveal.reveal("shop", "app-config", "LOG_LEVEL");
    reveal.reconcile([configmap("77")]);
    expect(reveal.entry("shop", "app-config", "LOG_LEVEL")?.status).toBe("shown");
    reveal.reconcile([configmap("78")]);
    expect(reveal.entry("shop", "app-config", "LOG_LEVEL")).toBeUndefined();

    read.mockResolvedValueOnce({ value: "v", resource_version: "78" });
    await reveal.reveal("shop", "app-config", "application.yaml");
    reveal.reconcile([configmap("78", ["LOG_LEVEL"])]);
    expect(reveal.entry("shop", "app-config", "application.yaml")).toBeUndefined();
  });

  it("reads a ConfigMap error: the row's words, and a reload when it is gone", async () => {
    read.mockRejectedValueOnce({ kind: "forbidden", message: 'configmaps "app-config" is forbidden' });
    await reveal.reveal("shop", "app-config", "LOG_LEVEL");
    expect(reveal.entry("shop", "app-config", "LOG_LEVEL")).toEqual({
      status: "error",
      error: { kind: "forbidden", message: 'configmaps "app-config" is forbidden' },
    });
    expect(announce).toHaveBeenLastCalledWith("LOG_LEVEL: Not allowed to read this ConfigMap (403)");
    expect(reload).not.toHaveBeenCalled();

    read.mockRejectedValueOnce({ kind: "configmap_missing", message: "ConfigMap shop/app-config no longer exists" });
    await reveal.reveal("shop", "app-config", "LOG_LEVEL");
    expect(announce).toHaveBeenLastCalledWith("LOG_LEVEL: No longer exists");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("ValueCopy without a clearing time, for ConfigMaps (#668 §3.1)", () => {
  it("says only copied, sends no time, and reads ConfigMap errors", async () => {
    vi.useFakeTimers();
    const copy = vi.fn(async () => "text" as const);
    const announce = vi.fn();
    const reload = vi.fn();
    const copies = new ValueCopy({ copy, announce, reload, errors: CONFIGMAP_ERRORS });
    await copies.copy("shop", "app-config", "application.yaml");
    expect(copy).toHaveBeenCalledWith("shop", "app-config", "application.yaml", 0);
    expect(copies.entry("shop", "app-config", "application.yaml")).toEqual({ status: "copied" });
    expect(announce).toHaveBeenLastCalledWith("application.yaml copied");
    await vi.advanceTimersByTimeAsync(2000);
    expect(copies.entry("shop", "app-config", "application.yaml")).toBeUndefined();

    copy.mockRejectedValueOnce({ kind: "key_missing", message: "ConfigMap shop/app-config has no key K" });
    await copies.copy("shop", "app-config", "K");
    expect(announce).toHaveBeenLastCalledWith("K: No longer exists");
    expect(reload).toHaveBeenCalledTimes(1);
    copies.destroy();
    vi.useRealTimers();
  });
});
