/**
 * Each context's environment label and access (#662), as the backend holds
 * them in its settings file. The webview never decides a label or an access:
 * it asks for the contexts of the loaded kubeconfig, changes one, or edits the
 * preferences, and follows the `cluster-settings-changed` event (another
 * window's change, the end of a timed unlock). The backend refuses a write to
 * a read-only cluster whatever the webview shows; `lockReason` lets the write
 * controls say so before they are pressed.
 */

import { listen } from "@tauri-apps/api/event";
import {
  CLUSTER_SETTINGS_CHANGED,
  clusterSettings as fetchClusterSettings,
  makeClusterReadOnly,
  makeClusterWritable,
  setClusterAccessPreferences,
  setClusterEnvironment,
  setEnvironmentVariants,
  type AccessPreferences,
  type ClusterSettings,
  type ContextEnvironment,
  type Environment,
  type EnvironmentSetting,
  type EnvironmentVariants,
  type UnlockFor,
} from "#lib/tauri.ts";
import { defaultVariants } from "#lib/environment.ts";
import { errorMessage } from "#lib/errors.ts";
import { clock } from "./clock.svelte";
import { toasts } from "./toasts.svelte";

/** A context's access as shown: `timed` is writable until its unlock ends. */
export type AccessState = "read_only" | "writable" | "timed";

class ClusterSettingsStore {
  byName = $state<Record<string, ContextEnvironment>>({});
  variants = $state<EnvironmentVariants>(defaultVariants());
  /** Ask before a context is made writable. */
  confirmUnlock = $state(true);
  /** The environments whose contexts start read-only when first seen. */
  readOnlyFromStart = $state<Environment[]>(["production"]);
  /** The unlock waiting for the confirmation dialog. */
  pendingUnlock = $state<{ name: string; duration: UnlockFor } | null>(null);

  /** The names of the last load, for a reload on the event. */
  #names: string[] = [];
  /** Bumped by every load and change: an older answer is dropped. */
  #seq = 0;
  #listening = false;

  environmentOf(name: string): Environment | null {
    return this.byName[name]?.environment ?? null;
  }

  sourceOf(name: string): "detected" | "manual" | null {
    return this.byName[name]?.source ?? null;
  }

  /**
   * The access of `name` now. A timed unlock reads read-only as soon as the
   * clock passes its end, before the backend's event: the backend refuses
   * the write from that moment anyway. A context the backend has not
   * answered for shows nothing (writable); the backend decides at the write.
   */
  accessOf(name: string): AccessState {
    const entry = this.byName[name];
    if (!entry) return "writable";
    if (typeof entry.writable_until === "number") {
      return entry.writable_until > clock.now ? "timed" : "read_only";
    }
    return entry.access === "read_only" ? "read_only" : "writable";
  }

  /** The end of the running timed unlock of `name`, in Unix ms; null when none runs. */
  writableUntil(name: string): number | null {
    return this.accessOf(name) === "timed" ? (this.byName[name]?.writable_until ?? null) : null;
  }

  /** Why a write control of `name` is off: "<name> is read-only", or null when it is not. */
  lockReason(name: string | null): string | null {
    if (name === null) return null;
    return this.accessOf(name) === "read_only" ? `${name} is read-only` : null;
  }

