import { describe, it, expect } from "vitest";
import type { LogLine } from "#lib/tauri.ts";
import { ECS_VERSION, ecsJson, ecsNdjson, ecsNested, ecsRow, ecsTable, flatten, isLogViewMode, toEcs } from "#lib/log-ecs.ts";

const T = "2026-11-03T08:00:01.123456789Z";

function line(message: string, extra: Partial<LogLine> = {}): LogLine {
  return { pod: "api-0", namespace: "shop", time: T, level: "info", message, ...extra };
}

function fields(doc: ReturnType<typeof toEcs>): Record<string, unknown> {
  return Object.fromEntries(doc.fields.map((f) => [f.key, f.value]));
}

function addedKeys(doc: ReturnType<typeof toEcs>): string[] {
  return doc.fields.filter((f) => f.added).map((f) => f.key);
}

describe("toEcs plain text", () => {
  it("wraps the message with kubelet time, core level and metadata", () => {
    const doc = toEcs(line("GET /health 200", { level: "warn", container: "web" }));
    expect(doc.fields.map((f) => f.key)).toEqual([
      "@timestamp",
      "log.level",
      "message",
      "kubernetes.namespace",
      "kubernetes.pod.name",
      "container.name",
      "ecs.version",
    ]);
    expect(fields(doc)).toMatchObject({
      "@timestamp": T,
      "log.level": "warn",
      message: "GET /health 200",
      "kubernetes.namespace": "shop",
      "kubernetes.pod.name": "api-0",
      "container.name": "web",
      "ecs.version": ECS_VERSION,
    });
    expect(addedKeys(doc)).not.toContain("message");
    expect(doc.level).toBe("warn");
  });

  it("omits container.name when unknown and @timestamp without a kubelet time", () => {
    const doc = toEcs(line("x", { time: null }));
    expect(doc.fields.map((f) => f.key)).not.toContain("container.name");
    expect(doc.fields.map((f) => f.key)).not.toContain("@timestamp");
  });

  it("prefers the explicit container over the line tag", () => {
    expect(fields(toEcs(line("x", { container: "a" }), "b"))["container.name"]).toBe("b");
  });
});

describe("toEcs JSON aliases", () => {
  it("renames every alias group and keeps custom fields at top level", () => {
    const doc = toEcs(
      line(
        JSON.stringify({
          ts: "2026-11-03T07:59:59Z",
          level: "WARN",
          msg: "order accepted",
          logger: "orders",
          error: "boom",
          stack: "at x\nat y",
          traceId: "t1",
          span_id: "s1",
          service: "shop-api",
          orderId: "A-1931",
        }),
      ),
    );
    expect(fields(doc)).toMatchObject({
      "@timestamp": "2026-11-03T07:59:59Z",
      "log.level": "warn",
      message: "order accepted",
      "log.logger": "orders",
      "error.message": "boom",
      "error.stack_trace": "at x\nat y",
      "trace.id": "t1",
      "span.id": "s1",
      "service.name": "shop-api",
      orderId: "A-1931",
    });
    expect(addedKeys(doc)).toEqual(["kubernetes.namespace", "kubernetes.pod.name", "ecs.version"]);
  });

  it("maps pino numeric levels to names", () => {
    expect(fields(toEcs(line('{"level":30,"msg":"m"}')))["log.level"]).toBe("info");
    expect(fields(toEcs(line('{"level":50,"msg":"m"}')))["log.level"]).toBe("error");
    expect(fields(toEcs(line('{"level":60,"msg":"m"}')))["log.level"]).toBe("fatal");
    expect(toEcs(line('{"level":60,"msg":"m"}')).level).toBe("error");
  });

  it("leaves epoch timestamps in place and fills @timestamp from the kubelet", () => {
    const doc = toEcs(line('{"ts":1730620800,"msg":"m"}'));
    expect(fields(doc)).toMatchObject({ ts: 1730620800, "@timestamp": T });
    expect(addedKeys(doc)).toContain("@timestamp");
  });

  it("does not rename onto a field that already exists", () => {
    const doc = toEcs(line('{"message":"a","msg":"b"}'));
    expect(fields(doc)).toMatchObject({ message: "a", msg: "b" });
  });

  it("flattens error objects into error.message and error.stack_trace", () => {
    const doc = toEcs(line('{"msg":"m","err":{"message":"bad","stack":"s"}}'));
    expect(fields(doc)).toMatchObject({ "error.message": "bad", "error.stack_trace": "s" });
  });
});

describe("toEcs already-ECS lines", () => {
  it("keeps fields as logged and adds only missing metadata", () => {
    const doc = toEcs(
      line(
        JSON.stringify({
          "@timestamp": "2026-11-03T07:00:00Z",
          log: { level: "error", logger: "app" },
          message: "failed",
          msg: "not renamed",
          ecs: { version: "1.6.0" },
          kubernetes: { namespace: "other" },
        }),
      ),
    );
    expect(fields(doc)).toMatchObject({
      "@timestamp": "2026-11-03T07:00:00Z",
      "log.level": "error",
      "log.logger": "app",
      msg: "not renamed",
      "ecs.version": "1.6.0",
      "kubernetes.namespace": "other",
    });
    expect(addedKeys(doc)).toEqual(["kubernetes.pod.name"]);
    expect(doc.level).toBe("error");
  });
});

