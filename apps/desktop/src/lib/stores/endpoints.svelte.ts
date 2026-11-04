/**
 * Integration endpoints per kube context (Elasticsearch #501, Prometheus
 * #510), and the default endpoint shared by every context (#528). Only
 * endpoints are stored here; credentials live in the OS keychain (backend).
 *
 * A context's endpoint is `own ?? (off ? null : default)`; the default
 * carries the context's own settings (Prometheus `cluster` label,
 * Elasticsearch cluster filter). Older settings (endpoints only) load as
 * they were: no default, nothing off.
 */
import { canBeDefault, resolveEndpoint, type EndpointUse, type ScopedEndpoint } from "#lib/endpoint-scope.ts";
import { persisted } from "./settings.svelte";

const isRecord = <E>(v: unknown): v is Record<string, E> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isEndpointOrNull = <E>(v: unknown): v is E | null =>
  v === null || (isRecord(v) && isRecord((v as { target?: unknown }).target));

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export class EndpointStore<E extends ScopedEndpoint, P = Partial<E>> {
  #endpoints;
  #default;
  #off;
  #settings;
  readonly #merge: (fallback: E, settings: P) => E;

  /**
   * `merge` applies a context's own settings to the default endpoint
   * (`{...fallback, ...settings}` unless given).
   */
  constructor(key: string, merge?: (fallback: E, settings: P) => E) {
    this.#endpoints = persisted<Record<string, E>>(key, {}, isRecord<E>);
    this.#default = persisted<E | null>(`${key}.default`, null, isEndpointOrNull<E>);
    this.#off = persisted<string[]>(`${key}.off`, [], isStringArray);
    this.#settings = persisted<Record<string, P>>(`${key}.contexts`, {}, isRecord<P>);
    this.#merge = merge ?? ((fallback, settings) => ({ ...fallback, ...settings }));
  }

  /** The endpoint `context` uses: its own, else the default unless off. */
  endpointFor(context: string | null): E | null {
    if (!context) return null;
    return resolveEndpoint({
      own: this.ownEndpoint(context),
      fallback: this.defaultEndpoint,
      disabled: this.isOff(context),
      settings: this.contextSettings(context),
      merge: this.#merge,
    });
  }

  /** The default endpoint resolved with `settings` (a form's draft). */
  defaultFor(settings: P | null): E | null {
    return resolveEndpoint({
      own: null,
      fallback: this.defaultEndpoint,
      disabled: false,
      settings,
      merge: this.#merge,
    });
  }

  ownEndpoint(context: string | null): E | null {
    return context ? (this.#endpoints.value[context] ?? null) : null;
  }

  get defaultEndpoint(): E | null {
    return this.#default.value;
  }

  isOff(context: string): boolean {
    return this.#off.value.includes(context);
  }

  /** The context's own settings applied to the default. */
  contextSettings(context: string): P | null {
    return this.#settings.value[context] ?? null;
  }

  useOf(context: string | null): EndpointUse {
    if (!context) return "none";
    if (this.ownEndpoint(context)) return "own";
    if (!this.defaultEndpoint) return "none";
    return this.isOff(context) ? "off" : "default";
  }

  /** The contexts among `contexts` that use the default endpoint. */
  usersOfDefault(contexts: string[]): string[] {
    return contexts.filter((c) => this.useOf(c) === "default");
  }

  /** Stores (or with null removes) `context`'s own endpoint; one of its own is never off. */
  setEndpoint(context: string, endpoint: E | null): void {
    const next = { ...this.#endpoints.value };
    if (endpoint) next[context] = endpoint;
    else delete next[context];
    this.#endpoints.value = next;
    if (endpoint) this.setOff(context, false);
  }

  /** Stores (or with null removes) the default; false for an in-cluster target. */
  setDefault(endpoint: E | null): boolean {
    if (endpoint && !canBeDefault(endpoint.target)) return false;
    this.#default.value = endpoint ? { ...endpoint, shared: undefined } : null;
    return true;
  }

  /** Turns the default off (or back on) for `context`. */
  setOff(context: string, off: boolean): void {
    const rest = this.#off.value.filter((c) => c !== context);
    this.#off.value = off ? [...rest, context] : rest;
  }

  setContextSettings(context: string, settings: P | null): void {
    const next = { ...this.#settings.value };
    if (settings) next[context] = settings;
    else delete next[context];
    this.#settings.value = next;
  }
}
