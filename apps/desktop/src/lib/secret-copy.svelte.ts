/**
 * Copied Secret values (#661, spec §3.1, §3.6, §6.2): what a key's Copy button
 * shows. The value itself never comes here: the backend reads it and writes
 * the clipboard, and answers only the format used.
 *
 * The rules live in `value-copy.svelte.ts`, shared with ConfigMaps (#668);
 * this is them with a Secret's clearing time and errors.
 */
import { SECRET_ERRORS } from "#lib/secret-reveal.svelte.ts";
import type { ClusterRef } from "#lib/stores/cluster-ref.ts";
import type { ToastTone } from "#lib/stores/toasts.svelte.ts";
import type { CopyFormat, SecretCommandError } from "#lib/tauri.ts";
import { ValueCopy, type CopyEntry as ValueCopyEntry } from "#lib/value-copy.svelte.ts";

export { COPIED_MS, copiedText } from "#lib/value-copy.svelte.ts";

/** What a key's Copy button shows; no entry is at rest. */
export type CopyEntry = ValueCopyEntry<SecretCommandError>;

export type SecretCopyOptions = {
  /**
   * Copies one value from the backend, with the clearing time in seconds (0
   * is Never), on `on`: the cluster active at the click.
   */
  copy: (namespace: string, name: string, key: string, seconds: number, on: ClusterRef) => Promise<CopyFormat>;
  /** The time set in Preferences, in seconds; 0 is Never. */
  clearAfter: () => number;
  /** A message for the view's polite status region. Never a value. */
  announce: (message: string) => void;
  /** A toast, for a copy whose row is gone or whose cluster is no longer on screen. Never a value. */
  notify: (message: string, tone: ToastTone) => void;
  /** The list should reload: the Secret or the key is gone. */
  reload?: () => void;
};

export class SecretCopy extends ValueCopy<SecretCommandError> {
  constructor(options: SecretCopyOptions) {
    super({ ...options, errors: SECRET_ERRORS });
  }
}