describe("flatten", () => {
  it("lets the nested path win over a literal dotted key", () => {
    expect([...flatten({ "log.level": "a", log: { level: "b" } })]).toEqual([
      ["log.level", "b"],
      ["log.level_", "a"],
    ]);
    expect([...flatten({ log: { level: "b" }, "log.level": "a" })]).toEqual([
      ["log.level", "b"],
      ["log.level_", "a"],
    ]);
  });

  it("keeps arrays and empty objects as values", () => {
    expect([...flatten({ tags: ["a"], meta: {} })]).toEqual([
      ["tags", ["a"]],
      ["meta", {}],
    ]);
  });
});

describe("nested output", () => {
  it("nests dotted keys, ECS fields first", () => {
    const doc = toEcs(line('{"orderId":7,"msg":"m","level":"info"}'));
    expect(ecsJson(doc)).toBe(
      `{"@timestamp":"${T}","log":{"level":"info"},"message":"m","orderId":7,"kubernetes":{"namespace":"shop","pod":{"name":"api-0"}},"ecs":{"version":"${ECS_VERSION}"}}`,
    );
  });

  it("keeps a dotted key literal when a scalar sits on its path", () => {
    expect(
      ecsNested({
        level: "info",
        fields: [
          { key: "a", value: 1, added: false },
          { key: "a.b", value: 2, added: false },
          { key: "x..y", value: 3, added: false },
        ],
      }),
    ).toEqual({ a: 1, "a.b": 2, "x..y": 3 });
  });

  it("treats __proto__ and constructor as plain keys (no prototype pollution)", () => {
    const doc = toEcs(line('{"msg":"m","__proto__":{"polluted":1},"constructor":{"prototype":{"bad":2}}}'));
    const nested = ecsNested(doc);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).bad).toBeUndefined();
    expect(JSON.parse(ecsJson(doc))).toMatchObject({ constructor: { prototype: { bad: 2 } } });
    expect(Object.keys(nested)).toContain("__proto__");
  });

  it("does not let a later scalar overwrite an object on the same path", () => {
    const nested = ecsNested({
      level: "info",
      fields: [
        { key: "service.name", value: "a", added: false },
        { key: "service", value: "b", added: false },
      ],
    });
    expect(JSON.parse(JSON.stringify(nested))).toEqual({ service: { name: "a" }, service_: "b" });
    const deep = ecsNested({
      level: "info",
      fields: [
        { key: "log.level.x", value: 1, added: false },
        { key: "log.level", value: "info", added: false },
      ],
    });
    expect(JSON.parse(JSON.stringify(deep))).toEqual({ log: { level: { x: 1 } }, "log.level": "info" });
  });

  it("keeps large integers exact", () => {
    expect(ecsJson(toEcs(line('{"msg":"m","id":12345678901234567890}')))).toContain('"id":12345678901234567890');
  });

  it("exports the stored document of history lines", () => {
    const out = ecsNdjson([{ ...line("plain"), document: '{"message":"stored","service":{"name":"api"}}' }]);
    expect(JSON.parse(out)).toMatchObject({ message: "stored", service: { name: "api" } });
  });

  it("writes newline-terminated NDJSON", () => {
    const out = ecsNdjson([line("a"), line("b")]);
    expect(out.split("\n")).toHaveLength(3);
    expect(JSON.parse(out.split("\n")[1]).message).toBe("b");
  });
});

describe("ecsRow", () => {
  it("shows service, message and a tail without the noise fields, error and trace first", () => {
    const row = ecsRow(
      toEcs(line('{"msg":"m","service":"api","orderId":"A","trace_id":"t","error":"e"}', { container: "web" })),
    );
    expect(row.service).toBe("api");
    expect(row.message).toBe("m");
    expect(row.tail.map((t) => t.key)).toEqual(["error.message", "trace.id", "orderId"]);
  });

  it("falls back to the first string field when there is no message", () => {
    const row = ecsRow(toEcs(line('{"n":1,"op":"sync","k":"v"}')));
    expect(row.message).toBe("sync");
    expect(row.tail.map((t) => t.key)).toEqual(["n", "k"]);
  });

  it("flattens newlines for the one-line row", () => {
    expect(ecsRow(toEcs(line('{"msg":"a\\nb"}'))).message).toBe("a↵ b");
  });
});

describe("ecsTable", () => {
  it("sorts by field name with @timestamp first", () => {
    const keys = ecsTable(toEcs(line('{"msg":"m","zeta":1,"alpha":2}'))).map((f) => f.key);
    expect(keys[0]).toBe("@timestamp");
    expect(keys).toEqual([...keys].sort());
  });

  it("keeps @timestamp first even before digit or $ keys", () => {
    const keys = ecsTable(toEcs(line('{"msg":"m","1":2,"$x":1}'))).map((f) => f.key);
    expect(keys[0]).toBe("@timestamp");
  });
});

describe("isLogViewMode", () => {
  it("accepts the three modes only", () => {
    expect(["raw", "json", "ecs"].every(isLogViewMode)).toBe(true);
    expect(isLogViewMode(true)).toBe(false);
    expect(isLogViewMode("JSON")).toBe(false);
  });
});
