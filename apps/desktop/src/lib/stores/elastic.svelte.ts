/**
 * Elasticsearch endpoints per kube context (#501, spec
 * docs/superpowers/specs/2026-11-03-elastic-kibana-design.md §3). Only the
 * endpoint is stored here; credentials live in the OS keychain (backend).
 */
import type { EsEndpoint } from "#lib/tauri.ts";
import { persisted } from "./settings.svelte";

const isRecord = (v: unknown): v is Record<string, EsEndpoint> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

class ElasticStore {
  #endpoints = persisted<Record<string, EsEndpoint>>("elastic.endpoints", {}, isRecord);

  endpointFor(context: string | null): EsEndpoint | null {
    if (!context) return null;
    return this.#endpoints.value[context] ?? null;
  }

  setEndpoint(context: string, endpoint: EsEndpoint | null): void {
    const next = { ...this.#endpoints.value };
    if (endpoint) next[context] = endpoint;
    else delete next[context];
    this.#endpoints.value = next;
  }
}

export const elastic = new ElasticStore();
