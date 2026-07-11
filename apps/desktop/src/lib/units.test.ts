import { describe, it, expect } from "vitest";
import { formatBytes, formatCpu, percentOf } from "$lib/units";

describe("formatCpu", () => {
  it("renders millicores below one core", () => {
    expect(formatCpu(250)).toBe("250m");
    expect(formatCpu(1.4)).toBe("1m");
  });
  it("renders cores above one core", () => {
    expect(formatCpu(1000)).toBe("1");
    expect(formatCpu(1250)).toBe("1.25");
  });
});

describe("formatBytes", () => {
  it("scales through binary units", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2Ki");
    expect(formatBytes(96 * 1024 * 1024)).toBe("96Mi");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5Gi");
  });
});

describe("percentOf", () => {
  it("computes and caps the percentage", () => {
    expect(percentOf(500, 1000)).toBe(50);
    expect(percentOf(2000, 1000)).toBe(100);
  });
  it("returns null without a denominator", () => {
    expect(percentOf(10, 0)).toBeNull();
  });
});
