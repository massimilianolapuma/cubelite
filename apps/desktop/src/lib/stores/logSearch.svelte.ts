/**
 * Live search over a log buffer: case-insensitive substring, match ids
 * precomputed off the render path (150 ms debounce), n/N cursor with wrap,
 * optional filter mode that hides non-matching lines.
 */
import type { KeyedLogLine } from "./logs.svelte";

export const SEARCH_DEBOUNCE_MS = 150;

export class LogSearch {
  query = $state("");
  filterMode = $state(false);
  matchIds = $state<number[]>([]);
  cursor = $state(0);

  #getLines: () => KeyedLogLine[] = () => [];
  #debounce: ReturnType<typeof setTimeout> | null = null;

  get activeId(): number | null {
    return this.matchIds[this.cursor] ?? null;
  }

  get count(): number {
    return this.matchIds.length;
  }

  matchSet = $derived(new Set(this.matchIds));

  attach(getLines: () => KeyedLogLine[]): void {
    this.#getLines = getLines;
  }

  setQuery(q: string): void {
    this.query = q;
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      this.recompute(this.#getLines());
    }, SEARCH_DEBOUNCE_MS);
  }

  recompute(lines: KeyedLogLine[]): void {
    const q = this.query.toLowerCase();
    if (!q) {
      this.matchIds = [];
      this.cursor = 0;
      return;
    }
    const ids: number[] = [];
    for (const line of lines) {
      if (line.message.toLowerCase().includes(q)) ids.push(line.id);
    }
    this.matchIds = ids;
    if (this.cursor >= ids.length) this.cursor = 0;
  }

  next(): void {
    if (this.count === 0) return;
    this.cursor = (this.cursor + 1) % this.count;
  }

  prev(): void {
    if (this.count === 0) return;
    this.cursor = (this.cursor - 1 + this.count) % this.count;
  }

  clear(): void {
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = null;
    this.query = "";
    this.matchIds = [];
    this.cursor = 0;
    this.filterMode = false;
  }
}
