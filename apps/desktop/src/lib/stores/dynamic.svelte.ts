/**
 * Resource types listed through the API server's Table (resource-kinds
 * design §5): discovery once per context, on-demand loads, sidebar counts.
 *
 * Discovery is cached per context for the session (spec §5.4). When it is
 * unknown or failed nothing is greyed and lists use the registry's version.
 */

import { untrack } from "svelte";
import {
  discoverResourceKinds,
  listResourceTable,
  type ResourceKindInfo,
  type ResourceRef,
  type ResourceTable,
} from "#lib/tauri.ts";
import { errorMessage } from "#lib/errors.ts";
import { GENERIC_KINDS, type GenericView } from "#lib/resource-kinds.ts";
import { app } from "./app.svelte";

class DynamicStore {
  tables = $state<Partial<Record<GenericView, ResourceTable>>>({});
  errors = $state<Partial<Record<GenericView, string>>>({});
  loading = $state<Partial<Record<GenericView, boolean>>>({});

  /** Context → kinds it serves; a context missing here is unknown. */
  #kinds = $state<Record<string, ResourceKindInfo[]>>({});
  /** Context → discovery in flight. */
  #pending: Record<string, Promise<void>> = {};
  /** Namespace each kind was last loaded with (null = all); missing = not loaded. */
  #loadedFor = $state<Partial<Record<GenericView, string | null>>>({});
  #seq: Partial<Record<GenericView, number>> = {};
  /** Bumped by clear(): answers from before it are dropped. */
  #epoch = 0;

  /** Runs discovery for `context` unless cached (or `force`). Never rejects. */
  discover(context: string, force = false): Promise<void> {
    if (!force && context in this.#kinds) return Promise.resolve();
    const inFlight = this.#pending[context];
    if (inFlight !== undefined && !force) return inFlight;
    const run = this.#runDiscovery(context);
    this.#pending[context] = run;
    void run.finally(() => {
      if (this.#pending[context] === run) delete this.#pending[context];
    });
    return run;
  }

  async #runDiscovery(context: string): Promise<void> {
    try {
      const kinds = await discoverResourceKinds(app.kubeconfigPath, context);
      if (Array.isArray(kinds)) this.#kinds = { ...this.#kinds, [context]: kinds };
    } catch {
      // Unknown discovery: nothing greyed, registry versions used.
    }
  }

  #served(view: GenericView): ResourceKindInfo | null | undefined {
    const cluster = app.activeCluster;
    const kinds = cluster === null ? undefined : this.#kinds[cluster];
    if (!kinds) return undefined;
    const { group, plural } = GENERIC_KINDS[view];
    return kinds.find((k) => k.group === group && k.plural === plural) ?? null;
  }

  /** True only when the active context's discovery is known and lacks the kind. */
  isUnavailable(view: GenericView): boolean {
    return this.#served(view) === null;
  }

  /** The discovered version and scope, else the registry's. */
  refFor(view: GenericView): ResourceRef {
    const reg = GENERIC_KINDS[view];
    const served = this.#served(view);
    return {
      group: reg.group,
      version: served?.version ?? reg.version,
      plural: reg.plural,
      namespaced: served?.namespaced ?? reg.namespaced,
    };
  }

  /** Loads one kind's Table for the active cluster and namespace. Never rejects. */
  async load(view: GenericView): Promise<void> {
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    if (!kc || !cluster) return;
    const seq = (this.#seq[view] ?? 0) + 1;
    this.#seq[view] = seq;
    const epoch = this.#epoch;
    const current = () => this.#seq[view] === seq && this.#epoch === epoch;
    const ns = app.namespace;

    // Views call load() from an effect: reading `loading` here must not subscribe it.
    untrack(() => (this.loading = { ...this.loading, [view]: true }));
    try {
      await this.#pending[cluster];
      if (!current() || this.isUnavailable(view)) return;
      const ref = this.refFor(view);
      const result = await listResourceTable(kc, ref, ref.namespaced ? (ns ?? undefined) : undefined, cluster);
      if (!current()) return;
      this.tables = { ...this.tables, [view]: result };
      this.#loadedFor = { ...this.#loadedFor, [view]: ns };
      if (view in this.errors) {
        const errors = { ...this.errors };
        delete errors[view];
        this.errors = errors;
      }
    } catch (e) {
      if (current()) this.errors = { ...this.errors, [view]: errorMessage(e) };
    } finally {
      if (current()) this.loading = { ...this.loading, [view]: false };
    }
  }

  /** Rows of a loaded kind, or null when not loaded for the current namespace. */
  count(view: GenericView): number | null {
    const loadedFor = this.#loadedFor[view];
    const rows = this.tables[view]?.rows;
    if (loadedFor === undefined || !rows) return null;
    if (this.refFor(view).namespaced && loadedFor !== app.namespace) return null;
    return rows.length;
  }

  /** Drops tables, counts and errors (cluster switch); the discovery cache stays. */
  clear(): void {
    this.#epoch++;
    this.tables = {};
    this.errors = {};
    this.loading = {};
    this.#loadedFor = {};
  }
}

export const dynamic = new DynamicStore();
