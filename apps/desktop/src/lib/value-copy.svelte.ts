/**
 * Copied values of an object read one key at a time (#661 §3.1, §3.6, §6.2;
 * #668 §3.1): what a key's Copy button shows. The value itself never comes
 * here: the backend reads it and writes the clipboard, and answers only the
 * format used. This keeps, per key, that a copy is running, that it was done
 * (the button reads "Copied" for 2 seconds), or why it failed.
 *
 * It lives for one view and is never persisted. A copy goes to the cluster
 * active at the click (#690). Its answer goes in its row, except in two
 * cases: the row was dropped by `reset` (the namespace or the cluster
 * changed) or `destroy` (the view was left), or its cluster is no longer on
 * screen. The clipboard was written all the same, so a toast tells it then,
 * naming the cluster when it is not the one on screen.
 */
import { activeClusterRef, elsewhere, onScreen, type ClusterRef } from "#lib/stores/cluster-ref.ts";
import type { ToastTone } from "#lib/stores/toasts.svelte.ts";
import type { ValueCommandError, ValueErrors } from "#lib/value-reveal.svelte.ts";

/** What a key's Copy button shows; no entry is at rest. */
export type CopyEntry<E extends ValueCommandError = ValueCommandError> =
  | { status: "copying" }
  | { status: "copied" }
  | { status: "error"; error: E };

/** How long the button reads "Copied". */
export const COPIED_MS = 2000;

/** `30 seconds`, `1 minute`, `5 minutes`. */
function duration(seconds: number): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/**
 * The words after a copy: what was copied (a key, or `KEY of name`), where
 * (` on <cluster>`, or nothing), and when the clipboard is cleared. Never the value.
 */
export function copiedText(what: string, seconds: number, where = ""): string {
  const copied = `${what} copied${where}`;
  return seconds > 0 ? `${copied}, the clipboard is cleared in ${duration(seconds)}` : copied;
}

export type ValueCopyOptions<E extends ValueCommandError> = {
  /**
   * Copies one value from the backend, with the clearing time in seconds (0
   * is Never), on `on`: the cluster active at the click.
   */
  copy: (namespace: string, name: string, key: string, seconds: number, on: ClusterRef) => Promise<unknown>;
  /** The clearing time, in seconds; 0 is Never. Without it, nothing is cleared (a ConfigMap's value). */
  clearAfter?: () => number;
  /** A message for the view's polite status region. Never a value. */
  announce: (message: string) => void;
  /** A toast, for a copy whose row is gone or whose cluster is no longer on screen. Never a value. */
  notify: (message: string, tone: ToastTone) => void;
  /** The list should reload: the object or the key is gone. */
  reload?: () => void;
  errors: ValueErrors<E>;
};

const idOf = (namespace: string, name: string, key: string) => `${namespace}/${name}/${key}`;

export class ValueCopy<E extends ValueCommandError> {
  #entries = $state<Record<string, CopyEntry<E>>>({});
  #timers: Record<string, ReturnType<typeof setTimeout>> = {};
  /** The request each key waits for: an answer of any other is dropped. */
  #awaiting: Record<string, number> = {};
  #requests = 0;
  #closed = false;
  #options: ValueCopyOptions<E>;

  constructor(options: ValueCopyOptions<E>) {
    this.#options = options;
  }

  entry(namespace: string, name: string, key: string): CopyEntry<E> | undefined {
    return this.#entries[idOf(namespace, name, key)];
  }

  /** Every entry, by `namespace/name/key` (for tests and checks). */
  snapshot(): Record<string, CopyEntry<E>> {
    return { ...this.#entries };
  }

  /** Copy one key's value to the clipboard, through the backend. */
  async copy(namespace: string, name: string, key: string): Promise<void> {
    if (this.#closed) return;
    const on = activeClusterRef();
    if (on === null) return;
    const id = idOf(namespace, name, key);
    if (this.#entries[id]?.status === "copying") return;
    this.#drop(id);
    const request = ++this.#requests;
    this.#awaiting[id] = request;
    this.#entries[id] = { status: "copying" };
    const seconds = this.#options.clearAfter?.() ?? 0;
    try {
      await this.#options.copy(namespace, name, key, seconds, on);
    } catch (e) {
      const error = this.#options.errors.parse(e);
      if (this.#orphaned(id, request, on)) {
        this.#options.notify(
          `Could not copy ${key} of ${name}${elsewhere(on)}: ${this.#options.errors.text(error)}`,
          "err",
        );
        return;
      }
      delete this.#awaiting[id];
      this.#entries[id] = { status: "error", error };
      this.#options.announce(`${key}: ${this.#options.errors.text(error)}`);
      if (this.#options.errors.gone(error)) this.#options.reload?.();
      return;
    }
    if (this.#orphaned(id, request, on)) {
      this.#options.notify(copiedText(`${key} of ${name}`, seconds, elsewhere(on)), "ok");
      return;
    }
    delete this.#awaiting[id];
    this.#entries[id] = { status: "copied" };
    this.#options.announce(copiedText(key, seconds));
    this.#timers[id] = setTimeout(() => this.#drop(id), COPIED_MS);
  }

  /**
   * Drop a key's error, when the key is shown instead. A copy running or
   * just done stays in its row: its answer still lands there.
   */
  dismiss(namespace: string, name: string, key: string): void {
    const id = idOf(namespace, name, key);
    if (this.#entries[id]?.status === "error") this.#drop(id);
  }

  /** The namespace or the cluster changed: drop everything, answers in flight too. */
  reset(): void {
    for (const id of Object.keys(this.#entries)) this.#drop(id);
    this.#awaiting = {};
  }

  /** The view is left. */
  destroy(): void {
    this.reset();
    this.#closed = true;
  }

  /**
   * The answer of `request` has no row to go in: the row was dropped by
   * `reset` or `destroy`, or its cluster is no longer on screen, in which
   * case its row is dropped now.
   */
  #orphaned(id: string, request: number, on: ClusterRef): boolean {
    if (this.#awaiting[id] !== request) return true;
    if (onScreen(on)) return false;
    this.#drop(id);
    return true;
  }

  #drop(id: string): void {
    clearTimeout(this.#timers[id]);
    delete this.#timers[id];
    delete this.#awaiting[id];
    delete this.#entries[id];
  }
}
