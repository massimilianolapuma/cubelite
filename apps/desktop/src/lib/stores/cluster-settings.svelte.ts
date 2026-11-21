/**
 * Each context's environment label (#662), as the backend holds it in its
 * settings file. The webview never decides a label: it asks for the contexts
 * of the loaded kubeconfig, sets one by hand, or edits the variants, and
 * follows the `cluster-settings-changed` event (another window's change).
 */

import { listen } from "@tauri-apps/api/event";
import {
  CLUSTER_SETTINGS_CHANGED,
  clusterSettings as fetchClusterSettings,
  setClusterEnvironment,
  setEnvironmentVariants,
  type ClusterSettings,
  type ContextEnvironment,
  type Environment,
  type EnvironmentSetting,
  type EnvironmentVariants,
} from "#lib/tauri.ts";
import { defaultVariants } from "#lib/environment.ts";
import { errorMessage } from "#lib/errors.ts";
import { toasts } from "./toasts.svelte";

class ClusterSettingsStore {
  byName = $state<Record<string, ContextEnvironment>>({});
  variants = $state<EnvironmentVariants>(defaultVariants());

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
    if (seq !== this.#seq || !Array.isArray(answer?.contexts)) return;
    this.byName = Object.fromEntries(answer.contexts.map((c) => [c.name, c]));
    this.variants = answer.variants;
    if (answer.recovered) {
      toasts.push("Cluster settings could not be read and were reset", "err");
    }
  }

  async setEnvironment(name: string, setting: EnvironmentSetting): Promise<void> {
    const seq = ++this.#seq;
    let answer: ClusterSettings;
    try {
      answer = await setClusterEnvironment(name, setting);
    } catch (e) {
      toasts.push(`Could not set the environment: ${errorMessage(e)}`, "err");
      return;
    }
    if (seq !== this.#seq || !Array.isArray(answer?.contexts)) return;
    const next = { ...this.byName };
    for (const c of answer.contexts) next[c.name] = c;
    this.byName = next;
    this.variants = answer.variants;
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
    this.#names = [];
    this.#seq++;
    this.#listening = false;
  }
}

export const clusterSettings = new ClusterSettingsStore();
