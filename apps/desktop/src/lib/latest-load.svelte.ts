/**
 * The newest of overlapping loads of one subject (a pod's or a node's
 * Metrics section, #510 #530): its result, error and loading state. A late
 * answer of an older load is dropped, and another subject clears the
 * previous one's result at once.
 */
import { errorMessage } from "#lib/errors.ts";

export class LatestLoad<T, A> {
  result = $state<T | null>(null);
  error = $state<string | null>(null);
  loading = $state(false);
  /** What `result` was loaded with (its range); `initial` before any. */
  args = $state<A>() as A;
  #subject = "";
  #generation = 0;

  constructor(initial: A) {
    this.args = initial;
  }

  /** Switches to `key`; another subject never shows the previous one's result. */
  subject(key: string): void {
    if (key === this.#subject) return;
    this.#subject = key;
    this.result = null;
    this.error = null;
  }

  /** Loads with `args`; only the newest call lands. */
  async run(args: A, fetch: () => Promise<T>): Promise<void> {
    const mine = ++this.#generation;
    this.loading = true;
    this.error = null;
    try {
      const data = await fetch();
      if (mine === this.#generation) {
        this.result = data;
        this.args = args;
      }
    } catch (e) {
      if (mine === this.#generation) {
        this.error = errorMessage(e);
        this.result = null;
      }
    } finally {
      if (mine === this.#generation) this.loading = false;
    }
  }
}
