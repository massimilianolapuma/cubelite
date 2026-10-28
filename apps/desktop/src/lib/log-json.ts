import type { LogLevel } from "#lib/tauri.ts";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
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
  if (n <= 20) return "debug";
  if (n <= 30) return "info";
  if (n <= 40) return "warn";
  return "error";
}

/** Scalars as literals; containers as compact JSON cut to `max` characters. */
export function compactValue(value: JsonValue, max = 60): string {
  if (typeof value !== "object" || value === null) return String(value);
  const json = JSON.stringify(value);
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

export function prettyJson(object: JsonObject): string {
  return JSON.stringify(object, null, 2);
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
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const object = parsed;

  const consumed = new Set<string>();

  const timeKey = findKey(object, TIME_KEYS, (v) => typeof v === "string" || typeof v === "number");
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
  if (messageKey !== null) {
    text = object[messageKey] as string;
    consumed.add(messageKey);
  } else {
    const firstKey = Object.keys(object).find((k) => typeof object[k] === "string");
    if (firstKey !== undefined) {
      text = object[firstKey] as string;
      consumed.add(firstKey);
    } else {
      text = JSON.stringify(object);
    }
  }

  const tail = Object.keys(object)
    .filter((k) => !consumed.has(k))
    .map((key) => ({ key, value: compactValue(object[key]) }));

  return { object, time, level, message: text, tail };
}
