/**
 * Integration endpoints per kube context (Elasticsearch #501, Prometheus
 * #510). Only endpoints are stored here; credentials live in the OS
 * keychain (backend).
 */
import { persisted } from "./settings.svelte";

const isRecord = <E>(v: unknown): v is Record<string, E> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class EndpointStore<E> {
  #endpoints;

  constructor(key: string) {
    this.#endpoints = persisted<Record<string, E>>(key, {}, isRecord<E>);
  }

  endpointFor(context: string | null): E | null {
    if (!context) return null;
    return this.#endpoints.value[context] ?? null;
  }

  setEndpoint(context: string, endpoint: E | null): void {
    const next = { ...this.#endpoints.value };
    if (endpoint) next[context] = endpoint;
    else delete next[context];
    this.#endpoints.value = next;
  }
}
