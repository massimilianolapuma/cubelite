import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecretReveal, errorText, secretCommandError } from "#lib/secret-reveal.svelte.ts";
import type { RevealedSecretValue, SecretInfo } from "#lib/tauri.ts";

/** A promise the test settles when it wants. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const secret = (rv: string | null, keys = ["DB_PASSWORD", "DB_USER"]): SecretInfo => ({
  name: "api",
  namespace: "shop",
  secret_type: "Opaque",
  keys: keys.map((key) => ({ key, size: 8, binary: false })),
  helm_release: false,
  resource_version: rv,
  creation_timestamp: null,
});

let read: ReturnType<typeof vi.fn<(ns: string, name: string, key: string) => Promise<RevealedSecretValue>>>;
let announce: ReturnType<typeof vi.fn<(m: string) => void>>;
let reload: ReturnType<typeof vi.fn<() => void>>;
let hideAfter: number;
let reveal: SecretReveal;

beforeEach(() => {
  vi.useFakeTimers();
  hideAfter = 30;
  read = vi.fn(async (_ns: string, _name: string, key: string) => ({ value: `value-of-${key}`, resource_version: "41" }));
  announce = vi.fn();
  reload = vi.fn();
  reveal = new SecretReveal({ read, hideAfter: () => hideAfter, announce, reload });
});

afterEach(() => {
  reveal.destroy();
  vi.useRealTimers();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("SecretReveal (#661 §3.2)", () => {
  it("reads one value, for that key only, and shows it", async () => {
    const answer = deferred<RevealedSecretValue>();
    read.mockReturnValueOnce(answer.promise);
    void reveal.reveal("shop", "api", "DB_PASSWORD");
    expect(reveal.entry("shop", "api", "DB_PASSWORD")).toEqual({ status: "reading" });
    answer.resolve({ value: "s3cr3t", resource_version: "41" });
    await flush();
    expect(reveal.entry("shop", "api", "DB_PASSWORD")).toEqual({ status: "shown", value: "s3cr3t", resourceVersion: "41" });
    expect(reveal.entry("shop", "api", "DB_USER")).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("shop", "api", "DB_PASSWORD");
    expect(announce).toHaveBeenLastCalledWith("DB_PASSWORD shown");
  });

  it("hides the value when its timer ends, counted from the reveal", async () => {
    await reveal.reveal("shop", "api", "DB_PASSWORD");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(reveal.entry("shop", "api", "DB_PASSWORD")?.status).toBe("shown");
    await vi.advanceTimersByTimeAsync(1);
    expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
    expect(announce).toHaveBeenLastCalledWith("DB_PASSWORD hidden");
  });

  it("keeps a value shown with Never until another cause hides it", async () => {
    hideAfter = 0;
    await reveal.reveal("shop", "api", "DB_PASSWORD");
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(reveal.entry("shop", "api", "DB_PASSWORD")?.status).toBe("shown");
    reveal.hide("shop", "api", "DB_PASSWORD");
    expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
  });

  it("gives each shown key a timer of its own", async () => {
    await reveal.reveal("shop", "api", "DB_PASSWORD");
    await vi.advanceTimersByTimeAsync(10_000);
    await reveal.reveal("shop", "api", "DB_USER");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
    expect(reveal.entry("shop", "api", "DB_USER")?.status).toBe("shown");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reveal.entry("shop", "api", "DB_USER")).toBeUndefined();
  });

  it("Hide drops the value and its timer", async () => {
    await reveal.reveal("shop", "api", "DB_PASSWORD");
    reveal.hide("shop", "api", "DB_PASSWORD");
    expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
    expect(announce).toHaveBeenLastCalledWith("DB_PASSWORD hidden");
    announce.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(announce).not.toHaveBeenCalled();
  });

  it("toggle reveals a hidden key and hides a shown one", async () => {
    await reveal.toggle("shop", "api", "DB_PASSWORD");
    expect(reveal.entry("shop", "api", "DB_PASSWORD")?.status).toBe("shown");
    await reveal.toggle("shop", "api", "DB_PASSWORD");
    expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  });

  describe("an answer that arrives after its cause is gone is thrown away", () => {
    for (const [cause, act] of [
      ["Hide", (r: SecretReveal) => r.hide("shop", "api", "DB_PASSWORD")],
      ["leaving the view", (r: SecretReveal) => r.destroy()],
      ["a namespace or cluster change", (r: SecretReveal) => r.reset()],
    ] as const) {
      it(`after ${cause}`, async () => {
        const answer = deferred<RevealedSecretValue>();
        read.mockReturnValueOnce(answer.promise);
        void reveal.reveal("shop", "api", "DB_PASSWORD");
        act(reveal);
        answer.resolve({ value: "late-value", resource_version: "41" });
        await flush();
        expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
        expect(JSON.stringify(reveal.snapshot())).not.toContain("late-value");
        expect(announce).not.toHaveBeenCalledWith("DB_PASSWORD shown");
      });
    }

    it("and so is a late failure", async () => {
      const answer = deferred<RevealedSecretValue>();
      read.mockReturnValueOnce(answer.promise);
      void reveal.reveal("shop", "api", "DB_PASSWORD");
      reveal.reset();
      answer.reject({ kind: "key_missing", message: "gone" });
      await flush();
      expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
      expect(reload).not.toHaveBeenCalled();
    });
  });

  it("drops every shown value on a namespace or cluster change, and on leaving", async () => {
    await reveal.reveal("shop", "api", "DB_PASSWORD");
    await reveal.reveal("shop", "api", "DB_USER");
    reveal.reset();
    expect(reveal.snapshot()).toEqual({});
    await reveal.reveal("shop", "api", "DB_PASSWORD");
    reveal.destroy();
    expect(reveal.snapshot()).toEqual({});
  });

  describe("a reload of the list", () => {
    it("that finds the Secret unchanged keeps the value, its timer running", async () => {
      await reveal.reveal("shop", "api", "DB_PASSWORD");
      await vi.advanceTimersByTimeAsync(20_000);
      reveal.reconcile([secret("41")]);
      expect(reveal.entry("shop", "api", "DB_PASSWORD")?.status).toBe("shown");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
    });

    it("that shows another resource version drops the value", async () => {
      await reveal.reveal("shop", "api", "DB_PASSWORD");
      reveal.reconcile([secret("42")]);
      expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
      expect(announce).toHaveBeenLastCalledWith("DB_PASSWORD hidden");
    });

    it("without the key, or without the Secret, drops the value", async () => {
      await reveal.reveal("shop", "api", "DB_PASSWORD");
      await reveal.reveal("shop", "api", "DB_USER");
      reveal.reconcile([secret("41", ["DB_USER"])]);
      expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
      expect(reveal.entry("shop", "api", "DB_USER")?.status).toBe("shown");
      reveal.reconcile([]);
      expect(reveal.snapshot()).toEqual({});
    });

    it("leaves a read in flight alone while its Secret and key are there", async () => {
      const answer = deferred<RevealedSecretValue>();
      read.mockReturnValueOnce(answer.promise);
      void reveal.reveal("shop", "api", "DB_PASSWORD");
      reveal.reconcile([secret("41")]);
      answer.resolve({ value: "v", resource_version: "41" });
      await flush();
      expect(reveal.entry("shop", "api", "DB_PASSWORD")?.status).toBe("shown");
    });
  });

  describe("an answer read at another version than the list's", () => {
    it("is not shown; the list reloads, and a reload that does not match drops it", async () => {
      reveal.reconcile([secret("42")]);
      const answer = deferred<RevealedSecretValue>();
      read.mockReturnValueOnce(answer.promise);
      void reveal.reveal("shop", "api", "DB_PASSWORD");
      answer.resolve({ value: "old-value", resource_version: "41" });
      await flush();
      expect(reveal.entry("shop", "api", "DB_PASSWORD")?.status).toBe("reading");
      expect(JSON.stringify(reveal.snapshot())).not.toContain("old-value");
      expect(reload).toHaveBeenCalledTimes(1);
      reveal.reconcile([secret("42")]);
      expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
      expect(announce).not.toHaveBeenCalledWith("DB_PASSWORD shown");
    });

    it("is dropped if the list does not reload", async () => {
      reveal.reconcile([secret("42")]);
      read.mockResolvedValueOnce({ value: "old-value", resource_version: "41" });
      await reveal.reveal("shop", "api", "DB_PASSWORD");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
    });

    it("is shown once the reloaded list is at its version", async () => {
      reveal.reconcile([secret("40")]);
      read.mockResolvedValueOnce({ value: "new-value", resource_version: "41" });
      await reveal.reveal("shop", "api", "DB_PASSWORD");
      expect(reveal.entry("shop", "api", "DB_PASSWORD")?.status).toBe("reading");
      reveal.reconcile([secret("41")]);
      expect(reveal.entry("shop", "api", "DB_PASSWORD")).toEqual({ status: "shown", value: "new-value", resourceVersion: "41" });
      expect(announce).toHaveBeenLastCalledWith("DB_PASSWORD shown");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
    });
  });

  describe("the time, changed or slept through", () => {
    it("a new time in Preferences re-arms each timer from when its value was shown", async () => {
      await reveal.reveal("shop", "api", "DB_PASSWORD");
      await vi.advanceTimersByTimeAsync(10_000);
      await reveal.reveal("shop", "api", "DB_USER");
      await vi.advanceTimersByTimeAsync(10_000);
      // 20 s and 10 s shown: at 15 s the first is past, the second has 5 s left.
      hideAfter = 15;
      reveal.recheck();
      expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
      expect(reveal.entry("shop", "api", "DB_USER")?.status).toBe("shown");
      await vi.advanceTimersByTimeAsync(4_999);
      expect(reveal.entry("shop", "api", "DB_USER")?.status).toBe("shown");
      await vi.advanceTimersByTimeAsync(1);
      expect(reveal.entry("shop", "api", "DB_USER")).toBeUndefined();
    });

    it("Never cancels the timers; a time set again counts from the reveal", async () => {
      await reveal.reveal("shop", "api", "DB_PASSWORD");
      hideAfter = 0;
      reveal.recheck();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(reveal.entry("shop", "api", "DB_PASSWORD")?.status).toBe("shown");
      hideAfter = 300;
      reveal.recheck();
      expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
    });

    it("after a sleep the clock decides, not the timer", async () => {
      await reveal.reveal("shop", "api", "DB_PASSWORD");
      // The machine slept: the wall clock moved, no timer ran.
      vi.setSystemTime(Date.now() + 31_000);
      expect(reveal.entry("shop", "api", "DB_PASSWORD")?.status).toBe("shown");
      reveal.recheck();
      expect(reveal.entry("shop", "api", "DB_PASSWORD")).toBeUndefined();
      expect(announce).toHaveBeenLastCalledWith("DB_PASSWORD hidden");
    });
  });

  describe("errors, in the row (§3.5)", () => {
    it("a 403 says it is not allowed, and Reveal can be pressed again", async () => {
      read.mockRejectedValueOnce({ kind: "forbidden", message: 'secrets "api" is forbidden' });
      await reveal.reveal("shop", "api", "DB_PASSWORD");
      const entry = reveal.entry("shop", "api", "DB_PASSWORD");
      expect(entry).toEqual({ status: "error", error: { kind: "forbidden", message: 'secrets "api" is forbidden' } });
      expect(errorText({ kind: "forbidden", message: "x" })).toBe("Not allowed to read this Secret (403)");
      expect(announce).toHaveBeenLastCalledWith("DB_PASSWORD: Not allowed to read this Secret (403)");
      await reveal.reveal("shop", "api", "DB_PASSWORD");
      expect(reveal.entry("shop", "api", "DB_PASSWORD")?.status).toBe("shown");
    });

    it("a vanished key or Secret says so and reloads the list", async () => {
      for (const kind of ["key_missing", "secret_missing"] as const) {
        reload.mockClear();
        read.mockRejectedValueOnce({ kind, message: "m" });
        await reveal.reveal("shop", "api", "DB_PASSWORD");
        expect(errorText({ kind, message: "m" })).toBe("No longer exists");
        expect(reload).toHaveBeenCalledTimes(1);
      }
    });

    it("anything else shows the API error's message", async () => {
      read.mockRejectedValueOnce(new Error("connection refused"));
      await reveal.reveal("shop", "api", "DB_PASSWORD");
      expect(reveal.entry("shop", "api", "DB_PASSWORD")).toEqual({
        status: "error",
        error: { kind: "other", message: "connection refused" },
      });
      expect(errorText({ kind: "other", message: "connection refused" })).toBe("connection refused");
    });
  });
});

describe("secretCommandError", () => {
  it("keeps the backend's object and reads anything else as other", () => {
    expect(secretCommandError({ kind: "binary", message: "m" })).toEqual({ kind: "binary", message: "m" });
    expect(secretCommandError({ kind: "nope", message: "m" }).kind).toBe("other");
    expect(secretCommandError("plain")).toEqual({ kind: "other", message: "plain" });
    expect(secretCommandError(new Error("e"))).toEqual({ kind: "other", message: "e" });
  });
});
