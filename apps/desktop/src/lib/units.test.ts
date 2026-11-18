import { describe, it, expect } from "vitest";
import { formatBytes, formatCpu, formatSize, percentOf } from "#lib/units.ts";

describe("formatCpu", () => {
  it("renders millicores below one core", () => {
    expect(formatCpu(250)).toBe("250m");
    expect(formatCpu(1.4)).toBe("1m");
  });
  it("renders cores above one core", () => {
    expect(formatCpu(1000)).toBe("1");
    expect(formatCpu(1250)).toBe("1.25");
  });
  it("decides the unit and the decimals on the value it shows", () => {
    // 999.6m rounds to a whole core: "1", never "1000m".
    expect(formatCpu(999.6)).toBe("1");
    expect(formatCpu(999.4)).toBe("999m");
    // 15999.7m is 16 cores at two decimals: "16", not "16.00".
    expect(formatCpu(15999.7)).toBe("16");
    expect(formatCpu(1500)).toBe("1.50");
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

describe("formatSize (#661)", () => {
  it("writes bytes, then KiB and MiB with one decimal", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(12)).toBe("12 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1 KiB");
    expect(formatSize(1843)).toBe("1.8 KiB");
    expect(formatSize(49357)).toBe("48.2 KiB");
    expect(formatSize(5 * 1024 * 1024 + 300 * 1024)).toBe("5.3 MiB");
  });
});
