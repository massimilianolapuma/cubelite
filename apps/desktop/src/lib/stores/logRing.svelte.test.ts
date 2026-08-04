import { describe, expect, it } from "vitest";
import { LogRing } from "./logRing.svelte";
import type { LogLine } from "$lib/tauri";

function line(message: string): LogLine {
  return { pod: "api-0", namespace: "default", time: "2026-08-04T10:00:00Z", level: "info", message };
}

describe("LogRing", () => {
  it("appends batches with stable increasing ids", () => {
    const ring = new LogRing(10);
    ring.append([line("a"), line("b")]);
    ring.append([line("c")]);
    expect(ring.lines.map((l) => l.message)).toEqual(["a", "b", "c"]);
    expect(ring.lines.map((l) => l.id)).toEqual([0, 1, 2]);
    expect(ring.totalAppended).toBe(3);
  });

  it("evicts oldest lines beyond cap but totalAppended keeps counting", () => {
    const ring = new LogRing(3);
    ring.append([line("a"), line("b"), line("c"), line("d"), line("e")]);
    expect(ring.lines.map((l) => l.message)).toEqual(["c", "d", "e"]);
    expect(ring.totalAppended).toBe(5);
  });

  it("clear empties lines without resetting id sequence", () => {
    const ring = new LogRing(3);
    ring.append([line("a")]);
    ring.clear();
    ring.append([line("b")]);
    expect(ring.lines).toHaveLength(1);
    expect(ring.lines[0].id).toBe(1);
  });
});
