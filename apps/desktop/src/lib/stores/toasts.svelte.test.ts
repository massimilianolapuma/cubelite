import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { toasts } from "./toasts.svelte";

beforeEach(() => {
  vi.useFakeTimers();
  toasts.items = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("toasts", () => {
  it("pushes a toast with the given tone", () => {
    toasts.push("Pod restarted", "ok");
    expect(toasts.items).toHaveLength(1);
    expect(toasts.items[0]).toMatchObject({ message: "Pod restarted", tone: "ok" });
  });

  it("auto-dismisses after 3.2s", () => {
    toasts.push("gone soon", "warn");
    vi.advanceTimersByTime(3199);
    expect(toasts.items).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts.items).toHaveLength(0);
  });

  it("caps the queue, dropping the oldest", () => {
    for (let i = 0; i < 6; i++) toasts.push(`t${i}`, "err");
    expect(toasts.items).toHaveLength(4);
    expect(toasts.items[0].message).toBe("t2");
  });

  it("dismiss removes a specific toast", () => {
    const id = toasts.push("a", "ok");
    toasts.push("b", "ok");
    toasts.dismiss(id);
    expect(toasts.items.map((t) => t.message)).toEqual(["b"]);
  });
});
