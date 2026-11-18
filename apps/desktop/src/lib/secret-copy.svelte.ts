/**
 * Copied Secret values (#661, spec §3.1, §3.6, §6.2): what a key's Copy button
 * shows. The value itself never comes here: the backend reads it and writes
 * the clipboard, and answers only the format used. This keeps, per key, that
 * a copy is running, that it was done (the button reads "Copied" for 2
 * seconds), or why it failed.
 *
 * It lives for one view and is never persisted. An answer that arrives after
 * the view is left or the namespace or the cluster changed is dropped.
 */
import { errorText, secretCommandError } from "#lib/secret-reveal.svelte.ts";
import type { CopyFormat, SecretCommandError } from "#lib/tauri.ts";

/** What a key's Copy button shows; no entry is at rest. */
export type CopyEntry = { status: "copying" } | { status: "copied" } | { status: "error"; error: SecretCommandError };

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

/** The status region's words after a copy: the key and when the clipboard is cleared. Never the value. */
export function copiedText(key: string, seconds: number): string {
  return seconds > 0 ? `${key} copied, the clipboard is cleared in ${duration(seconds)}` : `${key} copied`;
}

export type SecretCopyOptions = {
  /** Copies one value from the backend, with the clearing time in seconds (0 is Never). */
  copy: (namespace: string, name: string, key: string, seconds: number) => Promise<CopyFormat>;
  /** The time set in Preferences, in seconds; 0 is Never. */
  clearAfter: () => number;
  /** A message for the view's polite status region. Never a value. */
  announce: (message: string) => void;
  /** The list should reload: the Secret or the key is gone. */
  reload?: () => void;
};

const idOf = (namespace: string, name: string, key: string) => `${namespace}/${name}/${key}`;

export class SecretCopy {
  #entries = $state<Record<string, CopyEntry>>({});
  #timers: Record<string, ReturnType<typeof setTimeout>> = {};
  /** The request each key waits for: an answer of any other is dropped. */
  #awaiting: Record<string, number> = {};
  #requests = 0;
  #closed = false;
  #options: SecretCopyOptions;

  constructor(options: SecretCopyOptions) {
    this.#options = options;
  }

  entry(namespace: string, name: string, key: string): CopyEntry | undefined {
    return this.#entries[idOf(namespace, name, key)];
  }

  /** Every entry, by `namespace/name/key` (for tests and checks). */
  snapshot(): Record<string, CopyEntry> {
    return { ...this.#entries };
  }

  /** Copy one key's value to the clipboard, through the backend. */
  async copy(namespace: string, name: string, key: string): Promise<void> {
    if (this.#closed) return;
    const id = idOf(namespace, name, key);
    if (this.#entries[id]?.status === "copying") return;
    this.#drop(id);
    const request = ++this.#requests;
    this.#awaiting[id] = request;
    this.#entries[id] = { status: "copying" };
    const seconds = this.#options.clearAfter();
    try {
      await this.#options.copy(namespace, name, key, seconds);
    } catch (e) {
      if (this.#awaiting[id] !== request) return;
      delete this.#awaiting[id];
      const error = secretCommandError(e);
      this.#entries[id] = { status: "error", error };
      this.#options.announce(`${key}: ${errorText(error)}`);
      if (error.kind === "secret_missing" || error.kind === "key_missing") this.#options.reload?.();
      return;
    }
    if (this.#awaiting[id] !== request) return;
    delete this.#awaiting[id];
    this.#entries[id] = { status: "copied" };
    this.#options.announce(copiedText(key, seconds));
    this.#timers[id] = setTimeout(() => this.#drop(id), COPIED_MS);
  }

  /** Drop a key's state (its error, when the key is revealed instead). */
  dismiss(namespace: string, name: string, key: string): void {
    this.#drop(idOf(namespace, name, key));
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

  #drop(id: string): void {
    clearTimeout(this.#timers[id]);
    delete this.#timers[id];
    delete this.#awaiting[id];
    delete this.#entries[id];
  }
}
