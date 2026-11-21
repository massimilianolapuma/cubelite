import { describe, it, expect } from "vitest";
import { keepTogether } from "./keep-together";

describe("keepTogether (#662)", () => {
  it("marks read-only to stay on one line, whatever its case", () => {
    expect(keepTogether("Production clusters are usually read-only")).toEqual([
      { text: "Production clusters are usually ", keep: false },
      { text: "read-only", keep: true },
    ]);
    expect(keepTogether("Read-only from the start")).toEqual([
      { text: "Read-only", keep: true },
      { text: " from the start", keep: false },
    ]);
    expect(keepTogether("It goes back to read-only after 5 minutes or read-only again.")).toEqual([
      { text: "It goes back to ", keep: false },
      { text: "read-only", keep: true },
      { text: " after 5 minutes or ", keep: false },
      { text: "read-only", keep: true },
      { text: " again.", keep: false },
    ]);
  });

  it("leaves any other text whole", () => {
    expect(keepTogether("Pod deleted")).toEqual([{ text: "Pod deleted", keep: false }]);
    expect(keepTogether("")).toEqual([]);
  });

  it("puts the parts back to the same text", () => {
    const text = "aks-prod-01-emm is read-only. Make it writable from the cluster menu.";
    expect(keepTogether(text).map((p) => p.text).join("")).toBe(text);
  });
});
