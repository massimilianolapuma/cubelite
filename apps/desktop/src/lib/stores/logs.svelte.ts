/**
 * Aggregated multi-pod log stream state: rolling buffer (~180 lines),
 * severity/text filters, follow toggle with paused-buffer counter.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { stopLogs, streamLogs, type LogLine, type PodRef } from "$lib/tauri";
import { errorMessage } from "$lib/errors";
import { app } from "./app.svelte";
import { toasts } from "./toasts.svelte";

/** Spec: buffer cap ~180 lines. */
const BUFFER_CAP = 180;

export type LevelFilter = "all" | "info" | "warn" | "error";

class LogsStore {
  lines = $state<LogLine[]>([]);
  following = $state(true);
  level = $state<LevelFilter>("all");
  textFilter = $state("");
  /** Lines that arrived while paused (drives the "buffered" pill). */
  bufferedWhilePaused = $state(0);
  streaming = $state(false);

  #streamId: string | null = null;
  #unlisten: UnlistenFn | null = null;

  get filtered(): LogLine[] {
    const text = this.textFilter.toLowerCase();
    return this.lines.filter((line) => {
      if (this.level !== "all" && line.level !== this.level) return false;
      if (text && !`${line.pod} ${line.message}`.toLowerCase().includes(text)) return false;
      return true;
    });
  }

  push(line: LogLine): void {
    this.lines = [...this.lines, line].slice(-BUFFER_CAP);
    if (!this.following) this.bufferedWhilePaused += 1;
  }

  toggleFollow(): void {
    this.following = !this.following;
    if (this.following) this.bufferedWhilePaused = 0;
  }

  clear(): void {
    this.lines = [];
    this.bufferedWhilePaused = 0;
  }

  /** Start streaming the given pods (restarts any previous stream). */
  async start(pods: PodRef[]): Promise<void> {
    await this.stop();
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    if (!kc || !cluster || pods.length === 0) return;

    try {
      this.#unlisten = await listen<LogLine>("log-line", (event) => {
        this.push(event.payload);
      });
      this.#streamId = await streamLogs(kc, pods, cluster);
      this.streaming = true;
    } catch (e) {
      toasts.push(`Log stream failed: ${errorMessage(e)}`, "err");
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    this.streaming = false;
    if (this.#unlisten) {
      this.#unlisten();
      this.#unlisten = null;
    }
    const id = this.#streamId;
    this.#streamId = null;
    if (id) {
      try {
        await stopLogs(id);
      } catch {
        // Backend may already have dropped the stream.
      }
    }
  }
}

export const logs = new LogsStore();
