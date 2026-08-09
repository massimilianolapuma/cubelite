/**
 * In-app auto-update: a silent check on startup (fails mute — offline is
 * normal), an explicit check from Preferences (surfaces errors), and a
 * download+install step gated behind an explicit user confirmation. This
 * store never relaunches on its own — callers (banner / Preferences) drive
 * `restartNow()` themselves once `status` is `"ready"`.
 */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorMessage } from "$lib/errors";

export type UpdaterStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

class UpdaterStore {
  status = $state<UpdaterStatus>("idle");
  version = $state<string | null>(null);
  error = $state<string | null>(null);

  #update: Update | null = null;
  #checking = false;
  /**
   * Bumped by dismiss() and by every new checkForUpdates() call. Any
   * in-flight checkForUpdates()/downloadAndInstall() re-checks this after
   * its await and abandons (no state writes) if it no longer matches —
   * otherwise a dismiss() mid-download would still land as "ready" once
   * the download resolves, silently reviving an update the user declined.
   */
  #generation = 0;

  /**
   * Check for an update. `silent` gates how a failure surfaces: a startup
   * check (silent) drops back to idle so a flaky/offline network never
   * shows an error banner; an explicit Preferences check (non-silent)
   * surfaces it. A check already in flight makes this a no-op.
   */
  async checkForUpdates(silent: boolean): Promise<void> {
    if (this.#checking) return;
    this.#checking = true;
    const generation = ++this.#generation;
    this.status = "checking";
    this.error = null;
    try {
      const update = await check();
      if (generation !== this.#generation) return;
      this.#update = update;
      this.version = update?.version ?? null;
      this.status = update ? "available" : "idle";
    } catch (e) {
      if (generation !== this.#generation) return;
      this.#update = null;
      this.version = null;
      if (silent) {
        this.status = "idle";
      } else {
        this.error = errorMessage(e);
        this.status = "error";
      }
    } finally {
      this.#checking = false;
    }
  }

  /** Download the checked update and install it. Does NOT relaunch. */
  async downloadAndInstall(): Promise<void> {
    if (!this.#update) return;
    const generation = this.#generation;
    const update = this.#update;
    this.status = "downloading";
    this.error = null;
    try {
      await update.downloadAndInstall();
      if (generation !== this.#generation) return;
      this.status = "ready";
    } catch (e) {
      if (generation !== this.#generation) return;
      this.error = errorMessage(e);
      this.status = "error";
    }
  }

  /** Explicit user confirmation to relaunch into the installed update. */
  async restartNow(): Promise<void> {
    await relaunch();
  }

  /** "Later" — dismiss the banner/prompt without installing. */
  dismiss(): void {
    this.#generation++;
    this.status = "idle";
    this.version = null;
    this.error = null;
    this.#update = null;
  }
}

export const updater = new UpdaterStore();
