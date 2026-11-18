import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { COPIED_MS, SecretCopy, copiedText } from "#lib/secret-copy.svelte.ts";
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

let copy: ReturnType<typeof vi.fn<(ns: string, name: string, key: string, seconds: number) => Promise<CopyFormat>>>;
let announce: ReturnType<typeof vi.fn<(m: string) => void>>;
let reload: ReturnType<typeof vi.fn<() => void>>;
let clearAfter: number;
let copies: SecretCopy;

beforeEach(() => {
  vi.useFakeTimers();
  clearAfter = 30;
  copy = vi.fn(async () => "text" as CopyFormat);
  announce = vi.fn();
  reload = vi.fn();
  copies = new SecretCopy({ copy, clearAfter: () => clearAfter, announce, reload });
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
    expect(copy).toHaveBeenCalledWith("shop", "api", "DB_PASSWORD", 30);
    answer.resolve("text");
    await flush();
    expect(copies.entry("shop", "api", "DB_PASSWORD")).toEqual({ status: "copied" });
    expect(announce).toHaveBeenLastCalledWith("DB_PASSWORD copied, the clipboard is cleared in 30 seconds");
    await vi.advanceTimersByTimeAsync(COPIED_MS - 1);
    expect(copies.entry("shop", "api", "DB_PASSWORD")).toEqual({ status: "copied" });
    await vi.advanceTimersByTimeAsync(1);
    expect(copies.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
    expect(COPIED_MS).toBe(2000);
  });

  it("sends Never as 0 and says only copied", async () => {
    clearAfter = 0;
    await copies.copy("shop", "api", "K");
    expect(copy).toHaveBeenCalledWith("shop", "api", "K", 0);
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
    await vi.advanceTimersByTimeAsync(10_000);
    expect(copies.entry("shop", "api", "K")?.status).toBe("error");

    copy.mockRejectedValueOnce({ kind: "key_missing", message: "Secret shop/api has no key K" });
    await copies.copy("shop", "api", "K");
    expect(reload).toHaveBeenCalledTimes(1);
    copies.dismiss("shop", "api", "K");
    expect(copies.entry("shop", "api", "K")).toBeUndefined();
  });

  it("an answer after a reset or after leaving is dropped, unannounced", async () => {
    const late = deferred<CopyFormat>();
    copy.mockReturnValueOnce(late.promise);
    void copies.copy("shop", "api", "K");
    copies.reset();
    expect(copies.entry("shop", "api", "K")).toBeUndefined();
    late.resolve("text");
    await flush();
    expect(copies.entry("shop", "api", "K")).toBeUndefined();
    expect(announce).not.toHaveBeenCalled();

    const after = deferred<CopyFormat>();
    copy.mockReturnValueOnce(after.promise);
    void copies.copy("shop", "api", "K");
    copies.destroy();
    after.reject({ kind: "other", message: "x" });
    await flush();
    expect(copies.entry("shop", "api", "K")).toBeUndefined();
    expect(announce).not.toHaveBeenCalled();
    await copies.copy("shop", "api", "K");
    expect(copy).toHaveBeenCalledTimes(2);
  });

  it("keeps no value: the entries hold states only", async () => {
    await copies.copy("shop", "api", "K");
    expect(JSON.stringify(copies.snapshot())).toBe('{"shop/api/K":{"status":"copied"}}');
  });
});
