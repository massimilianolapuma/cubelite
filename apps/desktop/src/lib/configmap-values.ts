/**
 * How the ConfigMaps view reads the errors of its two commands (#668 §3.3,
 * §6.3): `read_configmap_value` and `copy_configmap_value`. The rules of a
 * shown or copied value are those of Secrets (`value-reveal.svelte.ts`,
 * `value-copy.svelte.ts`), with no timer and no clearing time.
 */
import { errorMessage } from "#lib/errors.ts";
import type { ConfigMapCommandError, ConfigMapErrorKind } from "#lib/tauri.ts";
import type { ValueErrors } from "#lib/value-reveal.svelte.ts";

const ERROR_KINDS: readonly ConfigMapErrorKind[] = [
  "forbidden",
  "configmap_missing",
  "key_missing",
  "binary",
  "too_large",
  "other",
];

/** A thrown value as a ConfigMap command error: the backend's object, else `other` with its message. */
export function configMapCommandError(e: unknown): ConfigMapCommandError {
  if (typeof e === "object" && e !== null && "kind" in e && "message" in e) {
    const { kind, message } = e as { kind: unknown; message: unknown };
    if (ERROR_KINDS.includes(kind as ConfigMapErrorKind) && typeof message === "string") {
      return { kind: kind as ConfigMapErrorKind, message };
    }
  }
  return { kind: "other", message: errorMessage(e) };
}

/** The words of a row whose read failed; never anything read from the ConfigMap. */
export function configMapErrorText(error: ConfigMapCommandError): string {
  switch (error.kind) {
    case "forbidden":
      return "Not allowed to read this ConfigMap (403)";
    case "configmap_missing":
    case "key_missing":
      return "No longer exists";
    default:
      return error.message;
  }
}

/** How the ConfigMaps view reads its errors. */
export const CONFIGMAP_ERRORS: ValueErrors<ConfigMapCommandError> = {
  parse: configMapCommandError,
  text: configMapErrorText,
  gone: (error) => error.kind === "configmap_missing" || error.kind === "key_missing",
};
