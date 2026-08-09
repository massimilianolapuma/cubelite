/**
 * Lifecycle of ONE pod-container log stream: start, tag, reconnect with
 * exponential backoff (1s doubling to 30s cap), teardown. Extracted from
 * LogSession so merged "all containers" mode can run N of these in parallel.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { stopLogs, streamPodLog, type LogLine } from "$lib/tauri";
import { errorMessage } from "$lib/errors";
import { app } from "./app.svelte";

export type StreamStatus = "connecting" | "streaming" | "reconnecting" | "ended" | "error";

export type StreamParams = {
  previous: boolean;
  tailLines: number;
  /** false when previous-instance fetch or user paused follow: end instead of retrying. */
  autoReconnect: boolean;
};

export class ContainerStream {
  status = $state<StreamStatus>("connecting");
  error = $state<string | null>(null);
  reconnectAttempt = $state(0);
  nextRetryAt = $state<number | null>(null);

  readonly namespace: string;
  readonly pod: string;
  readonly container: string | null;

  #onLines: (lines: LogLine[]) => void;
  #params: () => StreamParams;
  #onEndCallback: () => void;
  #streamId: string | null = null;
  #unlisteners: UnlistenFn[] = [];
  #lastTime: string | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every (re)start so stale async callbacks become no-ops. */
  #generation = 0;

  constructor(
    namespace: string,
    pod: string,
    container: string | null,
    onLines: (lines: LogLine[]) => void,
    params: () => StreamParams,
    /** Called synchronously right before the status transition on stream end (e.g. to force a final flush). */
    onEnd: () => void = () => {},
  ) {
    this.namespace = namespace;
    this.pod = pod;
    this.container = container;
    this.#onLines = onLines;
    this.#params = params;
    this.#onEndCallback = onEnd;
  }

  async start(): Promise<void> {
    const generation = ++this.#generation;
    await this.#teardown();
    if (generation !== this.#generation) return;
    this.status = "connecting";
    this.error = null;
    const { previous, tailLines } = this.#params();
    try {
      const id = await streamPodLog(
        app.kubeconfigPath,
        this.namespace,
        this.pod,
        {
          container: this.container ?? undefined,
          previous,
          tailLines,
          sinceTime: this.#lastTime,
        },
        app.activeCluster ?? undefined,
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
          this.#onLines([
            this.container ? { ...event.payload, container: this.container } : event.payload,
          ]);
        }),
        await listen(`pod-log-end:${id}`, () => {
          if (generation !== this.#generation) return;
          this.#onEnd();
        }),
      );
      this.status = "streaming";
    } catch (e) {
      if (generation !== this.#generation) return;
      this.status = "error";
      this.error = errorMessage(e);
    }
  }

  #onEnd(): void {
    this.#onEndCallback();
    if (!this.#params().autoReconnect) {
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
      void this.start();
    }, delay);
  }

  /** Reconnect immediately instead of waiting out the backoff. No-op unless waiting. */
  retryNow(): void {
    if (this.#retryTimer === null) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.nextRetryAt = null;
    void this.start();
  }

  async #teardown(): Promise<void> {
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

  async stop(): Promise<void> {
    this.#generation++;
    await this.#teardown();
  }
}
