/**
 * Aggregated multi-pod log stream state: rolling buffer (~180 lines),
 * severity/text filters, follow toggle with paused-buffer counter.
 *
 * Incoming lines land in a non-reactive pending queue and are flushed
 * into the reactive buffer in batches every `FLUSH_MS` — one `$state`
 * reassignment per interval instead of one per line, which is what froze
 * the UI under log flood. While paused nothing flushes at all.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { SvelteSet } from "svelte/reactivity";
import { stopLogs, streamLogs, type LogLine, type PodRef } from "#lib/tauri.ts";
import { errorMessage } from "#lib/errors.ts";
import { app } from "./app.svelte";
import { persisted } from "./settings.svelte";
import { toasts } from "./toasts.svelte";

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

/** Spec: buffer cap ~180 lines. */
const BUFFER_CAP = 180;

/** Batch window for moving pending lines into the reactive buffer. */
export const FLUSH_MS = 120;

export type LevelFilter = "all" | "info" | "warn" | "error";

/** A log line with a store-assigned stable key for `{#each}`. */
export type KeyedLogLine = LogLine & { id: number };

class LogsStore {
  lines = $state<KeyedLogLine[]>([]);
  following = $state(true);
  level = $state<LevelFilter>("all");
  textFilter = $state("");
  /** Lines waiting in the queue while paused (drives the "buffered" pill). */
  bufferedWhilePaused = $state(0);
  streaming = $state(false);
  /** Line ids currently expanded into their JSON tree (JSON view, #461). */
  expanded = new SvelteSet<number>();

  /** Humanise JSON lines; own preference, independent of the log panel's. */
  #jsonView = persisted<boolean>("logs.jsonView", false, isBoolean);
  get jsonView(): boolean {
    return this.#jsonView.value;
  }
  set jsonView(v: boolean) {
    this.#jsonView.value = v;
  }

  #streamId: string | null = null;
  #unlisten: UnlistenFn | null = null;
  /** Non-reactive staging area; bounded at BUFFER_CAP. */
  #pending: KeyedLogLine[] = [];
  #flushTimer: ReturnType<typeof setInterval> | null = null;
  #nextId = 0;

  get filtered(): KeyedLogLine[] {
    const text = this.textFilter.toLowerCase();
    return this.lines.filter((line) => {
      if (this.level !== "all" && line.level !== this.level) return false;
      if (text && !`${line.pod} ${line.message}`.toLowerCase().includes(text)) return false;
      return true;
    });
  }

  push(line: LogLine): void {
    this.#pending.push({ ...line, id: this.#nextId++ });
    if (this.#pending.length > BUFFER_CAP) {
      this.#pending.splice(0, this.#pending.length - BUFFER_CAP);
    }
    if (!this.following) {
      this.bufferedWhilePaused = this.#pending.length;
      return;
    }
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setInterval(() => {
      if (this.#pending.length === 0) {
        this.#stopFlushTimer();
        return;
      }
      this.#flush();
    }, FLUSH_MS);
  }

  #stopFlushTimer(): void {
    if (this.#flushTimer !== null) {
      clearInterval(this.#flushTimer);
      this.#flushTimer = null;
    }
  }

  #flush(): void {
    if (this.#pending.length === 0) return;
    this.lines = [...this.lines, ...this.#pending].slice(-BUFFER_CAP);
    this.#pending = [];
  }

  toggleFollow(): void {
    this.following = !this.following;
    if (this.following) {
      this.bufferedWhilePaused = 0;
      this.#flush();
    } else {
      // Paused: stop the timer; the queue keeps accumulating (bounded).
      this.#stopFlushTimer();
      this.bufferedWhilePaused = this.#pending.length;
    }
  }

  toggleExpanded(id: number): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
  }

  clear(): void {
    this.lines = [];
    this.#pending = [];
    this.bufferedWhilePaused = 0;
    this.expanded.clear();
  }

  /** Start streaming the given pods (restarts any previous stream). */
  async start(pods: PodRef[]): Promise<void> {
    await this.stop();
    // A restart means the scope changed (cluster/namespace/selector) or
    // the pod set did: begin from an empty buffer so stale lines from the
    // previous scope never linger. The per-pod tail re-delivers recent
    // history anyway.
    this.clear();
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
    this.#stopFlushTimer();
    this.#flush();
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
