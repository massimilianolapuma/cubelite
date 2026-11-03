import type { LogLevel, LogLine } from "#lib/tauri.ts";
import { compactValue, displayText, jsonText, mapLevel, parseJsonLine, type JsonObject, type JsonValue } from "#lib/log-json.ts";

/** Log view modes of the log panel and the aggregated Logs view (#492). */
export type LogViewMode = "raw" | "json" | "ecs";

export function isLogViewMode(v: unknown): v is LogViewMode {
  return v === "raw" || v === "json" || v === "ecs";
}

/** ECS version stamped on converted documents that carry none. */
export const ECS_VERSION = "8.11.0";

export type EcsField = {
  /** Flattened dotted name (`log.level`). */
  key: string;
  value: JsonValue;
  /** Added by the conversion (kubelet time, core level, metadata, ecs.version). */
  added: boolean;
};

export type EcsDocument = {
  /** ECS-first order: `@timestamp`, `log.level`, `message`, then the line's order, then added fields. */
  fields: EcsField[];
  /** Level for the badge: `log.level` mapped, else the core level. */
  level: LogLevel;
};

type Alias = {
  target: string;
  candidates: string[];
  accept: (v: JsonValue) => boolean;
  convert?: (v: JsonValue) => JsonValue;
};

const isString = (v: JsonValue) => typeof v === "string";
const ISO_8601 = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const PINO_NAMES: [number, string][] = [
  [20, "trace"],
  [30, "debug"],
  [40, "info"],
  [50, "warn"],
  [60, "error"],
];

function levelName(v: JsonValue): JsonValue {
  const s = typeof v === "string" ? v.trim() : null;
  const n = typeof v === "number" ? v : s !== null && /^\d+$/.test(s) ? Number(s) : null;
  if (n === null) return s === null ? v : s.toLowerCase();
  return PINO_NAMES.find(([limit]) => n < limit)?.[1] ?? "fatal";
}

const ALIASES: Alias[] = [
  {
    target: "@timestamp",
    candidates: ["timestamp", "time", "ts", "t"],
    accept: (v) => typeof v === "string" && ISO_8601.test(v),
  },
  {
    target: "log.level",
    candidates: ["level", "severity", "lvl"],
    accept: (v) => mapLevel(v) !== null,
    convert: levelName,
  },
  { target: "message", candidates: ["msg", "event"], accept: isString },
  { target: "log.logger", candidates: ["logger", "logger_name", "loggername", "name"], accept: isString },
  { target: "error.message", candidates: ["error", "err", "err.message"], accept: isString },
  {
    target: "error.stack_trace",
    candidates: ["stack", "stacktrace", "stack_trace", "error.stack", "err.stack"],
    accept: isString,
  },
  { target: "trace.id", candidates: ["trace_id", "traceid"], accept: isString },
  { target: "span.id", candidates: ["span_id", "spanid"], accept: isString },
  { target: "service.name", candidates: ["service", "service_name", "servicename"], accept: isString },
];

function isPlainObject(v: JsonValue): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof v !== "bigint";
}

/**
 * Flattens nested objects to dotted keys. When a literal dotted key and a
 * nested path collide, the nested value wins and the literal one moves to
 * `<key>_`.
 */
export function flatten(object: JsonObject): Map<string, JsonValue> {
  const out = new Map<string, JsonValue>();
  const nested = new Set<string>();
  const put = (key: string, value: JsonValue, fromNesting: boolean) => {
    if (out.has(key)) {
      if (fromNesting && !nested.has(key)) {
        out.set(`${key}_`, out.get(key) as JsonValue);
      } else {
        out.set(`${key}_`, value);
        return;
      }
    }
    out.set(key, value);
    if (fromNesting) nested.add(key);
  };
  const walk = (value: JsonObject, prefix: string) => {
    for (const [k, v] of Object.entries(value)) {
      const key = prefix === "" ? k : `${prefix}.${k}`;
      if (isPlainObject(v) && Object.keys(v).length > 0) walk(v, key);
      else put(key, v, prefix !== "");
    }
  };
  walk(object, "");
  return out;
}

/** Renames `from` to `to` keeping its position in the map. */
function rename(map: Map<string, JsonValue>, from: string, to: string, value: JsonValue): Map<string, JsonValue> {
  const out = new Map<string, JsonValue>();
  for (const [k, v] of map) out.set(k === from ? to : k, k === from ? value : v);
  return out;
}

function applyAliases(input: Map<string, JsonValue>): Map<string, JsonValue> {
  let map = input;
  for (const alias of ALIASES) {
    if (map.has(alias.target)) continue;
    const keys = [...map.keys()];
    for (const candidate of alias.candidates) {
      const key = keys.find((k) => k.toLowerCase() === candidate && alias.accept(map.get(k) as JsonValue));
      if (key === undefined) continue;
      const value = map.get(key) as JsonValue;
      map = rename(map, key, alias.target, alias.convert ? alias.convert(value) : value);
      break;
    }
  }
  return map;
}

const LEADING = ["@timestamp", "log.level", "message"];

/**
 * The ECS document a log line becomes (spec §4): JSON objects are flattened
 * and, unless they already carry `ecs.version`, common aliases are renamed;
 * plain text becomes `message`. Missing `@timestamp` / `log.level` come from
 * the kubelet time and the core level; Kubernetes metadata and `ecs.version`
 * are added when absent.
 */
