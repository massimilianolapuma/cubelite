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
  /** Seconds a value stays shown, counted from when it was shown; 0 is Never. */
  hideAfter: () => number;
  /** A message for the view's polite status region. Never a value. */
  announce: (message: string) => void;
  /**
   * The list should reload: a read found the Secret or the key gone, or read
   * the Secret at another version than the list holds.
   */
  reload?: () => void;
};

/** How long an answer waits for the list to reload before it is dropped. */
const HELD_MS = 10_000;

/** `namespace/name/key`: none of the three can hold a `/`. */
const idOf = (namespace: string, name: string, key: string) => `${namespace}/${name}/${key}`;

/** `[namespace/name, key]` of an id. */
function split(id: string): [string, string] {
  const cut = id.lastIndexOf("/");
  return [id.slice(0, cut), id.slice(cut + 1)];
}

export class SecretReveal {
  #entries = $state<Record<string, RevealEntry>>({});
  // Bookkeeping, not state the page draws: plain records.
  #timers: Record<string, ReturnType<typeof setTimeout>> = {};
  /** Wall-clock time each value was shown at: timers are re-armed from it. */
  #shownAt: Record<string, number> = {};
  /** The request each key waits for: an answer of any other is thrown away. */
  #awaiting: Record<string, number> = {};
  /** An answer read at another version than the list's, until the list reloads. */
  #held: Record<string, RevealedSecretValue> = {};
  /** `namespace/name` → resource version, as the last list showed them. */
  #versions: Record<string, string | null> | null = null;
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
      if (error.kind === "secret_missing" || error.kind === "key_missing") this.#options.reload?.();
      return;
    }
    if (this.#awaiting[id] !== request) return;
    delete this.#awaiting[id];
    // Read at another version than the list shows: not shown until a reload
    // of the list agrees with it (`reconcile` decides).
    const listed = this.#versions?.[`${namespace}/${name}`];
    if (listed !== undefined && listed !== answer.resource_version) {
      this.#held[id] = answer;
      // A reload that never lands (the list failed) must not leave it reading.
      this.#timers[id] = setTimeout(() => this.#drop(id), HELD_MS);
      this.#options.reload?.();
      return;
    }
    this.#show(id, answer);
  }

  /** Reveal a key that is not shown; hide one that is. */
  async toggle(namespace: string, name: string, key: string): Promise<void> {
    if (this.entry(namespace, name, key)?.status === "shown") this.hide(namespace, name, key);
    else await this.reveal(namespace, name, key);
  }

  /** Drop a key's value (or its pending read, or its error). */
  hide(namespace: string, name: string, key: string): void {
    this.#hide(idOf(namespace, name, key));
  }

  /**
   * After a reload of the list: drop what belongs to a Secret or a key that
   * is gone, and a shown value whose Secret has another resource version. An
   * unchanged Secret keeps its value, with its timer running. A held answer
   * is shown if the list is now at its version, else dropped.
   */
  reconcile(secrets: readonly SecretInfo[]): void {
    const byId: Record<string, SecretInfo> = {};
    const versions: Record<string, string | null> = {};
    for (const s of secrets) {
      byId[`${s.namespace}/${s.name}`] = s;
      versions[`${s.namespace}/${s.name}`] = s.resource_version;
    }
    this.#versions = versions;
    for (const [id, entry] of Object.entries(this.#entries)) {
      const [of, key] = split(id);
      const secret: SecretInfo | undefined = byId[of];
      const gone = !secret || !secret.keys.some((k) => k.key === key);
      const held = this.#held[id];
      if (held && !gone) {
        delete this.#held[id];
        if (held.resource_version === secret.resource_version) this.#show(id, held);
        else this.#drop(id);
        continue;
      }
      const changed = entry.status === "shown" && secret?.resource_version !== entry.resourceVersion;
      if (gone || changed) this.#hide(id);
    }
  }

  /**
   * Hide every value whose time is past, by the wall clock, and re-arm the
   * others' timers from when each was shown: after the time is changed in
   * Preferences (Never cancels them), and when the window comes back (a
   * sleep stops timers, not the clock).
   */
  recheck(): void {
    for (const id of Object.keys(this.#shownAt)) this.#arm(id);
  }

  /** The namespace or the cluster changed: drop everything, answers in flight too. */
  reset(): void {
    for (const id of Object.keys(this.#entries)) this.#drop(id);
    this.#awaiting = {};
    this.#held = {};
  }

  /** The view is left. */
  destroy(): void {
    this.reset();
    this.#closed = true;
  }

  #show(id: string, answer: RevealedSecretValue): void {
    this.#entries[id] = { status: "shown", value: answer.value, resourceVersion: answer.resource_version };
    this.#shownAt[id] = Date.now();
    this.#options.announce(`${split(id)[1]} shown`);
    this.#arm(id);
  }

  /** (Re)start the timer of a shown value, or hide it if its time is past. */
  #arm(id: string): void {
    clearTimeout(this.#timers[id]);
    delete this.#timers[id];
    const seconds = this.#options.hideAfter();
    if (seconds <= 0) return;
    const left = this.#shownAt[id] + seconds * 1000 - Date.now();
    if (left <= 0) this.#hide(id);
    else this.#timers[id] = setTimeout(() => this.#hide(id), left);
  }

  #hide(id: string): void {
    const wasShown = this.#entries[id]?.status === "shown";
    this.#drop(id);
    if (wasShown) this.#options.announce(`${split(id)[1]} hidden`);
  }

  #drop(id: string): void {
    clearTimeout(this.#timers[id]);
    delete this.#timers[id];
    delete this.#shownAt[id];
    delete this.#awaiting[id];
    delete this.#held[id];
    delete this.#entries[id];
  }
}
