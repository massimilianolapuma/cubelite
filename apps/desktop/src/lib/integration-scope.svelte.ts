/**
 * Which endpoint the integration preferences edit (#528): the context's own,
 * or the default shared by every context, and the per-context actions on
 * the default (override, turn off, use it again). Shared by the
 * Elasticsearch and Prometheus preferences.
 */
import { scopeView, type EndpointScopeKind, type ScopeView, type ScopedEndpoint } from "#lib/endpoint-scope.ts";
import type { IntegrationKind } from "#lib/integration-suggest.ts";
import type { EndpointStore } from "#lib/stores/endpoints.svelte.ts";
import { integrations } from "#lib/stores/integrations.svelte.ts";
import { toasts } from "#lib/stores/toasts.svelte.ts";

export class EndpointScope<E extends ScopedEndpoint, P> {
  scope = $state<EndpointScopeKind>("context");
  /** The user chose Override on a context using the default. */
  overriding = $state(false);

  readonly #store: EndpointStore<E, P>;
  readonly #name: string;
  readonly #kind: IntegrationKind;
  readonly #removeSecret: (context: string, own: E) => Promise<void>;
  readonly #disconnect: (context: string) => Promise<void>;

  constructor(args: {
    store: EndpointStore<E, P>;
    /** "Elasticsearch", "Prometheus". */
    name: string;
    kind: IntegrationKind;
    /** Deletes the credentials saved for a context's own endpoint. */
    removeSecret: (context: string, own: E) => Promise<void>;
    disconnect: (context: string) => Promise<void>;
  }) {
    this.#store = args.store;
    this.#name = args.name;
    this.#kind = args.kind;
    this.#removeSecret = args.removeSecret;
    this.#disconnect = args.disconnect;
  }

  view(context: string | null): ScopeView {
    return scopeView(this.scope, this.#store.useOf(context), this.overriding);
  }

  /** The saved endpoint the form edits in `view`. */
  saved(view: ScopeView, context: string | null): E | null {
    return view === "default" ? this.#store.defaultEndpoint : this.#store.ownEndpoint(context);
  }

  /** `endpoint` as the backend must see it in `view`: the default's credentials are the default's. */
  forBackend(view: ScopeView, endpoint: E): E {
    return view === "default" ? { ...endpoint, shared: true } : endpoint;
  }

  /** The default stops applying to `context`. */
  async turnOff(context: string): Promise<void> {
    this.#store.setOff(context, true);
    this.overriding = false;
    // Turned off on purpose: the detection banner must not offer it again.
    integrations.dismissKind(context, this.#kind);
    await this.#disconnect(context);
    toasts.push(`${this.#name} off for ${context}`, "ok");
  }

  /** Drops `context`'s own endpoint (and its credentials) and turns the default back on. */
  async useDefault(context: string): Promise<void> {
    const own = this.#store.ownEndpoint(context);
    if (own) await this.#removeSecret(context, own);
    this.#store.setEndpoint(context, null);
    this.#store.setOff(context, false);
    this.overriding = false;
    await this.#disconnect(context);
    toasts.push(`${this.#name}: ${context} uses the default endpoint`, "ok");
  }

  /** After the own form saved `endpoint` (null = Off): Off with a default means "not the default either". */
  savedOwn(context: string, endpoint: E | null): void {
    if (!endpoint && this.#store.defaultEndpoint) this.#store.setOff(context, true);
    this.overriding = false;
  }

  /** Toast after the default was saved or removed. */
  savedDefault(endpoint: E | null): void {
    toasts.push(endpoint ? `${this.#name} default endpoint saved` : `${this.#name} default endpoint removed`, "ok");
  }
}
