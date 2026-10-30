import { describe, it, expect } from "vitest";
import {
  parseJsonLine,
  mapLevel,
  compactValue,
  prettyJson,
  displayText,
  type JsonObject,
} from "#lib/log-json.ts";

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
  it("maps numeric level boundaries", () => {
    expect(mapLevel(29)).toBe("debug");
    expect(mapLevel(30)).toBe("info");
    expect(mapLevel(39)).toBe("info");
    expect(mapLevel(40)).toBe("warn");
    expect(mapLevel(49)).toBe("warn");
    expect(mapLevel(50)).toBe("error");
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

describe("review fixes (#454)", () => {
  it("message fallback skips consumed keys", () => {
    const v = parseJsonLine('{"level":"info","ts":"2026-01-01T00:00:00Z","orderId":"A"}');
    expect(v?.message).toBe("A");
    const w = parseJsonLine('{"ts":"2026-10-28T09:41:02Z","cpu":0.3}');
    expect(w?.message).toBe('{"ts":"2026-10-28T09:41:02Z","cpu":0.3}');
  });
  it("compact JSON fallback leaves the tail empty", () => {
    expect(parseJsonLine('{"ts":"2026-10-28T09:41:02Z","cpu":0.3}')?.tail).toEqual([]);
  });
  it("displayText flattens control characters", () => {
    expect(displayText("a\r\nb\nc\td\u0001e")).toBe("a↵ b↵ c d e");
  });
  it("flattens control characters in the message and string tail values only", () => {
    const v = parseJsonLine('{"msg":"a\\nb\\tc","stack":"x\\ny"}');
    expect(v?.message).toBe("a↵ b c");
    expect(v?.tail).toEqual([{ key: "stack", value: "x↵ y" }]);
    expect(v?.object.msg).toBe("a\nb\tc");
  });
  it("maps verbose and dpanic", () => {
    expect(mapLevel("verbose")).toBe("debug");
    expect(mapLevel("DPANIC")).toBe("error");
  });
});

describe("big integers (#455)", () => {
  const big = "12345678901234567890";
  const nanos = "1730000000000000123";

  it("keeps an unsafe integer exact in the tail", () => {
    const view = parseJsonLine(`{"msg":"x","id":${big}}`);
    expect(view?.tail).toEqual([{ key: "id", value: big }]);
    expect(typeof view?.object.id).toBe("bigint");
  });

  it("keeps safe integers and decimals as plain numbers", () => {
    const view = parseJsonLine('{"msg":"x","n":42,"f":1.5,"e":1e3,"max":9007199254740991}');
    expect(view?.object.n).toBe(42);
    expect(view?.object.f).toBe(1.5);
    expect(view?.object.e).toBe(1000);
    expect(view?.object.max).toBe(9007199254740991);
  });

  it("accepts a nanosecond epoch as the time field", () => {
    const view = parseJsonLine(`{"ts":${nanos},"msg":"x"}`);
    expect(view?.time).toBe(nanos);
    expect(view?.tail).toEqual([]);
  });

  it("compactValue and prettyJson print it unquoted and exact", () => {
    const view = parseJsonLine(`{"msg":"x","meta":{"id":${big},"list":[${big}]}}`);
    expect(view?.tail).toEqual([{ key: "meta", value: `{"id":${big},"list":[${big}]}` }]);
    expect(prettyJson(view!.object)).toBe(
      `{\n  "msg": "x",\n  "meta": {\n    "id": ${big},\n    "list": [\n      ${big}\n    ]\n  }\n}`,
    );
  });

  it("compact-JSON message fallback keeps the digits", () => {
    const view = parseJsonLine(`{"id":${big}}`);
    expect(view?.message).toBe(`{"id":${big}}`);
  });

  it("prettyJson still matches JSON.stringify for ordinary values", () => {
    const obj: JsonObject = { s: 'q"\\n', n: -0.5, b: false, z: null, a: [1, "x", { k: [] }, {}], o: {} };
    expect(prettyJson(obj)).toBe(JSON.stringify(obj, null, 2));
    expect(compactValue(obj, 1000)).toBe(JSON.stringify(obj));
  });
});
