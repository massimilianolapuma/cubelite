/**
 * Bounded reactive ring buffer for one log session (spec cap: 5000).
 * `totalAppended` is monotonic so the "↓ N new lines" pill can count
 * arrivals even after eviction.
 */
import type { LogLine } from "$lib/tauri";
import type { KeyedLogLine } from "./logs.svelte";

export class LogRing {
  lines = $state<KeyedLogLine[]>([]);
  totalAppended = $state(0);
  readonly cap: number;
  #nextId = 0;

  constructor(cap: number) {
    this.cap = cap;
  }

  append(batch: LogLine[]): void {
    if (batch.length === 0) return;
    const keyed = batch.map((l) => ({ ...l, id: this.#nextId++ }));
    this.lines = [...this.lines, ...keyed].slice(-this.cap);
    this.totalAppended += batch.length;
  }

  clear(): void {
    this.lines = [];
  }
}
