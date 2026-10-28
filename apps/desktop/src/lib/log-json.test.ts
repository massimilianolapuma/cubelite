import { describe, it, expect } from "vitest";
import { parseJsonLine, mapLevel, compactValue, prettyJson } from "#lib/log-json.ts";

describe("parseJsonLine detection", () => {
  it("returns a view for a JSON object line", () => {
    const v = parseJsonLine('{"level":"info","msg":"order accepted","orderId":"A-1931"}');
    expect(v).not.toBeNull();
    expect(v?.message).toBe("order accepted");
  });
  it("returns null for arrays, primitives, text prefixes, trailing text and invalid JSON", () => {
    expect(parseJsonLine('[{"a":1}]')).toBeNull();
    expect(parseJsonLine("42")).toBeNull();
    expect(parseJsonLine('app[1]: {"a":1}')).toBeNull();
    expect(parseJsonLine('{"a":1} tail')).toBeNull();
    expect(parseJsonLine('{"a":')).toBeNull();
    expect(parseJsonLine("plain text line")).toBeNull();
  });
  it("parses with surrounding whitespace and CRLF", () => {
    expect(parseJsonLine('\uFEFF  {"msg":"x"}\r')?.message).toBe("x");
  });
});

describe("parseJsonLine fields", () => {
  it("picks time/level/message by precedence, case-insensitively, and drops them from the tail", () => {
    // candidate order decides, not key order: time beats TS, level beats Severity, message beats msg
    const v = parseJsonLine(
      '{"TS":"1","time":"2","Severity":"warn","level":"info","msg":"m","message":"n","k":1}',
    );
    expect(v?.time).toBe("2");
    expect(v?.level).toBe("info");
    expect(v?.message).toBe("n");
    expect(v?.tail.map((t) => t.key)).toEqual(["TS", "Severity", "msg", "k"]);
  });
  it("reads the nested ECS log.level and keeps the log object in the tail", () => {
    const v = parseJsonLine('{"log":{"level":"ERROR","logger":"x"},"message":"boom"}');
    expect(v?.level).toBe("error");
    expect(v?.tail).toEqual([{ key: "log", value: '{"level":"ERROR","logger":"x"}' }]);
  });
  it("accepts a literal log.level key", () => {
    expect(parseJsonLine('{"log.level":"warning","msg":"x"}')?.level).toBe("warn");
  });
  it("falls back to the first string field, then to the compact JSON, for the message", () => {
    expect(parseJsonLine('{"n":1,"name":"svc","b":true}')?.message).toBe("svc");
    expect(parseJsonLine('{"n":1,"b":true}')?.message).toBe('{"n":1,"b":true}');
  });
  it("recognises event as a message field", () => {
    expect(parseJsonLine('{"event":"x"}')?.message).toBe("x");
  });
  it("falls back when the message field is not a string", () => {
    const v = parseJsonLine('{"msg":{"nested":true},"name":"svc"}');
    expect(v?.message).toBe("svc");
    expect(v?.tail.map((t) => t.key)).toEqual(["msg"]);
  });
  it("keeps level null when unrecognised so the caller keeps the core level", () => {
    expect(parseJsonLine('{"level":"loud","msg":"x"}')?.level).toBeNull();
    expect(parseJsonLine('{"msg":"x"}')?.level).toBeNull();
  });
});

describe("mapLevel", () => {
  it("maps level strings", () => {
    expect(mapLevel("TRACE")).toBe("debug");
    expect(mapLevel("notice")).toBe("info");
    expect(mapLevel("Warning")).toBe("warn");
    expect(mapLevel("fatal")).toBe("error");
    expect(mapLevel("emerg")).toBe("error");
  });
  it("maps pino numbers", () => {
    expect(mapLevel(20)).toBe("debug");
    expect(mapLevel(30)).toBe("info");
    expect(mapLevel(40)).toBe("warn");
    expect(mapLevel(60)).toBe("error");
  });
  it("maps numeric level strings", () => {
    expect(mapLevel("30")).toBe("info");
  });
  it("returns null for anything else", () => {
    expect(mapLevel(null)).toBeNull();
    expect(mapLevel({ a: 1 })).toBeNull();
    expect(mapLevel("")).toBeNull();
  });
});

describe("compactValue / prettyJson", () => {
  it("renders scalars as literals and compacts containers", () => {
    expect(compactValue("s")).toBe("s");
    expect(compactValue(1.5)).toBe("1.5");
    expect(compactValue(false)).toBe("false");
    expect(compactValue(null)).toBe("null");
    expect(compactValue({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });
  it("cuts containers at 60 characters with an ellipsis", () => {
    const long = { k: "x".repeat(100) };
    const out = compactValue(long);
    expect(out.length).toBe(61);
    expect(out.endsWith("…")).toBe(true);
  });
  it("pretty prints with two spaces", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