  /** The label of every context in `names`; the backend records new ones. */
  async load(names: string[]): Promise<void> {
    this.#names = [...names];
    const seq = ++this.#seq;
    let answer: ClusterSettings;
    try {
      answer = await fetchClusterSettings(this.#names);
    } catch {
      // Labels are an aid: without them the app works as before.
      return;
    }
    // The backend says it reset the file only once: told even when this
    // answer is otherwise too old to use.
    if (answer?.recovered) {
      toasts.push("Cluster settings could not be read and were reset", "err");
    }
    if (seq !== this.#seq || !Array.isArray(answer?.contexts)) return;
    this.byName = Object.fromEntries(answer.contexts.map((c) => [c.name, c]));
    this.#applyRest(answer);
  }

  /** Answers whether the backend saved it; on a refusal the stored label stays. */
  async setEnvironment(name: string, setting: EnvironmentSetting): Promise<boolean> {
    const seq = ++this.#seq;
    let answer: ClusterSettings;
    try {
      answer = await setClusterEnvironment(name, setting);
    } catch (e) {
      toasts.push(`Could not set the environment: ${errorMessage(e)}`, "err");
      return false;
    }
    this.#apply(answer, seq);
    return true;
  }

  /**
   * Make `name` writable for `duration`: asks first (through `pendingUnlock`
   * and the confirmation dialog) when the preference says so.
   */
  async requestUnlock(name: string, duration: UnlockFor): Promise<void> {
    if (this.confirmUnlock) {
      this.pendingUnlock = { name, duration };
      return;
    }
    await this.#makeWritable(name, duration);
  }

  /** The dialog's "Make writable"; `dontAskAgain` turns the confirmation off. */
  async confirmPendingUnlock(dontAskAgain: boolean): Promise<void> {
    const pending = this.pendingUnlock;
    if (!pending) return;
    this.pendingUnlock = null;
    await this.#makeWritable(pending.name, pending.duration);
    if (dontAskAgain) await this.setAccessPreferences({ confirmUnlock: false });
  }

  cancelPendingUnlock(): void {
    this.pendingUnlock = null;
  }

  /** Make `name` read-only; never asks. Answers whether the backend saved it. */
  async makeReadOnly(name: string): Promise<boolean> {
    const seq = ++this.#seq;
    let answer: ClusterSettings;
    try {
      answer = await makeClusterReadOnly(name);
    } catch (e) {
      toasts.push(`Could not make ${name} read-only: ${errorMessage(e)}`, "err");
      return false;
    }
    this.#apply(answer, seq);
    return true;
  }

  /** Save the confirmation and the read-only-from-the-start preferences. */
  async setAccessPreferences(p: AccessPreferences): Promise<boolean> {
    const seq = ++this.#seq;
    let answer: ClusterSettings;
    try {
      answer = await setClusterAccessPreferences(p);
    } catch (e) {
      toasts.push(`Could not save the setting: ${errorMessage(e)}`, "err");
      return false;
    }
    this.#apply(answer, seq);
    return true;
  }

  async #makeWritable(name: string, duration: UnlockFor): Promise<boolean> {
    const seq = ++this.#seq;
    let answer: ClusterSettings;
    try {
      answer = await makeClusterWritable(name, duration);
    } catch (e) {
      toasts.push(`Could not make ${name} writable: ${errorMessage(e)}`, "err");
      return false;
    }
    this.#apply(answer, seq);
    return true;
  }

  /** The answer of a change: the contexts it names over the others. Dropped when a newer call went out. */
  #apply(answer: ClusterSettings, seq: number): void {
    if (seq !== this.#seq || !Array.isArray(answer?.contexts)) return;
    const next = { ...this.byName };
    for (const c of answer.contexts) next[c.name] = c;
    this.byName = next;
    this.#applyRest(answer);
  }

  /** What every answer carries besides the contexts; then the clock, for the countdowns. */
  #applyRest(answer: ClusterSettings): void {
    this.variants = answer.variants;
    if (typeof answer.confirm_unlock === "boolean") this.confirmUnlock = answer.confirm_unlock;
    if (Array.isArray(answer.read_only_from_start)) this.readOnlyFromStart = answer.read_only_from_start;
    const now = Date.now();
    clock.run(Object.values(this.byName).some((c) => typeof c.writable_until === "number" && c.writable_until > now));
  }

  /** Saves the variants; answers the backend's reason when it refuses them. */
  async setVariants(variants: EnvironmentVariants): Promise<string | null> {
    let saved: EnvironmentVariants;
    try {
      saved = await setEnvironmentVariants(variants);
    } catch (e) {
      return errorMessage(e);
    }
    this.variants = saved;
    // Detected labels follow the new words.
    await this.load(this.#names);
    return null;
  }

  /** Follow changes made elsewhere (another window, or this one). Once. */
  async start(): Promise<void> {
    if (this.#listening) return;
    this.#listening = true;
    try {
      await listen(CLUSTER_SETTINGS_CHANGED, () => void this.load(this.#names));
    } catch {
      this.#listening = false;
    }
  }

  /** Tests only: back to the state at start. */
  reset(): void {
    this.byName = {};
    this.variants = defaultVariants();
    this.confirmUnlock = true;
    this.readOnlyFromStart = ["production"];
    this.pendingUnlock = null;
    clock.run(false);
    this.#names = [];
    this.#seq++;
    this.#listening = false;
  }
}

export const clusterSettings = new ClusterSettingsStore();
