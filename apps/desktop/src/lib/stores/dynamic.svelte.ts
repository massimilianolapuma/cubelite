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
import {
  GENERIC_KINDS,
  customView,
  isCustomKind,
  isCustomView,
  isGenericView,
  vendorOf,
  parseCustomView,
  type CustomView,
  type KindView,
} from "#lib/resource-kinds.ts";
import { app } from "./app.svelte";

/** What a list and the sidebar need to show a Table-listed kind. */
export interface KindMeta {
  label: string;
  nouns: readonly [string, string];
  namespaced: boolean;
  group: string;
}

export interface CustomKind {
  view: CustomView;
  group: string;
  kind: string;
  plural: string;
  shortNames: string[];
}

export interface CustomGroup {
  group: string;
  kinds: CustomKind[];
}

export interface CustomVendor {
  vendor: string;
  kinds: CustomKind[];
}

const byName = new Intl.Collator(undefined, { sensitivity: "base" }).compare;

/** Group and plural of a Table-listed view (registry for ★, the id for custom). */
function identity(view: KindView): { group: string; plural: string } {
  if (isGenericView(view)) return GENERIC_KINDS[view];
  return parseCustomView(view) ?? { group: "", plural: view };
}

class DynamicStore {
  tables = $state<Partial<Record<KindView, ResourceTable>>>({});
  errors = $state<Partial<Record<KindView, string>>>({});
  loading = $state<Partial<Record<KindView, boolean>>>({});

  /** Context → kinds it serves; a context missing here is unknown. */
  #kinds = $state<Record<string, ResourceKindInfo[]>>({});
  /** Contexts whose last discovery failed (cleared by a success). */
  #failed = $state<Record<string, true>>({});
  /** Context → discovery in flight. */
  #pending: Record<string, Promise<void>> = {};
  /** Namespace each kind was last loaded with (null = all); missing = not loaded. */
  #loadedFor = $state<Partial<Record<KindView, string | null>>>({});
  /** View → namespace of its last answer, rows or error (not reactive). */
  #triedFor: Partial<Record<KindView, string | null>> = {};
  #seq: Partial<Record<KindView, number>> = {};
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
      if (!Array.isArray(kinds)) throw new Error("no discovery answer");
      this.#kinds = { ...this.#kinds, [context]: kinds };
      if (context in this.#failed) {
        const failed = { ...this.#failed };
        delete failed[context];
        this.#failed = failed;
      }
    } catch {
      // Unknown discovery: nothing greyed, registry versions used.
      if (!(context in this.#kinds)) this.#failed = { ...this.#failed, [context]: true };
    }
  }

  /** The active context's discovery, or undefined while unknown. */
  get #activeKinds(): ResourceKindInfo[] | undefined {
    const cluster = app.activeCluster;
    return cluster === null ? undefined : this.#kinds[cluster];
  }

