import { describe, it, expect } from "vitest";
import { choiceOf, environmentChoices, settingOf } from "#lib/environment.ts";

describe("environment choices (#662)", () => {
  it("checks detection, a value set by hand, or Not set", () => {
    expect(choiceOf(undefined)).toBe("detected");
    expect(choiceOf({ name: "a", environment: "production", source: "detected", detected: "production" })).toBe(
      "detected",
    );
    expect(choiceOf({ name: "a", environment: "test", source: "manual", detected: "production" })).toBe("test");
    expect(choiceOf({ name: "a", environment: null, source: "manual", detected: "production" })).toBe("none");
  });

  it("sends the setting the backend reads", () => {
    expect(settingOf("detected")).toEqual({ source: "detected" });
    expect(settingOf("staging")).toEqual({ source: "manual", value: "staging" });
    expect(settingOf("none")).toEqual({ source: "manual", value: null });
  });

  it("lists the six choices, detection naming what it reads", () => {
    expect(environmentChoices("production").map((c) => c.label)).toEqual([
      "Detect from name (Production)",
      "Development",
      "Test",
      "Staging",
      "Production",
      "Not set",
    ]);
    expect(environmentChoices(null)[0]).toEqual({ value: "detected", label: "Detect from name (Not set)" });
  });
});
