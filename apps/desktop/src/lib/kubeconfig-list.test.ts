import { describe, it, expect } from "vitest";
import { addPaths, originLabel, removePath, seedIfEmpty } from "#lib/kubeconfig-list.ts";

describe("kubeconfig-list", () => {
  it("addPaths appends new absolute paths, trims, dedupes and keeps order", () => {
    expect(addPaths(["/a"], [" /b ", "/a", "", "/c"])).toEqual(["/a", "/b", "/c"]);
  });
  it("removePath drops only the matching entry", () => {
    expect(removePath(["/a", "/b"], "/a")).toEqual(["/b"]);
    expect(removePath(["/a"], "/zzz")).toEqual(["/a"]);
  });
  it("seedIfEmpty copies the resolved list only when custom is empty", () => {
    expect(seedIfEmpty([], ["/x", "/y"])).toEqual(["/x", "/y"]);
    expect(seedIfEmpty(["/mine"], ["/x"])).toEqual(["/mine"]);
  });
  it("originLabel names every origin", () => {
    expect(originLabel("custom")).toBe("Custom list");
    expect(originLabel("env")).toBe("From KUBECONFIG");
    expect(originLabel("default")).toBe("From ~/.kube");
  });
});
