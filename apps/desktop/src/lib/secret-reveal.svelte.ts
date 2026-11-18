/**
 * Shown Secret values (#661, spec §3.2, §7): one value per key, read from the
 * backend only when the user reveals that key, and dropped from memory (not
 * only covered) when its timer ends, on Hide, when the view is left or the
 * namespace or the cluster changes, and when a reload of the list shows the
 * Secret changed or the Secret or the key gone.
 *
 * It lives for one view and is never persisted. An answer that arrives after
 * its cause is gone is thrown away, never shown and never stored.
 */
import { errorMessage } from "#lib/errors.ts";
import type { RevealedSecretValue, SecretCommandError, SecretErrorKind, SecretInfo } from "#lib/tauri.ts";

/** What a key's row shows; no entry is a hidden value. */
export type RevealEntry =
  | { status: "reading" }
  | { status: "shown"; value: string; resourceVersion: string | null }
  | { status: "error"; error: SecretCommandError };

const ERROR_KINDS: readonly SecretErrorKind[] = [
  "forbidden",
  "secret_missing",
  "key_missing",
  "not_a_value",
  "binary",
  "too_large",
  "other",
];

/** A thrown value as a Secret command error: the backend's object, else `other` with its message. */
export function secretCommandError(e: unknown): SecretCommandError {
  if (typeof e === "object" && e !== null && "kind" in e && "message" in e) {
    const { kind, message } = e as { kind: unknown; message: unknown };
    if (ERROR_KINDS.includes(kind as SecretErrorKind) && typeof message === "string") {
      return { kind: kind as SecretErrorKind, message };
    }
  }
  return { kind: "other", message: errorMessage(e) };
}

/** The words of a row whose read failed (§3.5); never anything read from the Secret. */
export function errorText(error: SecretCommandError): string {
  switch (error.kind) {
    case "forbidden":
      return "Not allowed to read this Secret (403)";
    case "secret_missing":
    case "key_missing":
      return "No longer exists";
    default:
      return error.message;
  }
}

export type SecretRevealOptions = {
  /** Reads one value from the backend, at this moment. */
  read: (namespace: string, name: string, key: string) => Promise<RevealedSecretValue>;
  /** Seconds a value stays shown, read at each reveal; 0 is Never. */
  hideAfter: () => number;
  /** A message for the view's polite status region. Never a value. */
  announce: (message: string) => void;
  /** A read found the Secret or the key gone: the list should reload. */
  onGone?: () => void;
};

/** `namespace/name/key`: none of the three can hold a `/`. */
const idOf = (namespace: string, name: string, key: string) => `${namespace}/${name}/${key}`;

export class SecretReveal {
  #entries = $state<Record<string, RevealEntry>>({});
  // Bookkeeping, not state the page draws: plain records.
  #timers: Record<string, ReturnType<typeof setTimeout>> = {};
  /** The request each key waits for: an answer of any other is thrown away. */
  #awaiting: Record<string, number> = {};
  #requests = 0;
  #closed = false;
  #options: SecretRevealOptions;

  constructor(options: SecretRevealOptions) {
    this.#options = options;
  }

  entry(namespace: string, name: string, key: string): RevealEntry | undefined {
    return this.#entries[idOf(namespace, name, key)];
  }

  /** Every entry, by `namespace/name/key` (for tests and checks). */
  snapshot(): Record<string, RevealEntry> {
    return { ...this.#entries };
  }

  /** Read the value of one key and show it, with a timer of its own. */
  async reveal(namespace: string, name: string, key: string): Promise<void> {
    if (this.#closed) return;
    const id = idOf(namespace, name, key);
    if (this.#entries[id]?.status === "reading") return;
    this.#drop(id);
    const request = ++this.#requests;
    this.#awaiting[id] = request;
    this.#entries[id] = { status: "reading" };
    let answer: RevealedSecretValue;
    try {
      answer = await this.#options.read(namespace, name, key);
    } catch (e) {
      if (this.#awaiting[id] !== request) return;
      delete this.#awaiting[id];
      const error = secretCommandError(e);
      this.#entries[id] = { status: "error", error };
      this.#options.announce(`${key}: ${errorText(error)}`);
      if (error.kind === "secret_missing" || error.kind === "key_missing") this.#options.onGone?.();
      return;
    }
    if (this.#awaiting[id] !== request) return;
    delete this.#awaiting[id];
    this.#entries[id] = { status: "shown", value: answer.value, resourceVersion: answer.resource_version };
    this.#options.announce(`${key} shown`);
    const seconds = this.#options.hideAfter();
    if (seconds > 0) {
      this.#timers[id] = setTimeout(() => this.hide(namespace, name, key), seconds * 1000);
    }
  }

  /** Reveal a key that is not shown; hide one that is. */
  async toggle(namespace: string, name: string, key: string): Promise<void> {
    if (this.entry(namespace, name, key)?.status === "shown") this.hide(namespace, name, key);
    else await this.reveal(namespace, name, key);
  }

  /** Drop a key's value (or its pending read, or its error). */
  hide(namespace: string, name: string, key: string): void {
    const id = idOf(namespace, name, key);
    const wasShown = this.#entries[id]?.status === "shown";
    this.#drop(id);
    if (wasShown) this.#options.announce(`${key} hidden`);
  }

  /**
   * After a reload of the list: drop what belongs to a Secret or a key that
   * is gone, and a shown value whose Secret has another resource version. An
   * unchanged Secret keeps its value, with its timer running.
   */
  reconcile(secrets: readonly SecretInfo[]): void {
    const byId: Record<string, SecretInfo> = {};
    for (const s of secrets) byId[`${s.namespace}/${s.name}`] = s;
    for (const [id, entry] of Object.entries(this.#entries)) {
      const cut = id.lastIndexOf("/");
      const key = id.slice(cut + 1);
      const secret: SecretInfo | undefined = byId[id.slice(0, cut)];
      const gone = !secret || !secret.keys.some((k) => k.key === key);
      const changed = entry.status === "shown" && secret?.resource_version !== entry.resourceVersion;
      if (!gone && !changed) continue;
      this.#drop(id);
      if (entry.status === "shown") this.#options.announce(`${key} hidden`);
    }
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
