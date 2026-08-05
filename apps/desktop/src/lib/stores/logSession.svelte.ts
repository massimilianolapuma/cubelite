/**
 * One log-panel session: container choice, stream lifecycle, bounded ring
 * buffer with batched flush (FLUSH_MS pattern from logs.svelte.ts).
 * Reconnect-on-drop lands with `followWithReconnect` (see design addendum).
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  getPodContainers,
  stopLogs,
  streamPodLog,
  type ContainerDetail,
  type LogLine,
} from "$lib/tauri";
import { errorMessage } from "$lib/errors";
import { app } from "./app.svelte";
import { LogRing } from "./logRing.svelte";
import { FLUSH_MS } from "./logs.svelte";

export const RING_CAP = 5000;
export const DEFAULT_TAIL = 500;

export type SessionStatus = "connecting" | "streaming" | "reconnecting" | "ended" | "error";

export class LogSession {
  readonly key: string;
  readonly namespace: string;
  readonly pod: string;

  containers = $state<ContainerDetail[]>([]);
  container = $state<string | null>(null);
  previous = $state(false);
  following = $state(true);
  status = $state<SessionStatus>("connecting");
  error = $state<string | null>(null);
  reconnectAttempt = $state(0);
  nextRetryAt = $state<number | null>(null);
  tailLines = $state(DEFAULT_TAIL);
  seenCount = $state(0);
  ring = new LogRing(RING_CAP);

  #streamId: string | null = null;
  #unlisteners: UnlistenFn[] = [];
  #pending: LogLine[] = [];
  #flushTimer: ReturnType<typeof setInterval> | null = null;
  #lastTime: string | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every (re)start so stale async callbacks become no-ops. */
  #generation = 0;

  constructor(namespace: string, pod: string, initialContainer: string | null = null) {
    this.namespace = namespace;
    this.pod = pod;
    this.key = `${namespace}/${pod}`;
    this.container = initialContainer;
  }

  async open(): Promise<void> {
    const kc = app.kubeconfigPath;
    const ctx = app.activeCluster ?? undefined;
    try {
      this.containers = await getPodContainers(kc, this.namespace, this.pod, ctx);
      if (!this.container || !this.containers.some((c) => c.name === this.container)) {
        this.container =
          this.containers.find((c) => !c.init)?.name ?? this.containers[0]?.name ?? null;
      }
    } catch (e) {
      this.status = "error";
      this.error = errorMessage(e);
      return;
    }
    await this.#start();
  }

  async #start(): Promise<void> {
    const generation = ++this.#generation;
    await this.#teardownStream();
    if (generation !== this.#generation) return;
    this.status = "connecting";
    this.error = null;
    const kc = app.kubeconfigPath;
    const ctx = app.activeCluster ?? undefined;
    try {
      const id = await streamPodLog(
        kc,
        this.namespace,
        this.pod,
        {
          container: this.container ?? undefined,
          previous: this.previous,
          tailLines: this.tailLines,
          sinceTime: this.#lastTime,
        },
        ctx,
      );
      if (generation !== this.#generation) {
        void stopLogs(id);
        return;
      }
      this.#streamId = id;
      this.#unlisteners.push(
        await listen<LogLine>(`pod-log-line:${id}`, (event) => {
          if (generation !== this.#generation) return;
          this.reconnectAttempt = 0;
          if (event.payload.time) this.#lastTime = event.payload.time;
          this.#pending.push(event.payload);
          this.#scheduleFlush();
        }),
        await listen(`pod-log-end:${id}`, () => {
          if (generation !== this.#generation) return;
          this.#onStreamEnd();
        }),
      );
      this.status = "streaming";
    } catch (e) {
      if (generation !== this.#generation) return;
      this.status = "error";
      this.error = errorMessage(e);
    }
  }

  #onStreamEnd(): void {
    this.#flush();
    if (this.previous || !this.following) {
      // Previous-instance fetch or paused user intent: no auto-reconnect.
      this.status = "ended";
      return;
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#retryTimer !== null) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1000 * 2 ** (this.reconnectAttempt - 1));
    this.status = "reconnecting";
    this.nextRetryAt = Date.now() + delay;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.nextRetryAt = null;
      void this.#start();
    }, delay);
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
    this.ring.append(this.#pending);
    this.#pending = [];
    if (this.following) this.seenCount = this.ring.totalAppended;
  }

  async switchContainer(name: string): Promise<void> {
    if (name === this.container) return;
    this.container = name;
    this.#resetBuffer();
    await this.#start();
  }

  async setPrevious(on: boolean): Promise<void> {
    if (on === this.previous) return;
    this.previous = on;
    this.#resetBuffer();
    await this.#start();
  }

  async setTail(n: number): Promise<void> {
    if (n === this.tailLines) return;
    this.tailLines = n;
    this.#resetBuffer();
    await this.#start();
  }

  /** Spec: loading history pauses follow. */
  async loadEarlier(): Promise<void> {
    this.following = false;
    this.tailLines = Math.min(RING_CAP, this.tailLines + 500);
    this.#resetBuffer();
    await this.#start();
  }

  toggleFollow(): void {
    this.following = !this.following;
    if (this.following) {
      this.markSeen();
      // The stream ended while paused (not a previous-instance fetch):
      // resuming follow should resume streaming, not sit on a dead session.
      if (this.status === "ended" && !this.previous) void this.#start();
    }
  }

  markSeen(): void {
    this.seenCount = this.ring.totalAppended;
  }

  /** Reconnect immediately instead of waiting out the backoff (Task 3). */
  retryNow(): void {
    if (this.#retryTimer === null) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.nextRetryAt = null;
    void this.#start();
  }

  clear(): void {
    this.ring.clear();
    this.#pending = [];
  }

  #resetBuffer(): void {
    this.ring.clear();
    this.#pending = [];
    this.#lastTime = undefined;
    this.seenCount = 0;
  }

  async #teardownStream(): Promise<void> {
    this.#stopFlushTimer();
    for (const un of this.#unlisteners) un();
    this.#unlisteners = [];
    const id = this.#streamId;
    this.#streamId = null;
    if (id) {
      try {
        await stopLogs(id);
      } catch {
        // Backend may already have dropped the stream.
      }
    }
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
      this.nextRetryAt = null;
    }
  }

  async close(): Promise<void> {
    this.#generation++;
    await this.#teardownStream();
  }
}
