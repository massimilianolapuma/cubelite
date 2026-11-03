/**
 * Resource-list sort (#496): one global default from Preferences, plus a
 * per-list session override set by clicking a column header (cleared on
 * cluster switch and relaunch).
 */
import { DEFAULT_SORT, firstDir, isSortSpec, type SortField, type SortSpec } from "#lib/list-sort.ts";
import { persisted } from "./settings.svelte";

class ListsStore {
  #default = persisted<SortSpec>("lists.sort", DEFAULT_SORT, isSortSpec);
  /** List id → header-click override for this session. */
  overrides = $state<Record<string, SortSpec>>({});

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
    const current = this.overrides[list];
    const next = { ...this.overrides };
    if (!current || current.field !== field) next[list] = { field, dir: firstDir(field) };
    else if (current.dir === firstDir(field)) next[list] = { field, dir: current.dir === "asc" ? "desc" : "asc" };
    else delete next[list];
    this.overrides = next;
  }

  resetSession(): void {
    this.overrides = {};
  }
}

export const lists = new ListsStore();
