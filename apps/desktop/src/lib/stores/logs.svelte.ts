/**
 * Aggregated multi-pod log stream state: rolling buffer (~180 lines),
 * severity/text filters, follow toggle with paused-buffer counter.
 *
 * Incoming lines land in a non-reactive pending queue and are flushed
 * into the reactive buffer in batches every `FLUSH_MS` — one `$state`
 * reassignment per interval instead of one per line, which is what froze
 * the UI under log flood. While paused nothing flushes at all.
 *
 * The view can narrow to one workload's pods and switch to its
 * Elasticsearch history (#529), reusing the log panel's `LogHistory`.
 */

import { isLogViewMode, type LogViewMode } from "#lib/log-ecs.ts";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { SvelteSet } from "svelte/reactivity";
import { stopLogs, streamLogs, type LogLine, type PodRef } from "#lib/tauri.ts";
import { errorMessage } from "#lib/errors.ts";
import type { HistoryMapping, LogScope } from "#lib/log-scope.ts";
import { app } from "./app.svelte";
import { persisted } from "./settings.svelte";
import { toasts } from "./toasts.svelte";
import { HISTORY_ID_BASE, LogHistory } from "./logHistory.svelte";

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
  #scope = $state<{ scope: LogScope; cluster: string | null } | null>(null);
  /**
   * Workload the view is narrowed to (#529); null shows every pod in scope.
   * A scope belongs to the cluster it was picked on, and to its namespace:
   * it reads as null once either no longer matches.
   */
  get scope(): LogScope | null {
    const picked = this.#scope;
    if (!picked) return null;
    const ns = app.namespace;
    return picked.cluster === app.activeCluster && (ns === null || ns === picked.scope.namespace)
      ? picked.scope
      : null;
  }
  set scope(scope: LogScope | null) {
    this.#scope = scope ? { scope, cluster: app.activeCluster } : null;
  }
  /** Live stream or Elasticsearch history; the stream keeps running in History. */
  source = $state<"live" | "history">("live");
  /** History of the current filter; null when the filter has no history query. */
  history = $state<LogHistory | null>(null);
  /** Identity of `history`'s query (cluster, namespace, workload). */
  #historyKey = "";

  /** Humanise JSON lines; own preference, independent of the log panel's. */
  /** Pre-#492 boolean toggle, read once to seed `viewMode`. */
  #legacyJsonView = persisted<boolean>("logs.jsonView", false, isBoolean);
  #viewMode = persisted<LogViewMode>("logs.viewMode", this.#legacyJsonView.value ? "json" : "raw", isLogViewMode);
  /** Raw, JSON (#454) or ECS (#492) rendering of the lines. */
  get viewMode(): LogViewMode {
    return this.#viewMode.value;
  }
  set viewMode(v: LogViewMode) {
    this.#viewMode.value = v;
  }

  #streamId: string | null = null;
  #unlisten: UnlistenFn | null = null;
  /** Non-reactive staging area; bounded at BUFFER_CAP. */
  #pending: KeyedLogLine[] = [];
  #flushTimer: ReturnType<typeof setInterval> | null = null;
  #nextId = 0;

  /** Lines of the active source. */
  get sourceLines(): KeyedLogLine[] {
    return this.source === "history" ? (this.history?.lines ?? []) : this.lines;
  }

  get filtered(): KeyedLogLine[] {
    const text = this.textFilter.toLowerCase();
    return this.sourceLines.filter((line) => {
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

  /**
   * Points History at the view's filter on `cluster` (#529). A different
   * query replaces the history (its point in time is released); without one
   * the view goes back to Live.
   */
  setHistory(mapping: HistoryMapping, cluster: string | null): void {
    const key =
      mapping.namespace === null || !cluster ? "" : JSON.stringify([cluster, mapping.namespace, mapping.target]);
    if (key === this.#historyKey) return;
    this.#historyKey = key;
    this.history?.close();
    this.#dropHistoryExpansions();
    if (mapping.namespace === null || !cluster) {
      this.history = null;
      this.source = "live";
      return;
    }
    this.history = new LogHistory(mapping.namespace, mapping.target, () => null, () => this.#dropHistoryExpansions());
    if (this.source === "history") void this.history.reload();
  }

  /** The view closed: release the history's point in time and go back to Live. */
  closeHistory(): void {
    this.setHistory({ namespace: null, target: null, reason: "" }, null);
  }

  /** Switches the source; the first switch to History loads a page. */
  setSource(source: "live" | "history"): void {
    if (source === "history" && !this.history) return;
    this.source = source;
    if (source === "history" && this.history && !this.history.started) void this.history.reload();
  }

  #dropHistoryExpansions(): void {
    for (const id of this.expanded) if (id >= HISTORY_ID_BASE) this.expanded.delete(id);
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
