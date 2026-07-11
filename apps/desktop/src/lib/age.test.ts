import { describe, it, expect } from "vitest";
import { formatAge } from "$lib/age";

const now = new Date("2026-07-11T12:00:00Z");

describe("formatAge", () => {
  it("returns a dash for missing or invalid timestamps", () => {
    expect(formatAge(null, now)).toBe("—");
    expect(formatAge("not-a-date", now)).toBe("—");
  });

  it("formats seconds and minutes", () => {
    expect(formatAge("2026-07-11T11:59:30Z", now)).toBe("30s");
    expect(formatAge("2026-07-11T11:15:00Z", now)).toBe("45m");
  });

  it("formats hours with minute detail under 10h", () => {
    expect(formatAge("2026-07-11T09:30:00Z", now)).toBe("2h30m");
    expect(formatAge("2026-07-11T01:00:00Z", now)).toBe("11h");
  });

  it("formats days with hour detail under 10d", () => {
    expect(formatAge("2026-07-08T06:00:00Z", now)).toBe("3d6h");
    expect(formatAge("2026-06-01T12:00:00Z", now)).toBe("40d");
  });

  it("clamps future timestamps to zero", () => {
    expect(formatAge("2026-07-11T12:05:00Z", now)).toBe("0s");
  });
});
