import type { LogLevel } from "#lib/tauri.ts";

/** `bigint` holds integers outside the safe range, kept exact from the source text (#455). */
export type JsonValue = string | number | bigint | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type JsonLogView = {
  object: JsonObject;
  /** Raw value of the recognised time field, String()-ed. */
  time: string | null;
  /** Mapped level, or null so the caller keeps the core level. */
  level: LogLevel | null;
  /** Recognised message, else first string field, else compact JSON. */
  message: string;
  /** Remaining top-level fields, insertion order. */
  tail: { key: string; value: string }[];
};

const TIME_KEYS = ["@timestamp", "timestamp", "time", "ts", "t"];
const LEVEL_KEYS = ["level", "severity", "lvl"];
const MESSAGE_KEYS = ["message", "msg", "event"];

const LEVEL_NAMES: Record<string, LogLevel> = {
  trace: "debug",
  debug: "debug",
  info: "info",
  notice: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
  err: "error",
  fatal: "error",
  critical: "error",
  crit: "error",
  alert: "error",
  emerg: "error",
  emergency: "error",
  panic: "error",
  dpanic: "error",
  verbose: "debug",
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Maps a level string (any case) or a pino-style number to a core level. */
export function mapLevel(raw: unknown): LogLevel | null {
  let n: number | null = null;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "") return null;
    if (/^\d+$/.test(s)) n = Number(s);
    else return LEVEL_NAMES[s] ?? null;
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    n = raw;
  }
  if (n === null) return null;
  if (n < 30) return "debug";
  if (n < 40) return "info";
  if (n < 50) return "warn";
  return "error";
}

type ReviverContext = { source?: string } | undefined;
type ParseWithContext = (
  text: string,
  reviver: (key: string, value: unknown, context?: ReviverContext) => unknown,
) => unknown;

/**
 * `JSON.parse` that keeps integers beyond ±2^53 exact as `bigint`, using the
 * reviver's source text (ES2025 "JSON.parse source text access"). Engines
 * without it pass no context and the value stays a rounded number.
 */
function parseJson(text: string): unknown {
  return (JSON.parse as unknown as ParseWithContext)(text, (_key, value, context) => {
    if (typeof value !== "number" || Number.isSafeInteger(value) || !Number.isFinite(value)) return value;
    const source = context?.source;
    return source !== undefined && /^-?\d+$/.test(source) ? BigInt(source) : value;
  });
}

/**
 * Serialises like `JSON.stringify(value, null, indent)` but prints `bigint`
 * values as bare digits, which `JSON.stringify` refuses.
 */
export function jsonText(value: JsonValue, indent = 0, depth = 0): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const pad = (d: number) => " ".repeat(indent * d);
  const inner = pad(depth + 1);
  const join = indent > 0 ? `,\n${inner}` : ",";
  const open = indent > 0 ? `\n${inner}` : "";
  const close = indent > 0 ? `\n${pad(depth)}` : "";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${open}${value.map((v) => jsonText(v, indent, depth + 1)).join(join)}${close}]`;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  const sep = indent > 0 ? ": " : ":";
  const entries = keys.map((k) => `${JSON.stringify(k)}${sep}${jsonText(value[k] as JsonValue, indent, depth + 1)}`);
  return `{${open}${entries.join(join)}${close}}`;
}

/** Scalars as literals; containers as compact JSON cut to `max` characters. */
export function compactValue(value: JsonValue, max = 60): string {
  if (typeof value !== "object" || value === null) return String(value);
  const json = jsonText(value);
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

/** One-line form for the collapsed row: newlines become "↵ ", tabs and other control characters a space. */
export function displayText(s: string): string {
  return s
    .replace(/\r\n|\n/g, "↵ ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, " ");
}

export function prettyJson(object: JsonObject): string {
  return jsonText(object, 2);
}

/** First own key matching a candidate (candidate order wins) whose value passes `accept`. */
function findKey(
  object: JsonObject,
  candidates: string[],
  accept: (v: JsonValue) => boolean,
): string | null {
  const keys = Object.keys(object);
  for (const candidate of candidates) {
    const key = keys.find((k) => k.toLowerCase() === candidate && accept(object[k]));
    if (key !== undefined) return key;
  }
  return null;
}

export function parseJsonLine(message: string): JsonLogView | null {
  const s = message.replace(/^\uFEFF/, "").trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return null;

  let parsed: unknown;
  try {
    parsed = parseJson(s);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const object = parsed;

  const consumed = new Set<string>();

  const timeKey = findKey(
    object,
    TIME_KEYS,
    (v) => typeof v === "string" || typeof v === "number" || typeof v === "bigint",
  );
  const time = timeKey === null ? null : String(object[timeKey]);
  if (timeKey !== null) consumed.add(timeKey);

  let level: LogLevel | null = null;
  const levelKey = findKey(object, LEVEL_KEYS, (v) => mapLevel(v) !== null);
  if (levelKey !== null) {
    level = mapLevel(object[levelKey]);
    consumed.add(levelKey);
  } else {
    const log = object.log;
    if (isObject(log) && "level" in log) level = mapLevel(log.level);
    if (level === null && "log.level" in object) {
      level = mapLevel(object["log.level"]);
      if (level !== null) consumed.add("log.level");
    }
  }

  const messageKey = findKey(object, MESSAGE_KEYS, (v) => typeof v === "string");
  let text: string;
  let compactFallback = false;
  if (messageKey !== null) {
    text = object[messageKey] as string;
    consumed.add(messageKey);
  } else {
    const firstKey = Object.keys(object).find((k) => !consumed.has(k) && typeof object[k] === "string");
    if (firstKey !== undefined) {
      text = object[firstKey] as string;
      consumed.add(firstKey);
    } else {
      text = jsonText(object);
      compactFallback = true;
    }
  }

  const tail = compactFallback
    ? []
    : Object.keys(object)
        .filter((k) => !consumed.has(k))
        .map((key) => ({ key, value: displayText(compactValue(object[key])) }));

  return { object, time, level, message: displayText(text), tail };
}
