/**
 * One log-panel session: container choice, stream lifecycle, bounded ring
 * buffer with batched flush (FLUSH_MS pattern from logs.svelte.ts).
 * Stream lifecycle (connect, tag, reconnect-on-drop with exponential
 * backoff, teardown) lives in ContainerStream; this class aggregates over
 * its sub-streams — exactly one in single-container mode, one per pod
 * container (init included) when `container === ALL_CONTAINERS`.
 */
import { getPodContainers, type ContainerDetail, type LogLine } from "$lib/tauri";
import { errorMessage } from "$lib/errors";
import { app } from "./app.svelte";
import { LogRing } from "./logRing.svelte";
import { FLUSH_MS } from "./logs.svelte";
import { ContainerStream, type StreamParams, type StreamStatus } from "./containerStream.svelte";
import type { KeyedLogLine } from "./logs.svelte";

export const RING_CAP = 5000;
export const DEFAULT_TAIL = 500;

/** Sentinel container value: merged stream of every container in the pod. */
export const ALL_CONTAINERS = "*";

export type SessionStatus = StreamStatus; // unchanged union, re-exported for callers

/** One-shot state handoff for the pop-out window (#298): ring contents plus
 * the stream settings the receiving side must adopt before opening. */
export type SessionSeed = {
  lines: KeyedLogLine[];
  previous: boolean;
  tailLines: number;
  following: boolean;
};

export class LogSession {
  readonly key: string;
  readonly namespace: string;
  readonly pod: string;

  containers = $state<ContainerDetail[]>([]);
  container = $state<string | null>(null);
  /** Merged "all containers" mode: one ContainerStream per pod container. */
  merged = $derived(this.container === ALL_CONTAINERS);
  previous = $state(false);
  following = $state(true);
  tailLines = $state(DEFAULT_TAIL);
  seenCount = $state(0);
  ring = new LogRing(RING_CAP);

  #streams = $state<ContainerStream[]>([]);
  #openError = $state<string | null>(null);
  #pending: LogLine[] = [];
  #flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Bumped on every (re)start/close so a superseded #start() can't clobber a newer one's streams. */
  #generation = 0;
  /** sinceTime for the first stream start; set once from the seed. */
  #initialSinceTime: string | undefined;

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

  constructor(
    namespace: string,
    pod: string,
    initialContainer: string | null = null,
    seed?: SessionSeed,
  ) {
    this.namespace = namespace;
    this.pod = pod;
    this.key = `${namespace}/${pod}`;
    this.container = initialContainer;
    if (seed) {
      this.previous = seed.previous;
      this.tailLines = seed.tailLines;
      this.following = seed.following;
      this.ring.append(seed.lines);
      this.seenCount = this.ring.totalAppended;
      this.#initialSinceTime = [...seed.lines].reverse().find((l) => l.time)?.time ?? undefined;
    }
  }

  async open(): Promise<void> {
    const kc = app.kubeconfigPath;
    const ctx = app.activeCluster ?? undefined;
    try {
      this.containers = await getPodContainers(kc, this.namespace, this.pod, ctx);
      if (
        this.container !== ALL_CONTAINERS &&
        (!this.container || !this.containers.some((c) => c.name === this.container))
      ) {
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
    const generation = ++this.#generation;
    this.#openError = null;
    await this.#stopStreams();
    if (generation !== this.#generation) return;
    const targets = this.merged ? this.containers.map((c) => c.name) : [this.container];
    const initialSince = this.#initialSinceTime;
    this.#initialSinceTime = undefined;
    const streams = targets.map(
      (name) =>
        new ContainerStream(
          this.namespace,
          this.pod,
          name,
          this.#receive,
          this.#streamParams,
          () => this.#flush(),
          initialSince,
        ),
    );
    this.#streams = streams;
    await Promise.all(streams.map((s) => s.start()));
    if (generation !== this.#generation) {
      // Superseded mid-flight by a newer #start()/close(): stop what we just created.
      if (this.#streams === streams) this.#streams = [];
      await Promise.all(streams.map((s) => s.stop()));
    }
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
    if (name === ALL_CONTAINERS) this.previous = false; // previous-instance has no meaning on a merged stream
    this.container = name;
    this.#resetBuffer();
    await this.#start();
  }

  async setPrevious(on: boolean): Promise<void> {
    if (this.merged) return; // previous-instance has no meaning on a merged stream
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
      // Any sub-stream that ended while paused (not a previous-instance
      // fetch) should resume streaming, not sit dead — even if other
      // sub-streams kept the aggregate status "streaming" (merged mode).
      if (!this.previous) {
        for (const s of this.#streams) {
          if (s.status === "ended") void s.start();
        }
      }
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
    this.#flush();
    this.#stopFlushTimer();
    const streams = this.#streams;
    this.#streams = [];
    await Promise.all(streams.map((s) => s.stop()));
  }

  async close(): Promise<void> {
    this.#generation++;
    await this.#stopStreams();
  }
}