export function toEcs(line: Pick<LogLine, "time" | "level" | "message" | "namespace" | "pod" | "container">, container?: string | null): EcsDocument {
  const object = parseJsonLine(line.message)?.object ?? null;
  let map: Map<string, JsonValue>;
  if (object === null) {
    map = new Map([["message", line.message]]);
  } else {
    map = flatten(object);
    if (!map.has("ecs.version")) map = applyAliases(map);
  }

  const added: [string, JsonValue][] = [];
  const fill = (key: string, value: JsonValue | null | undefined) => {
    if (value !== null && value !== undefined && value !== "" && !map.has(key)) added.push([key, value]);
  };
  fill("@timestamp", line.time);
  fill("log.level", line.level);
  fill("kubernetes.namespace", line.namespace);
  fill("kubernetes.pod.name", line.pod);
  fill("container.name", container ?? line.container);
  fill("ecs.version", ECS_VERSION);

  const own: EcsField[] = [...map].map(([key, value]) => ({ key, value, added: false }));
  const extra: EcsField[] = added.map(([key, value]) => ({ key, value, added: true }));
  const all = [...own, ...extra];
  const leading = LEADING.flatMap((k) => all.filter((f) => f.key === k));
  const fields = [...leading, ...all.filter((f) => !LEADING.includes(f.key))];

  const levelField = fields.find((f) => f.key === "log.level");
  const level = (levelField && mapLevel(levelField.value)) ?? line.level;
  return { fields, level };
}

/** Nested form (`{"log":{"level":…}}`), what Elasticsearch stores. */
export function ecsNested(doc: EcsDocument): JsonObject {
  // Null-prototype objects and own-property checks: log keys such as
  // `__proto__` or `constructor` must stay plain keys (no prototype pollution).
  const make = (): JsonObject => Object.create(null) as JsonObject;
  const root = make();
  for (const { key, value } of doc.fields) {
    const parts = key.split(".");
    if (parts.some((p) => p === "")) {
      root[key] = value;
      continue;
    }
    let node: JsonObject = root;
    let placed = false;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = Object.hasOwn(node, parts[i]) ? node[parts[i]] : undefined;
      if (next === undefined) node[parts[i]] = make();
      else if (!isPlainObject(next)) {
        // A scalar already sits on the path: keep the rest of the key dotted.
        node[parts.slice(i).join(".")] = value;
        placed = true;
        break;
      }
      node = node[parts[i]] as JsonObject;
    }
    if (!placed) {
      const last = parts[parts.length - 1];
      // An object already sits at this slot (`service.name` before `service`): keep the
      // key dotted at the root, or suffixed like a flatten collision when it has no dots.
      if (Object.hasOwn(node, last) && isPlainObject(node[last])) root[parts.length > 1 ? key : `${key}_`] = value;
      else node[last] = value;
    }
  }
  return root;
}

export function ecsJson(doc: EcsDocument, indent = 0): string {
  return jsonText(ecsNested(doc), indent);
}

/** Fields on every row of a pod (or shown elsewhere on the row): kept out of the tail. */
const TAIL_HIDDEN = new Set([
  "@timestamp",
  "log.level",
  "message",
  "service.name",
  "ecs.version",
  "kubernetes.namespace",
  "kubernetes.pod.name",
  "container.name",
]);
const TAIL_FIRST = ["error.message", "error.type", "trace.id"];

export type EcsRow = {
  message: string;
  service: string | null;
  tail: { key: string; value: string }[];
};

/** Collapsed-row summary (spec §5.1). */
export function ecsRow(doc: EcsDocument): EcsRow {
  const get = (key: string) => doc.fields.find((f) => f.key === key)?.value;
  const service = get("service.name");
  const visible = doc.fields.filter((f) => !TAIL_HIDDEN.has(f.key));
  const message = get("message");
  let text: string | null = typeof message === "string" ? message : null;
  let rest = visible;
  if (text === null) {
    const first = visible.find((f) => typeof f.value === "string");
    if (first) {
      text = first.value as string;
      rest = visible.filter((f) => f !== first);
    }
  }
  const ordered = [
    ...TAIL_FIRST.flatMap((k) => rest.filter((f) => f.key === k)),
    ...rest.filter((f) => !TAIL_FIRST.includes(f.key)),
  ];
  return {
    message: displayText(text ?? ""),
    service: typeof service === "string" ? service : null,
    tail: ordered.map((f) => ({ key: f.key, value: displayText(compactValue(f.value)) })),
  };
}

/** Field-table rows, Kibana order (by name; `@timestamp` sorts first). */
export function ecsTable(doc: EcsDocument): EcsField[] {
  const rank = (k: string) => (k === "@timestamp" ? 0 : 1);
  return [...doc.fields].sort(
    (a, b) => rank(a.key) - rank(b.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/** NDJSON export: one compact nested ECS document per line, newline-terminated. */
export function ecsNdjson(lines: Parameters<typeof toEcs>[0][], container?: string | null): string {
  return lines.map((l) => `${ecsJson(toEcs(l, container))}\n`).join("");
}
