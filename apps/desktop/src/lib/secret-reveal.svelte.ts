/**
 * Shown Secret values (#661, spec §3.2, §7): one value per key, read from the
 * backend only when the user reveals that key, and dropped from memory (not
 * only covered) when its timer ends, on Hide, when the view is left or the
 * namespace or the cluster changes, and when a reload of the list shows the
 * Secret changed or the Secret or the key gone.
 *
 * The rules live in `value-reveal.svelte.ts`, shared with ConfigMaps (#668);
 * this is them with a Secret's timer and errors.
 */
import { errorMessage } from "#lib/errors.ts";
import type { ClusterRef } from "#lib/stores/cluster-ref.ts";
import type { RevealedSecretValue, SecretCommandError, SecretErrorKind } from "#lib/tauri.ts";
import { ValueReveal, type RevealEntry as ValueRevealEntry, type ValueErrors } from "#lib/value-reveal.svelte.ts";

/** What a key's row shows; no entry is a hidden value. */
export type RevealEntry = ValueRevealEntry<SecretCommandError>;

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

/** How the Secrets view reads its errors. */
export const SECRET_ERRORS: ValueErrors<SecretCommandError> = {
  parse: secretCommandError,
  text: errorText,
  gone: (error) => error.kind === "secret_missing" || error.kind === "key_missing",
};

export type SecretRevealOptions = {
  /** Reads one value from the backend, at this moment, on `on`: the cluster active at the click. */
  read: (namespace: string, name: string, key: string, on: ClusterRef) => Promise<RevealedSecretValue>;
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

export class SecretReveal extends ValueReveal<SecretCommandError> {
  constructor(options: SecretRevealOptions) {
    super({ ...options, errors: SECRET_ERRORS });
  }
}