  #served(view: KindView): ResourceKindInfo | null | undefined {
    const kinds = this.#activeKinds;
    if (!kinds) return undefined;
    const { group, plural } = identity(view);
    return kinds.find((k) => k.group === group && k.plural === plural) ?? null;
  }

  /** The active context's discovery failed and nothing is known yet. */
  get discoveryFailed(): boolean {
    const cluster = app.activeCluster;
    return cluster !== null && cluster in this.#failed && !(cluster in this.#kinds);
  }

  /** Discovery is known for the active context (custom groups are final). */
  get customKnown(): boolean {
    return this.#activeKinds !== undefined;
  }

  /** The active context's custom kinds by API group, groups and kinds by name. */
  get customGroups(): CustomGroup[] {
    const groups: Record<string, CustomKind[]> = {};
    for (const k of this.#activeKinds ?? []) {
      // Skip a kind whose id would not parse (it could not be opened or pinned).
      if (!isCustomKind(k) || !isCustomView(customView(k.group, k.plural))) continue;
      (groups[k.group] ??= []).push({
        view: customView(k.group, k.plural),
        group: k.group,
        kind: k.kind,
        plural: k.plural,
        shortNames: k.short_names,
      });
    }
    return Object.entries(groups)
      .map(([group, kinds]) => ({ group, kinds: kinds.sort((a, b) => byName(a.kind, b.kind)) }))
      .sort((a, b) => byName(a.group, b.group));
  }

  /** The active context's custom kinds by vendor (registrable domain), kinds by name then group. */
  get customVendors(): CustomVendor[] {
    const vendors: Record<string, CustomKind[]> = {};
    for (const g of this.customGroups) (vendors[vendorOf(g.group)] ??= []).push(...g.kinds);
    return Object.entries(vendors)
      .map(([vendor, kinds]) => ({
        vendor,
        kinds: kinds.sort((a, b) => byName(a.kind, b.kind) || byName(a.group, b.group)),
      }))
      .sort((a, b) => byName(a.vendor, b.vendor));
  }

  /** Number of custom kinds the active context serves. */
  get customKindCount(): number {
    return this.customGroups.reduce((n, g) => n + g.kinds.length, 0);
  }

  /** Label, row nouns, scope and group of a Table-listed kind. */
  meta(view: KindView): KindMeta {
    if (isGenericView(view)) {
      const k = GENERIC_KINDS[view];
      return { label: k.label, nouns: k.nouns, namespaced: this.refFor(view).namespaced, group: k.group };
    }
    const { group, plural } = identity(view);
    const served = this.#served(view);
    if (!served) return { label: plural, nouns: [plural, plural], namespaced: true, group };
    return {
      label: served.kind,
      nouns: [served.kind.toLowerCase(), served.plural],
      namespaced: served.namespaced,
      group,
    };
  }

  /** True only when the active context's discovery is known and lacks the kind. */
  isUnavailable(view: KindView): boolean {
    return this.#served(view) === null;
  }

  /** The discovered version and scope, else the registry's. */
  refFor(view: KindView): ResourceRef {
    const served = this.#served(view);
    const { group, plural } = identity(view);
    // An unknown custom kind is never listed (unavailable once discovery is known).
    const fallback = isGenericView(view) ? GENERIC_KINDS[view] : { version: "v1", namespaced: true };
    return {
      group,
      version: served?.version ?? fallback.version,
      plural,
      namespaced: served?.namespaced ?? fallback.namespaced,
    };
  }

  /** Loads one kind's Table for the active cluster and namespace. Never rejects. */
  async load(view: KindView): Promise<void> {
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    if (!kc || !cluster) return;
    const seq = (this.#seq[view] ?? 0) + 1;
    this.#seq[view] = seq;
    const epoch = this.#epoch;
    const current = () => this.#seq[view] === seq && this.#epoch === epoch;
    const ns = app.namespace;

    // Views call load() from an effect: reading `loading` here must not subscribe it.
    untrack(() => {
      this.loading = { ...this.loading, [view]: true };
      this.#dropOtherNamespace(view, ns);
    });
    try {
      await this.#pending[cluster];
      if (!current() || this.isUnavailable(view)) return;
      const ref = this.refFor(view);
      const result = await listResourceTable(kc, ref, ref.namespaced ? (ns ?? undefined) : undefined, cluster);
      if (!current()) return;
      this.tables = { ...this.tables, [view]: result };
      this.#loadedFor = { ...this.#loadedFor, [view]: ns };
      this.#triedFor[view] = ns;
      if (view in this.errors) {
        const errors = { ...this.errors };
        delete errors[view];
        this.errors = errors;
      }
    } catch (e) {
      if (current()) {
        this.errors = { ...this.errors, [view]: errorMessage(e) };
        this.#triedFor[view] = ns;
      }
    } finally {
      if (current()) this.loading = { ...this.loading, [view]: false };
    }
  }

  /**
   * A namespaced kind's rows or error belong to the namespace they were
   * loaded for: on a namespace change drop them at once, so the list says
   * Loading… instead of showing the previous namespace until the answer.
   */
  #dropOtherNamespace(view: KindView, ns: string | null): void {
    if (!(view in this.#triedFor) || this.#triedFor[view] === ns) return;
    if (!this.refFor(view).namespaced) return;
    if (view in this.tables) {
      const tables = { ...this.tables };
      delete tables[view];
      this.tables = tables;
    }
    if (view in this.errors) {
      const errors = { ...this.errors };
      delete errors[view];
      this.errors = errors;
    }
  }

  /** Rows of a loaded kind, or null when not loaded for the current namespace. */
  count(view: KindView): number | null {
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
    this.#triedFor = {};
  }
}

export const dynamic = new DynamicStore();
