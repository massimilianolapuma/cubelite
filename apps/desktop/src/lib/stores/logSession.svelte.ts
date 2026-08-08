/**
 * One log-panel session: container choice, stream lifecycle, bounded ring
 * buffer with batched flush (FLUSH_MS pattern from logs.svelte.ts).
 * Stream lifecycle (connect, tag, reconnect-on-drop with exponential
 * backoff, teardown) lives in ContainerStream; this class aggregates over
 * its (currently single) sub-stream.
 */
import { getPodContainers, type ContainerDetail, type LogLine } from "$lib/tauri";
import { errorMessage } from "$lib/errors";
import { app } from "./app.svelte";
import { LogRing } from "./logRing.svelte";
import { FLUSH_MS } from "./logs.svelte";
import { ContainerStream, type StreamParams, type StreamStatus } from "./containerStream.svelte";

export const RING_CAP = 5000;
export const DEFAULT_TAIL = 500;

export type SessionStatus = StreamStatus; // unchanged union, re-exported for callers

export class LogSession {
  readonly key: string;
  readonly namespace: string;
  readonly pod: string;

  containers = $state<ContainerDetail[]>([]);
  container = $state<string | null>(null);
  previous = $state(false);
  following = $state(true);
  tailLines = $state(DEFAULT_TAIL);
  seenCount = $state(0);
  ring = new LogRing(RING_CAP);

  #streams = $state<ContainerStream[]>([]);
  #openError = $state<string | null>(null);
  #pending: LogLine[] = [];
  #flushTimer: ReturnType<typeof setInterval> | null = null;

  /** Aggregate over sub-streams (single mode: exactly one). Order matters. */
  status = $derived.by((): SessionStatus => {
    if (this.#openError !== null) return "error";
    const st = this.#streams.map((s) => s.status);
    if (st.length === 0) return "connecting";
    if (st.includes("streaming")) return "streaming";
    if (st.includes("connecting")) return "connecting";
    if (st.includes("reconnecting")) return "reconnecting";
    if (st.every((s) => s === "error")) return "error";
    return "ended";
  });
  error = $derived(this.#openError ?? this.#streams.find((s) => s.error)?.error ?? null);
  nextRetryAt = $derived.by(() => {
    const ts = this.#streams.map((s) => s.nextRetryAt).filter((t): t is number => t !== null);
    return ts.length ? Math.min(...ts) : null;
  });
  reconnectAttempt = $derived(Math.max(0, ...this.#streams.map((s) => s.reconnectAttempt)));

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
      this.#openError = errorMessage(e);
      return;
    }
    await this.#start();
  }

  #receive = (lines: LogLine[]): void => {
    this.#pending.push(...lines);
    this.#scheduleFlush();
  };

  #streamParams = (): StreamParams => ({
    previous: this.previous,
    tailLines: this.tailLines,
    autoReconnect: !this.previous && this.following,
  });

  async #start(): Promise<void> {
    this.#openError = null;
    await this.#stopStreams();
    this.#streams = [
      new ContainerStream(this.namespace, this.pod, this.container, this.#receive, this.#streamParams),
    ];
    await Promise.all(this.#streams.map((s) => s.start()));
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

  /** Reconnect immediately instead of waiting out the backoff. */
  retryNow(): void {
    for (const s of this.#streams) s.retryNow();
  }

  clear(): void {
    this.ring.clear();
    this.#pending = [];
  }

  #resetBuffer(): void {
    this.ring.clear();
    this.#pending = [];
    this.seenCount = 0;
  }

  async #stopStreams(): Promise<void> {
    this.#stopFlushTimer();
    const streams = this.#streams;
    this.#streams = [];
    await Promise.all(streams.map((s) => s.stop()));
  }

  async close(): Promise<void> {
    await this.#stopStreams();
  }
}
