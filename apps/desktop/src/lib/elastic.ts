import type { EsEndpoint, HistoryLine } from "#lib/tauri.ts";

/** Default index pattern: Elastic Agent data streams, Filebeat, Logstash. */
export const DEFAULT_INDEX_PATTERN = "logs-*,filebeat-*,logstash-*";

/** History time ranges (spec §4); values are Elasticsearch date math. */
export const HISTORY_RANGES = [
  { value: "now-15m", label: "15 min" },
  { value: "now-1h", label: "1 h" },
  { value: "now-24h", label: "24 h" },
  { value: "now-7d", label: "7 d" },
] as const;

export type HistoryRange = (typeof HISTORY_RANGES)[number]["value"];

export function isHistoryRange(v: unknown): v is HistoryRange {
  return HISTORY_RANGES.some((r) => r.value === v);
}

export function newEndpoint(target: EsEndpoint["target"]): EsEndpoint {
  return {
    target,
    indexPattern: DEFAULT_INDEX_PATTERN,
    preset: "ecs",
    kibanaUrl: null,
    kibanaService: null,
    skipTlsVerify: false,
  };
}

/** One-line description of an endpoint for status lines. */
export function describeEndpoint(endpoint: EsEndpoint): string {
  const t = endpoint.target;
  return t.kind === "external" ? t.url : `${t.namespace}/${t.service}:${t.port}`;
}

/** "1,234 hits", "10,000+ hits", or "" when unknown. */
export function hitsLabel(total: number | null, lowerBound: boolean): string {
  if (total === null) return "";
  return `${total.toLocaleString("en-US")}${lowerBound ? "+" : ""} hit${total === 1 ? "" : "s"}`;
}

/**
 * `_index`/`_id` of the history hits shown (#531): a page resumed on a new
 * point in time may repeat the boundary hits, dropped with this. Plain (not
 * reactive) state, kept out of the `.svelte.ts` stores.
 */
export class HistoryKeys {
  #keys = new Set<string>();

  static #key(line: HistoryLine): string | null {
    return line.docIndex && line.docId ? `${line.docIndex}/${line.docId}` : null;
  }

  /** Remembers `line`; false when it was already shown. Hits without ids always count as new. */
  add(line: HistoryLine): boolean {
    const key = HistoryKeys.#key(line);
    if (key === null) return true;
    if (this.#keys.has(key)) return false;
    this.#keys.add(key);
    return true;
  }

  /** True when `line` was already shown. */
  has(line: HistoryLine): boolean {
    const key = HistoryKeys.#key(line);
    return key !== null && this.#keys.has(key);
  }
}
