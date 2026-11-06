/**
 * Resource-list sort (#496): one global default from Preferences, plus a
 * per-list session override set by clicking a column header (cleared on
 * cluster switch and relaunch).
 *
 * Grouping by namespace (#547): one global persisted switch, and the
 * collapsed groups per namespace name, shared by all lists, for the session.
 */
import { DEFAULT_SORT, firstDir, isSortSpec, type SortDir, type SortField, type SortSpec } from "#lib/list-sort.ts";
import type { CollapseState } from "#lib/list-group.ts";
import { persisted } from "./settings.svelte";

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

class ListsStore {
  #default = persisted<SortSpec>("lists.sort", DEFAULT_SORT, isSortSpec);
  #grouped = persisted<boolean>("lists.groupByNamespace", false, isBoolean);
  /** List id → header-click override for this session. */
  overrides = $state<Record<string, SortSpec>>({});
  /** Collapsed namespace groups for this session (see `list-group.ts`). */
  collapsed = $state<CollapseState>({});

  /** Preference "Group by namespace"; applies only with all namespaces shown. */
  get groupByNamespace(): boolean {
    return this.#grouped.value;
  }
  set groupByNamespace(v: boolean) {
    this.#grouped.value = v;
  }

  get defaultSort(): SortSpec {
    return this.#default.value;
  }
  set defaultSort(v: SortSpec) {
    this.#default.value = v;
  }

  specFor(list: string): SortSpec {
    return this.overrides[list] ?? this.#default.value;
  }

  /**
   * Header click: a new field starts in its natural direction, a second
   * click flips it, a third returns to the Preferences default.
   */
  clickHeader(list: string, field: SortField): void {
    const flip = (dir: SortDir): SortDir => (dir === "asc" ? "desc" : "asc");
    const current = this.overrides[list];
    let spec: SortSpec | null;
    if (!current || current.field !== field) spec = { field, dir: firstDir(field) };
    else if (current.dir === firstDir(field)) spec = { field, dir: flip(current.dir) };
    else spec = null;
    // A click must always change the list: if the next state equals what is shown
    // (the default already sorts by this field), flip instead.
    const shown = this.specFor(list);
    if (spec && spec.field === shown.field && spec.dir === shown.dir) spec = { field, dir: flip(spec.dir) };
    const next = { ...this.overrides };
    if (spec) next[list] = spec;
    else delete next[list];
    this.overrides = next;
  }

  resetSession(): void {
    this.overrides = {};
    this.collapsed = {};
  }
}

export const lists = new ListsStore();
