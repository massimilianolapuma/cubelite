import { describe, it, expect } from "vitest";
import { parsePort, resolveLocalPort } from "./ports";

describe("parsePort", () => {
  it("parses valid ports and trims whitespace", () => {
    expect(parsePort("6789")).toBe(6789);
    expect(parsePort(" 80 ")).toBe(80);
  });

  it("enforces the 1-65535 range", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parsePort("")).toBeNull();
    expect(parsePort("http")).toBeNull();
    expect(parsePort("6.789")).toBeNull();
    expect(parsePort("-80")).toBeNull();
  });
});

describe("resolveLocalPort", () => {
  it("empty mirrors the remote port", () => {
    expect(resolveLocalPort("", 6789)).toBe(6789);
    expect(resolveLocalPort("  ", 80)).toBe(80);
  });

  it("'auto' and '0' request OS assignment", () => {
    expect(resolveLocalPort("auto", 80)).toBe(0);
    expect(resolveLocalPort("0", 80)).toBe(0);
  });

  it("explicit valid port wins; invalid is null", () => {
    expect(resolveLocalPort("9000", 80)).toBe(9000);
    expect(resolveLocalPort("abc", 80)).toBeNull();
    expect(resolveLocalPort("70000", 80)).toBeNull();
  });
});
