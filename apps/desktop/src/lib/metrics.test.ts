import { describe, it, expect } from "vitest";
import {
  formatValue,
  latest,
  latestTotal,
  linePath,
  maxValue,
  nearestIndex,
  niceMax,
  seriesStyle,
  sumPoints,
} from "./metrics";
import { bindingOf, saveCredentials, urlProblem } from "./integration";
import type { Point } from "./tauri";

describe("metrics helpers (#510)", () => {
  it("draws lines with gaps for missing values", () => {
    const box = { start: 0, end: 100, yMax: 10, width: 100, height: 10 };
    const points: Point[] = [
      [0, 0],
      [50, 5],
      [60, null],
      [100, 10],
    ];
    expect(linePath(points, box)).toBe("M0.0,10.0L50.0,5.0M100.0,0.0");
    expect(linePath([[0, 20]], box)).toBe("M0.0,0.0");
  });

  it("rounds axis maxima and reads the latest values", () => {
    expect([niceMax(0), niceMax(0.42), niceMax(3), niceMax(7), niceMax(1500)]).toEqual([1, 0.5, 5, 10, 2000]);
    expect(latest([[1, 2], [2, null]])).toBe(2);
    expect(latest([])).toBeNull();
    expect(latestTotal([{ label: "a", points: [[1, 1]] }, { label: "b", points: [[1, 2]] }])).toBe(3);
    expect(latestTotal([])).toBeNull();
    expect(maxValue([{ label: "", points: [[1, 3], [2, null], [3, 7]] }])).toBe(7);
  });

  it("sums series point-wise for deployment sparklines", () => {
    expect(
      sumPoints([
        [[1, 1], [2, 2]],
        [[2, 3], [3, null]],
      ]),
    ).toEqual([
      [1, 1],
      [2, 5],
    ]);
  });

  it("formats units and finds the nearest point", () => {
    expect(formatValue(0.25, "cores")).toBe("250m");
    expect(formatValue(1.5, "cores")).toBe("1.50");
    expect(formatValue(1024 * 1024, "bytes")).toBe("1Mi");
    expect(formatValue(2048, "bytes-per-second")).toBe("2Ki/s");
    expect(formatValue(2.6, "count")).toBe("3");
    expect(nearestIndex([[0, 1], [10, 1], [20, 1]], 14)).toBe(1);
    expect(nearestIndex([], 1)).toBe(-1);
  });
});

describe("integration helpers", () => {
  const ext = (url: string) => ({ target: { kind: "external" as const, url }, skipTlsVerify: false });

  it("refuses credentials in URLs and binds to the origin", () => {
    expect(urlProblem("https://u:p@x.example")).toMatch(/Remove the credentials/);
    expect(urlProblem("ftp://x")).toMatch(/http/);
    expect(urlProblem("")).toBeNull();
    expect(bindingOf(ext("https://a.example/x").target, false)).toBe("https://a.example|false");
  });

  it("saves typed credentials, deletes when off and refuses a moved endpoint", async () => {
    const saved: [string, string][] = [];
    const save = async (e: { target: { kind: string; url?: string } }, a: string) => {
      saved.push([e.target.url ?? "", a]);
    };
    expect(
      await saveCredentials({ saved: null, endpoint: ext("https://a"), typed: "key", storedMethod: null, none: "none", save }),
    ).toBeNull();
    expect(
      await saveCredentials({ saved: ext("https://a"), endpoint: null, typed: null, storedMethod: "bearer", none: "none", save }),
    ).toBeNull();
    const refused = await saveCredentials({
      saved: ext("https://a"),
      endpoint: ext("https://b"),
      typed: null,
      storedMethod: "bearer",
      none: "none",
      save,
    });
    expect(refused?.ok).toBe(false);
    expect(saved).toEqual([
      ["https://a", "key"],
      ["https://a", "none"],
    ]);
  });
});

describe("seriesStyle (Tonal §8.4)", () => {
  it("draws the first five series in the five data colours, solid", () => {
    expect([0, 1, 2, 3, 4].map((i) => seriesStyle(i))).toEqual(
      [1, 2, 3, 4, 5].map((n) => ({ color: `var(--color-data-${n})` })),
    );
  });

  it("past five, repeats the colours dashed, so two lines never look the same", () => {
    expect(seriesStyle(5)).toEqual({ color: "var(--color-data-1)", dash: "6 3" });
    expect(seriesStyle(9)).toEqual({ color: "var(--color-data-5)", dash: "6 3" });
  });
});
