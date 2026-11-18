import { describe, it, expect } from "vitest";
import { envPlan, isEnvName, leftOutText, savedText } from "#lib/secret-env.ts";

const key = (k: string, binary = false) => ({ key: k, size: 4, binary });

describe("isEnvName (#661)", () => {
  it("is [A-Za-z_][A-Za-z0-9_]*, as the backend's rule", () => {
    for (const good of ["A", "_", "_a1", "API_KEY", "a"]) expect(isEnvName(good), good).toBe(true);
    for (const bad of ["", "1A", "A-B", "a.b", "é", "A B", "A=B", ".dockerconfigjson"]) {
      expect(isEnvName(bad), bad).toBe(false);
    }
  });
});

describe("envPlan (#661 §3.3)", () => {
  it("counts the keys written and lists those left out with their reason, from the list alone", () => {
    const plan = envPlan([key("API_KEY"), key("ca.crt", true), key("DB_PASSWORD"), key("tls.crt"), key("BLOB", true)]);
    expect(plan.written).toEqual(["API_KEY", "DB_PASSWORD"]);
    // A binary value is binary before its name is checked, as in the backend.
    expect(plan.leftOut).toEqual([
      { key: "ca.crt", reason: "binary" },
      { key: "tls.crt", reason: "not_a_name" },
      { key: "BLOB", reason: "binary" },
    ]);
  });

  it("writes an empty value (KEY=)", () => {
    expect(envPlan([{ key: "EMPTY", size: 0, binary: false }]).written).toEqual(["EMPTY"]);
  });
});

describe("words (#661)", () => {
  it("says each reason", () => {
    expect(leftOutText({ key: "ca.crt", reason: "binary" })).toBe("ca.crt (binary)");
    expect(leftOutText({ key: "tls.crt", reason: "not_a_name" })).toBe("tls.crt (not a variable name)");
    expect(leftOutText({ key: "K", reason: "nul" })).toBe("K (holds a NUL character)");
  });

  it("names the count, the Secret and the path, never a value", () => {
    expect(savedText("api-credentials", 3, "/home/u/api-credentials.env")).toBe(
      "3 values of api-credentials saved to /home/u/api-credentials.env",
    );
    expect(savedText("api-credentials", 1, "/x.env")).toBe("1 value of api-credentials saved to /x.env");
  });
});
