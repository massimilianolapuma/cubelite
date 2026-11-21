import { describe, it, expect } from "vitest";
import { UNLOCK_CHOICES, remainingText } from "./access";

describe("unlock choices (#662)", () => {
  it("offers 5 minutes, 15 minutes, 1 hour and Always, in that order", () => {
    expect(UNLOCK_CHOICES).toEqual([
      { value: 5, label: "5 minutes" },
      { value: 15, label: "15 minutes" },
      { value: 60, label: "1 hour" },
      { value: "always", label: "Always" },
    ]);
  });
});

describe("remainingText (#662)", () => {
  it("counts whole minutes, rounded up, then the last minute in seconds", () => {
    expect(remainingText(5 * 60_000)).toBe("5 min");
    expect(remainingText(5 * 60_000 - 20)).toBe("5 min");
    expect(remainingText(12 * 60_000)).toBe("12 min");
    expect(remainingText(61_000)).toBe("2 min");
    expect(remainingText(60_000)).toBe("1 min");
    expect(remainingText(59_001)).toBe("1 min");
    expect(remainingText(59_000)).toBe("59 s");
    expect(remainingText(42_000)).toBe("42 s");
    expect(remainingText(1)).toBe("1 s");
  });

  it("never counts below a second", () => {
    expect(remainingText(0)).toBe("0 s");
    expect(remainingText(-500)).toBe("0 s");
  });
});
