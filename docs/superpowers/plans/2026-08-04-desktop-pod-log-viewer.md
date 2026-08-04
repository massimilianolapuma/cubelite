# Desktop Pod Log Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-pod log panel (IDE-console pattern) in the Tauri desktop app, at parity with the macOS panel — issue #295.

**Architecture:** Frontend-only except one new `export_log` Tauri command: the Rust streaming commands (`stream_pod_log`, `get_pod_containers`, `stop_logs`) and their TS bindings already exist and are unused. New Svelte 5 runes stores (`logPanel`, `LogSession`, `LogSearch`) drive a bottom panel mounted in `+page.svelte`; the list is virtualized with `@tanstack/svelte-virtual`.

**Tech Stack:** Svelte 5 (runes), Tailwind v4 + Design System v1 tokens, Tauri v2, vitest (jsdom), Playwright (tauri-mock IPC), Rust (one command).

**Specs:** `docs/superpowers/specs/2026-08-04-desktop-pod-log-viewer-design.md` (this plan's contract) and `docs/superpowers/specs/2026-07-15-pod-log-viewer-design.md` (UX source of truth).

## Global Constraints

- Ring buffer cap **5000** lines; batched reactive flush every **120 ms** (`FLUSH_MS` pattern from `logs.svelte.ts`).
- Search debounce **150 ms**, precomputed match ids off the render path.
- Tail options **100/500/1000/5000, default 500**.
- Panel default height **280 px**, drag-resize **160–560 px**, collapsed height **34 px**, shortcut **mod+L**.
- Reconnect backoff `min(30_000, 1000 * 2^(attempt-1))` ms; attempt counter resets on first received line; `since_time` = timestamp of last received line.
- Timestamps always requested on the wire; the toggle is render-only. Timestamp column **94 px**.
- Export filenames `<pod>_<container>[_full].log` into `~/Downloads`.
- localStorage keys use the existing `cubelite.` prefix via `persisted()` from `settings.svelte.ts`.
- All colors/typography via existing tokens (`type-caption`, `text-text-*`, `bg-surface-*`, `var(--color-status-*)`, `focus-ring`) — no new tokens, no hex literals. Icons: Lucide, 1.5 px stroke.
- Tests: `pnpm --filter desktop exec vitest run <file>` for singles, `pnpm --filter desktop test` for the suite. Tauri IPC in unit tests is mocked with `vi.mock("$lib/tauri")` / `vi.mock("@tauri-apps/api/event")` following `logs.svelte.test.ts`.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Pushes use the `massilp` credential-helper override; PRs via `GH_TOKEN=$(gh auth token --user massilp) gh pr create` with `--body-file`.

**PR stack:** Task 1–7 → PR 1 `feat/desktop-logpanel-core` (base `main`). Task 8–10 → PR 2 `feat/desktop-logpanel-search` (base PR 1). Task 11–13 → PR 3 `feat/desktop-logpanel-tabs` (base PR 2). Task 14–18 → PR 4 `feat/desktop-logpanel-entry-export` (base PR 3).

---

### Task 1: LogRing — bounded ring buffer

**Files:**
- Create: `apps/desktop/src/lib/stores/logRing.svelte.ts`
- Test: `apps/desktop/src/lib/stores/logRing.svelte.test.ts`

**Interfaces:**
- Consumes: `KeyedLogLine` from `$lib/stores/logs.svelte` (`LogLine & { id: number }`).
- Produces: `class LogRing { constructor(cap: number); lines: KeyedLogLine[]; totalAppended: number; append(batch: LogLine[]): void; clear(): void }` — `append` assigns ids internally and keeps at most `cap` lines; `totalAppended` is monotonic (drives the new-lines pill).

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/lib/stores/logRing.svelte.test.ts
import { describe, expect, it } from "vitest";
import { LogRing } from "./logRing.svelte";
import type { LogLine } from "$lib/tauri";

function line(message: string): LogLine {
  return { pod: "api-0", namespace: "default", time: "2026-08-04T10:00:00Z", level: "info", message };
}

describe("LogRing", () => {
  it("appends batches with stable increasing ids", () => {
    const ring = new LogRing(10);
    ring.append([line("a"), line("b")]);
    ring.append([line("c")]);
    expect(ring.lines.map((l) => l.message)).toEqual(["a", "b", "c"]);
    expect(ring.lines.map((l) => l.id)).toEqual([0, 1, 2]);
    expect(ring.totalAppended).toBe(3);
  });

  it("evicts oldest lines beyond cap but totalAppended keeps counting", () => {
    const ring = new LogRing(3);
    ring.append([line("a"), line("b"), line("c"), line("d"), line("e")]);
    expect(ring.lines.map((l) => l.message)).toEqual(["c", "d", "e"]);
    expect(ring.totalAppended).toBe(5);
  });

  it("clear empties lines without resetting id sequence", () => {
    const ring = new LogRing(3);
    ring.append([line("a")]);
    ring.clear();
    ring.append([line("b")]);
    expect(ring.lines).toHaveLength(1);
    expect(ring.lines[0].id).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop exec vitest run src/lib/stores/logRing.svelte.test.ts`
Expected: FAIL — `Cannot find module './logRing.svelte'`

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/lib/stores/logRing.svelte.ts
/**
 * Bounded reactive ring buffer for one log session (spec cap: 5000).
 * `totalAppended` is monotonic so the "↓ N new lines" pill can count
 * arrivals even after eviction.
 */
import type { LogLine } from "$lib/tauri";
import type { KeyedLogLine } from "./logs.svelte";

export class LogRing {
  lines = $state<KeyedLogLine[]>([]);
  totalAppended = $state(0);
  readonly cap: number;
  #nextId = 0;

  constructor(cap: number) {
    this.cap = cap;
  }

  append(batch: LogLine[]): void {
    if (batch.length === 0) return;
    const keyed = batch.map((l) => ({ ...l, id: this.#nextId++ }));
    this.lines = [...this.lines, ...keyed].slice(-this.cap);
    this.totalAppended += batch.length;
  }

  clear(): void {
    this.lines = [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop exec vitest run src/lib/stores/logRing.svelte.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/stores/logRing.svelte.ts apps/desktop/src/lib/stores/logRing.svelte.test.ts
git commit -m "feat(desktop): LogRing bounded buffer for log panel sessions"
```

---

### Task 2: LogSession — stream lifecycle core

**Files:**
- Create: `apps/desktop/src/lib/stores/logSession.svelte.ts`
- Test: `apps/desktop/src/lib/stores/logSession.svelte.test.ts`

**Interfaces:**
- Consumes: `LogRing` (Task 1); `streamPodLog(kc, ns, pod, opts, ctx)`, `getPodContainers(kc, ns, pod, ctx)`, `stopLogs(id)`, types `LogLine`, `ContainerDetail`, `PodLogStreamOptions` from `$lib/tauri`; `listen` from `@tauri-apps/api/event`; `app` store (`kubeconfigPath`, `activeCluster`); `errorMessage` from `$lib/errors`.
- Produces:

```ts
export type SessionStatus = "connecting" | "streaming" | "reconnecting" | "ended" | "error";
export class LogSession {
  readonly key: string;            // `${namespace}/${pod}`
  readonly namespace: string;
  readonly pod: string;
  containers: ContainerDetail[];   // $state
  container: string | null;        // $state — null until containers load
  previous: boolean;               // $state
  following: boolean;              // $state
  status: SessionStatus;           // $state
  error: string | null;            // $state
  reconnectAttempt: number;        // $state
  nextRetryAt: number | null;      // $state, epoch ms of next retry
  tailLines: number;               // $state, default 500
  seenCount: number;               // $state — ring.totalAppended at last "seen" mark (pill baseline)
  ring: LogRing;                   // cap 5000
  constructor(namespace: string, pod: string, initialContainer?: string | null);
  open(): Promise<void>;           // fetch containers, pick default, start stream
  switchContainer(name: string): Promise<void>;
  setPrevious(on: boolean): Promise<void>;
  setTail(n: number): Promise<void>;
  loadEarlier(): Promise<void>;    // tail += 500, restart, pauses follow
  toggleFollow(): void;
  markSeen(): void;                // seenCount = ring.totalAppended
  retryNow(): void;
  clear(): void;
  close(): Promise<void>;
}
```

- The reconnect loop itself lands in Task 3; this task ends the stream with `status = "ended"` on `pod-log-end`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/lib/stores/logSession.svelte.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLine } from "$lib/tauri";

const listeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));

vi.mock("$lib/tauri", async (importOriginal) => {
  const original = await importOriginal<typeof import("$lib/tauri")>();
  return {
    ...original,
    streamPodLog: vi.fn(async () => "7"),
    stopLogs: vi.fn(async () => {}),
    getPodContainers: vi.fn(async () => [
      { name: "worker", init: false, sidecar: false, restarts: 0, ready: true, state: "running", state_reason: null, last_terminated_reason: null, last_terminated_at: null },
      { name: "istio-init", init: true, sidecar: false, restarts: 2, ready: true, state: "terminated", state_reason: null, last_terminated_reason: null, last_terminated_at: null },
    ]),
  };
});

import { getPodContainers, streamPodLog, stopLogs } from "$lib/tauri";
import { app } from "./app.svelte";
import { LogSession } from "./logSession.svelte";

function emitLine(streamId: string, message: string, time = "2026-08-04T10:00:00Z") {
  const payload: LogLine = { pod: "api-0", namespace: "default", time, level: "info", message };
  listeners.get(`pod-log-line:${streamId}`)?.({ payload });
}

describe("LogSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    vi.clearAllMocks();
    app.kubeconfigPath = "/tmp/kubeconfig";
    app.activeCluster = "prod";
  });
  afterEach(() => vi.useRealTimers());

  it("open() loads containers, defaults to first non-init, streams with tail 500", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    expect(getPodContainers).toHaveBeenCalledWith("/tmp/kubeconfig", "default", "api-0", "prod");
    expect(s.container).toBe("worker");
    expect(streamPodLog).toHaveBeenCalledWith(
      "/tmp/kubeconfig", "default", "api-0",
      { container: "worker", previous: false, tailLines: 500, sinceTime: undefined },
      "prod",
    );
    expect(s.status).toBe("streaming");
  });

  it("batches incoming lines into the ring on the flush interval", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    emitLine("7", "one");
    emitLine("7", "two");
    expect(s.ring.lines).toHaveLength(0); // not flushed yet
    await vi.advanceTimersByTimeAsync(130);
    expect(s.ring.lines.map((l) => l.message)).toEqual(["one", "two"]);
  });

  it("switchContainer restarts the stream with the new container and clears the buffer", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    emitLine("7", "old");
    await vi.advanceTimersByTimeAsync(130);
    await s.switchContainer("istio-init");
    expect(stopLogs).toHaveBeenCalledWith("7");
    expect(s.ring.lines).toHaveLength(0);
    expect(vi.mocked(streamPodLog).mock.lastCall?.[3]).toMatchObject({ container: "istio-init" });
  });

  it("previous fetch does not follow and ends as 'ended' on pod-log-end", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    await s.setPrevious(true);
    expect(vi.mocked(streamPodLog).mock.lastCall?.[3]).toMatchObject({ previous: true });
    listeners.get("pod-log-end:7")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1);
    expect(s.status).toBe("ended");
  });

  it("close() stops the stream and detaches listeners", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    await s.close();
    expect(stopLogs).toHaveBeenCalledWith("7");
    expect(listeners.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop exec vitest run src/lib/stores/logSession.svelte.test.ts`
Expected: FAIL — `Cannot find module './logSession.svelte'`

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/lib/stores/logSession.svelte.ts
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

  /** Task 3 replaces this with reconnect-with-backoff for live follows. */
  #onStreamEnd(): void {
    this.#flush();
    this.status = "ended";
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
    if (this.following) this.markSeen();
  }

  markSeen(): void {
    this.seenCount = this.ring.totalAppended;
  }

  /** Reconnect immediately instead of waiting out the backoff (Task 3). */
  retryNow(): void {}

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
  }

  async close(): Promise<void> {
    this.#generation++;
    await this.#teardownStream();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop exec vitest run src/lib/stores/logSession.svelte.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/stores/logSession.svelte.ts apps/desktop/src/lib/stores/logSession.svelte.test.ts
git commit -m "feat(desktop): LogSession stream lifecycle for the log panel"
```

---

### Task 3: LogSession — reconnect with backoff

**Files:**
- Modify: `apps/desktop/src/lib/stores/logSession.svelte.ts` (replace `#onStreamEnd`, `retryNow`)
- Test: `apps/desktop/src/lib/stores/logSession.svelte.test.ts` (append describe block)

**Interfaces:**
- Consumes: Task 2's `LogSession` internals.
- Produces: live-follow drops schedule `#start()` after `min(30_000, 1000 * 2^(attempt-1))` ms; `status === "reconnecting"`, `reconnectAttempt` increments, `nextRetryAt` set (epoch ms); `retryNow()` cancels the timer and restarts immediately; previous-fetch end still lands on `"ended"`; the restarted stream passes `sinceTime` = last received line time.

- [ ] **Step 1: Write the failing tests** (append to the existing file)

```ts
describe("LogSession reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    vi.clearAllMocks();
    app.kubeconfigPath = "/tmp/kubeconfig";
    app.activeCluster = "prod";
  });
  afterEach(() => vi.useRealTimers());

  it("server drop while following → reconnecting with 1s backoff, resumes from last timestamp", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    emitLine("7", "one", "2026-08-04T10:00:05Z");
    await vi.advanceTimersByTimeAsync(130);
    listeners.get("pod-log-end:7")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1);
    expect(s.status).toBe("reconnecting");
    expect(s.reconnectAttempt).toBe(1);
    expect(s.nextRetryAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(streamPodLog).mock.lastCall?.[3]).toMatchObject({
      sinceTime: "2026-08-04T10:00:05Z",
    });
    expect(s.status).toBe("streaming");
  });

  it("backoff doubles per attempt and caps at 30s", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    for (let attempt = 1; attempt <= 7; attempt++) {
      listeners.get("pod-log-end:7")?.({ payload: undefined });
      await vi.advanceTimersByTimeAsync(1);
      expect(s.reconnectAttempt).toBe(attempt);
      const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      await vi.advanceTimersByTimeAsync(delay);
      expect(s.status).toBe("streaming");
    }
  });

  it("a received line resets the attempt counter", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    listeners.get("pod-log-end:7")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1001);
    expect(s.reconnectAttempt).toBe(1);
    emitLine("7", "back");
    expect(s.reconnectAttempt).toBe(0);
  });

  it("retryNow() short-circuits the backoff", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    listeners.get("pod-log-end:7")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1);
    listeners.get("pod-log-end:7")?.({ payload: undefined });
    // second drop arrives before restart: still one scheduled retry
    s.retryNow();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.status).toBe("streaming");
  });

  it("close() during backoff cancels the scheduled retry", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    listeners.get("pod-log-end:7")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1);
    await s.close();
    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(streamPodLog).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify the new block fails**

Run: `pnpm --filter desktop exec vitest run src/lib/stores/logSession.svelte.test.ts`
Expected: FAIL — drop leads to `status "ended"`, no reconnect

- [ ] **Step 3: Implement**

Replace `#onStreamEnd` and `retryNow` in `logSession.svelte.ts`, add the timer field:

```ts
  #retryTimer: ReturnType<typeof setTimeout> | null = null;

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

  retryNow(): void {
    if (this.#retryTimer === null) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.nextRetryAt = null;
    void this.#start();
  }
```

And extend `#teardownStream` to also cancel the retry timer:

```ts
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
      this.nextRetryAt = null;
    }
```

Note: `status = "ended"` must not be overwritten by pause — when the user pauses (`following = false`) an in-flight reconnect keeps running; only a drop that arrives while paused ends the session (matches macOS behavior where pause is render-side only — the wire keeps following; here the reconnect decision reads `following` at drop time).

- [ ] **Step 4: Run the whole session test file**

Run: `pnpm --filter desktop exec vitest run src/lib/stores/logSession.svelte.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/stores/logSession.svelte.ts apps/desktop/src/lib/stores/logSession.svelte.test.ts
git commit -m "feat(desktop): log session reconnect with exponential backoff"
```

---

### Task 4: logPanel store — single session + persisted prefs

**Files:**
- Modify: `apps/desktop/src/lib/stores/settings.svelte.ts` (export `persisted`)
- Create: `apps/desktop/src/lib/stores/logPanel.svelte.ts`
- Test: `apps/desktop/src/lib/stores/logPanel.svelte.test.ts`

**Interfaces:**
- Consumes: `LogSession` (Task 2/3); `persisted<T>(key, fallback, validate)` from `settings.svelte.ts` (change `function persisted` to `export function persisted`).
- Produces:

```ts
export const PANEL_MIN = 160, PANEL_MAX = 560, PANEL_DEFAULT = 280, PANEL_COLLAPSED = 34;
class LogPanelStore {
  sessions: LogSession[];            // $state, PR 1: length <= 1 (multi in PR 3)
  activeKey: string | null;          // $state
  get active(): LogSession | null;
  collapsed: boolean;                // persisted "logPanel.collapsed"
  height: number;                    // persisted "logPanel.height", clamped 160–560
  timestamps: boolean;               // persisted "logPanel.timestamps", default true
  wrap: boolean;                     // persisted "logPanel.wrap", default false
  get open(): boolean;               // sessions.length > 0
  openFor(pod: { namespace: string; name: string }): Promise<void>; // create or focus; PR 1 closes any other session first
  closeSession(key: string): Promise<void>;
  toggleCollapsed(): void;
}
export const logPanel = new LogPanelStore();
```

- Container memory (`logPanel.containers` persisted record `namespace/pod → container`) — written on `switchContainer` via `rememberContainer(key, name)`, read in `openFor`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/lib/stores/logPanel.svelte.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));
vi.mock("$lib/tauri", async (importOriginal) => {
  const original = await importOriginal<typeof import("$lib/tauri")>();
  return {
    ...original,
    streamPodLog: vi.fn(async () => "9"),
    stopLogs: vi.fn(async () => {}),
    getPodContainers: vi.fn(async () => [
      { name: "worker", init: false, sidecar: false, restarts: 0, ready: true, state: "running", state_reason: null, last_terminated_reason: null, last_terminated_at: null },
      { name: "envoy", init: false, sidecar: true, restarts: 0, ready: true, state: "running", state_reason: null, last_terminated_reason: null, last_terminated_at: null },
    ]),
  };
});

import { app } from "./app.svelte";
import { logPanel, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN } from "./logPanel.svelte";

describe("logPanel store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    app.kubeconfigPath = "/tmp/kubeconfig";
    app.activeCluster = "prod";
  });
  afterEach(async () => {
    for (const s of [...logPanel.sessions]) await logPanel.closeSession(s.key);
  });

  it("openFor creates a session and focuses it; a second pod replaces it (single-session PR)", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    expect(logPanel.open).toBe(true);
    expect(logPanel.activeKey).toBe("default/api-0");
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    expect(logPanel.sessions).toHaveLength(1);
    expect(logPanel.activeKey).toBe("default/web-1");
  });

  it("openFor on the already-open pod focuses without restarting the stream", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    const calls = vi.mocked((await import("$lib/tauri")).streamPodLog).mock.calls.length;
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    expect(vi.mocked((await import("$lib/tauri")).streamPodLog).mock.calls.length).toBe(calls);
  });

  it("remembers the container choice per pod across reopen", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    await logPanel.active!.switchContainer("envoy");
    logPanel.rememberContainer("default/api-0", "envoy");
    await logPanel.closeSession("default/api-0");
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    expect(logPanel.active!.container).toBe("envoy");
  });

  it("height persists clamped to bounds", () => {
    logPanel.height = 9999;
    expect(logPanel.height).toBe(PANEL_MAX);
    logPanel.height = 10;
    expect(logPanel.height).toBe(PANEL_MIN);
    logPanel.height = PANEL_DEFAULT;
    expect(JSON.parse(window.localStorage.getItem("cubelite.logPanel.height")!)).toBe(PANEL_DEFAULT);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop exec vitest run src/lib/stores/logPanel.svelte.test.ts`
Expected: FAIL — `Cannot find module './logPanel.svelte'`

- [ ] **Step 3: Implement**

In `settings.svelte.ts` change the declaration only:

```ts
export function persisted<T>(
```

```ts
// apps/desktop/src/lib/stores/logPanel.svelte.ts
/**
 * Shell-level owner of the log panel: open sessions, active tab, panel
 * chrome (height/collapse) and render toggles, persisted via `persisted()`.
 * PR feat/desktop-logpanel-core keeps a single session; the tab strip PR
 * lifts that restriction.
 */
import { persisted } from "./settings.svelte";
import { LogSession } from "./logSession.svelte";

export const PANEL_MIN = 160;
export const PANEL_MAX = 560;
export const PANEL_DEFAULT = 280;
export const PANEL_COLLAPSED = 34;

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === "string");

class LogPanelStore {
  sessions = $state<LogSession[]>([]);
  activeKey = $state<string | null>(null);

  #height = persisted<number>("logPanel.height", PANEL_DEFAULT, isNumber);
  #collapsed = persisted<boolean>("logPanel.collapsed", false, isBoolean);
  #timestamps = persisted<boolean>("logPanel.timestamps", true, isBoolean);
  #wrap = persisted<boolean>("logPanel.wrap", false, isBoolean);
  /** `namespace/pod` → last chosen container. */
  #containers = persisted<Record<string, string>>("logPanel.containers", {}, isStringRecord);

  get active(): LogSession | null {
    return this.sessions.find((s) => s.key === this.activeKey) ?? null;
  }

  get open(): boolean {
    return this.sessions.length > 0;
  }

  get height(): number {
    return Math.min(PANEL_MAX, Math.max(PANEL_MIN, this.#height.value));
  }
  set height(v: number) {
    this.#height.value = Math.min(PANEL_MAX, Math.max(PANEL_MIN, v));
  }

  get collapsed(): boolean {
    return this.#collapsed.value;
  }
  toggleCollapsed(): void {
    this.#collapsed.value = !this.#collapsed.value;
  }

  get timestamps(): boolean {
    return this.#timestamps.value;
  }
  set timestamps(v: boolean) {
    this.#timestamps.value = v;
  }

  get wrap(): boolean {
    return this.#wrap.value;
  }
  set wrap(v: boolean) {
    this.#wrap.value = v;
  }

  rememberContainer(key: string, container: string): void {
    this.#containers.value = { ...this.#containers.value, [key]: container };
  }

  async openFor(pod: { namespace: string; name: string }): Promise<void> {
    const key = `${pod.namespace}/${pod.name}`;
    const existing = this.sessions.find((s) => s.key === key);
    if (existing) {
      this.activeKey = key;
      return;
    }
    // Single-session PR: replace whatever is open.
    for (const s of [...this.sessions]) await this.closeSession(s.key);
    const session = new LogSession(pod.namespace, pod.name, this.#containers.value[key] ?? null);
    this.sessions = [...this.sessions, session];
    this.activeKey = key;
    await session.open();
  }

  async closeSession(key: string): Promise<void> {
    const session = this.sessions.find((s) => s.key === key);
    if (!session) return;
    await session.close();
    this.sessions = this.sessions.filter((s) => s.key !== key);
    if (this.activeKey === key) this.activeKey = this.sessions.at(-1)?.key ?? null;
  }
}

export const logPanel = new LogPanelStore();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop exec vitest run src/lib/stores/logPanel.svelte.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full desktop suite (settings export ripple)**

Run: `pnpm --filter desktop test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/stores/logPanel.svelte.ts apps/desktop/src/lib/stores/logPanel.svelte.test.ts apps/desktop/src/lib/stores/settings.svelte.ts
git commit -m "feat(desktop): logPanel store — session ownership and persisted chrome"
```

---

### Task 5: LogBody + LogLineRow — virtualized list

**Files:**
- Modify: `apps/desktop/package.json` (add `@tanstack/svelte-virtual`)
- Create: `apps/desktop/src/lib/components/logpanel/LogLineRow.svelte`
- Create: `apps/desktop/src/lib/components/logpanel/LogBody.svelte`
- Test: `apps/desktop/src/lib/components/logpanel/log-body.test.ts`

**Interfaces:**
- Consumes: `logPanel` (Task 4), `LogSession` (`ring.lines`, `following`, `seenCount`, `status`, `error`, `toggleFollow`, `markSeen`, `retryNow`), `KeyedLogLine`.
- Produces:
  - `LogLineRow.svelte` props: `{ line: KeyedLogLine; timestamps: boolean; wrap: boolean }`.
  - `LogBody.svelte` props: `{ session: LogSession }` — virtualized scroller; autoscroll while following; wheel-up pauses; "↓ N new lines" pill (count = `ring.totalAppended - seenCount`) resumes on click; empty / cleared / start-failure states.

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter desktop add @tanstack/svelte-virtual`
Expected: lockfile + package.json updated, install clean.

- [ ] **Step 2: Write the failing component test**

```ts
// apps/desktop/src/lib/components/logpanel/log-body.test.ts
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte"; // ← use the same render helper as logs-view.test.ts; if that file uses @testing-library/svelte, mirror it exactly
import LogBody from "./LogBody.svelte";
import { LogSession } from "$lib/stores/logSession.svelte";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("$lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/tauri")>()),
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
}));

function sessionWith(messages: string[]): LogSession {
  const s = new LogSession("default", "api-0");
  s.ring.append(
    messages.map((m) => ({
      pod: "api-0", namespace: "default",
      time: "2026-08-04T10:00:00Z", level: "info", message: m,
    })),
  );
  s.markSeen();
  return s;
}

describe("LogBody", () => {
  it("renders rows for buffered lines", async () => {
    const { getByText } = render(LogBody, { session: sessionWith(["hello-log-line"]) });
    await expect.element(getByText("hello-log-line")).toBeInTheDocument();
  });

  it("shows the empty state when the buffer is empty", async () => {
    const { getByText } = render(LogBody, { session: sessionWith([]) });
    await expect.element(getByText("Waiting for log lines…")).toBeInTheDocument();
  });

  it("shows the new-lines pill when paused and lines arrive", async () => {
    const s = sessionWith(["a"]);
    s.toggleFollow(); // pause
    s.ring.append([{ pod: "api-0", namespace: "default", time: null, level: "info", message: "b" }]);
    const { getByText } = render(LogBody, { session: s });
    await expect.element(getByText("↓ 1 new line")).toBeInTheDocument();
  });
});
```

**Adapt the render import/assertions to the exact style of `logs-view.test.ts`** (same helper, same `expect` idiom) — do not introduce a second component-testing library.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter desktop exec vitest run src/lib/components/logpanel/log-body.test.ts`
Expected: FAIL — component missing

- [ ] **Step 4: Implement `LogLineRow.svelte`**

```svelte
<script lang="ts">
	import type { KeyedLogLine } from '$lib/stores/logs.svelte';
	import type { LogLevel } from '$lib/tauri';

	let { line, timestamps, wrap }: { line: KeyedLogLine; timestamps: boolean; wrap: boolean } =
		$props();

	const levelColor: Record<LogLevel, string> = {
		debug: 'var(--color-text-tertiary)',
		info: 'var(--color-status-info)',
		warn: 'var(--color-status-warn)',
		error: 'var(--color-status-err)'
	};

	function rowStyle(level: LogLevel): string {
		if (level === 'error')
			return 'border-left: 2px solid var(--color-status-err); background: var(--alpha-log-error-row);';
		if (level === 'warn')
			return 'border-left: 2px solid color-mix(in srgb, var(--color-status-warn) 50%, transparent); background: var(--alpha-log-warn-row);';
		return 'border-left: 2px solid transparent;';
	}

	function clock(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour12: false });
	}
</script>

<div class="flex items-baseline gap-2.5 px-2.5 py-px" style={rowStyle(line.level)}>
	{#if timestamps}
		<span class="w-[94px] shrink-0 font-mono text-[10.5px] text-text-disabled">{clock(line.time)}</span>
	{/if}
	<span
		class="w-[38px] shrink-0 font-mono text-[10px] font-semibold uppercase"
		style="color: {levelColor[line.level]};"
	>
		{line.level}
	</span>
	<span class="type-log text-text-log {wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'}">{line.message}</span>
</div>
```

- [ ] **Step 5: Implement `LogBody.svelte`**

```svelte
<script lang="ts">
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import LogLineRow from './LogLineRow.svelte';
	import { logPanel } from '$lib/stores/logPanel.svelte';
	import type { LogSession } from '$lib/stores/logSession.svelte';

	let { session }: { session: LogSession } = $props();

	let scrollEl = $state<HTMLDivElement | null>(null);

	const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => scrollEl,
		estimateSize: () => 18,
		overscan: 20
	});

	// Keep the virtualizer count in sync with the reactive buffer.
	$effect(() => {
		$virtualizer.setOptions({
			count: session.ring.lines.length,
			getScrollElement: () => scrollEl,
			estimateSize: () => 18,
			overscan: 20
		});
		$virtualizer.measure();
	});

	const newLines = $derived(session.ring.totalAppended - session.seenCount);

	// Autoscroll while following.
	$effect(() => {
		void session.ring.lines.length;
		if (session.following && scrollEl) {
			$virtualizer.scrollToIndex(session.ring.lines.length - 1, { align: 'end' });
		}
	});

	function onWheel(event: WheelEvent) {
		if (event.deltaY < 0 && session.following) {
			session.toggleFollow();
		}
	}

	function resume() {
		if (!session.following) session.toggleFollow();
	}
</script>

<div class="relative min-h-0 flex-1 overflow-hidden bg-surface-sunken">
	{#if !session.following && newLines > 0}
		<div class="pointer-events-auto absolute inset-x-0 bottom-2 z-10 flex justify-center">
			<button
				type="button"
				class="type-caption rounded-full px-2.5 py-1"
				style="background: var(--alpha-pill-warn); color: var(--color-status-warn);"
				onclick={resume}
			>
				↓ {newLines} new {newLines === 1 ? 'line' : 'lines'}
			</button>
		</div>
	{/if}

	{#if session.status === 'error'}
		<div class="flex h-full flex-col items-center justify-center gap-2">
			<p class="type-caption text-text-secondary">{session.error}</p>
			<button
				type="button"
				class="focus-ring type-caption rounded-md border border-border-default bg-surface-raised px-2.5 py-1 text-text-secondary hover:brightness-110"
				onclick={() => void session.open()}
			>
				Retry
			</button>
		</div>
	{:else if session.ring.lines.length === 0}
		<p class="py-8 text-center text-xs text-text-disabled">
			{session.status === 'connecting'
				? 'Connecting…'
				: session.ring.totalAppended > 0
					? 'Buffer cleared — waiting for new lines…'
					: 'Waiting for log lines…'}
		</p>
	{:else}
		<div bind:this={scrollEl} onwheel={onWheel} class="h-full overflow-y-auto py-1">
			<div style="height: {$virtualizer.getTotalSize()}px; position: relative;">
				{#each $virtualizer.getVirtualItems() as item (item.key)}
					{@const line = session.ring.lines[item.index]}
					<div
						data-index={item.index}
						use:measure={$virtualizer}
						style="position: absolute; top: 0; left: 0; width: 100%; transform: translateY({item.start}px);"
					>
						<LogLineRow {line} timestamps={logPanel.timestamps} wrap={logPanel.wrap} />
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<script module lang="ts">
	import type { Virtualizer } from '@tanstack/virtual-core';

	/** Svelte action wiring measureElement for variable row heights (wrap on). */
	function measure(node: HTMLElement, v: Virtualizer<HTMLDivElement, HTMLDivElement>) {
		v.measureElement(node);
		return {
			update(next: Virtualizer<HTMLDivElement, HTMLDivElement>) {
				next.measureElement(node);
			}
		};
	}
</script>
```

If `@tanstack/svelte-virtual`'s store-based API differs under Svelte 5 (`$virtualizer` autosubscription in runes mode), pin the working call shape from the package README at implementation time — keep `estimateSize` 18, `overscan` 20, `measureElement` for wrap.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter desktop exec vitest run src/lib/components/logpanel/log-body.test.ts`
Expected: PASS (3 tests). If jsdom lacks layout for the virtualizer (all items 0-height), mock `Element.getBoundingClientRect` in the test setup the way virtualization tests conventionally do, or assert on the rendered subset only.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/lib/components/logpanel/
git commit -m "feat(desktop): virtualized log body with follow/pause and new-lines pill"
```

---

### Task 6: LogToolbar + LogPanel chrome + mount + entry point

**Files:**
- Create: `apps/desktop/src/lib/components/logpanel/LogToolbar.svelte`
- Create: `apps/desktop/src/lib/components/logpanel/LogPanel.svelte`
- Modify: `apps/desktop/src/lib/keyboard.ts` (add `mod+L`)
- Modify: `apps/desktop/src/routes/+page.svelte` (mount panel, route shortcut)
- Modify: `apps/desktop/src/lib/components/pods/PodDrawer.svelte` (Logs button — bootstrap entry point)
- Test: `apps/desktop/src/lib/keyboard.test.ts` (extend; create if missing), `apps/desktop/src/lib/components/logpanel/log-toolbar.test.ts`

**Interfaces:**
- Consumes: `logPanel`, `LogSession` (Tasks 2–5).
- Produces:
  - `keyboard.ts`: new variant `{ type: "log-panel" }` returned for `mod+L`.
  - `LogToolbar.svelte` props `{ session: LogSession }`: container picker (running containers with restarts, then init containers, grouped), `⟲ previous` chip only when selected container `restarts > 0`, tail chip cycling 100/500/1000/5000 + "Load 500 earlier", ● Following/Paused button, overflow ⋯ menu (timestamps / wrap / clear).
  - `LogPanel.svelte` (no props): renders only when `logPanel.open`; height `logPanel.height` px (or 34 collapsed); drag handle on the top edge; close button per session ends it.
  - `PodDrawer` gains a "Logs" button calling `void logPanel.openFor({ namespace: pod.namespace, name: pod.name })`.

- [ ] **Step 1: Failing keyboard test**

Append (or create `apps/desktop/src/lib/keyboard.test.ts` if absent — check first; if `matchShortcut` tests live inside another spec file, extend that file instead):

```ts
import { describe, expect, it } from "vitest";
import { matchShortcut } from "./keyboard";

describe("mod+L", () => {
  it("maps to log-panel on mac (meta) and non-mac (ctrl)", () => {
    expect(matchShortcut({ key: "l", metaKey: true, ctrlKey: false, altKey: false }, true))
      .toEqual({ type: "log-panel" });
    expect(matchShortcut({ key: "l", metaKey: false, ctrlKey: true, altKey: false }, false))
      .toEqual({ type: "log-panel" });
    expect(matchShortcut({ key: "l", metaKey: false, ctrlKey: false, altKey: false }, true)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter desktop exec vitest run src/lib/keyboard.test.ts`

- [ ] **Step 3: Implement keyboard + toolbar + panel**

`keyboard.ts` — add to the union and matcher:

```ts
export type ShortcutAction =
  | { type: "palette" }
  | { type: "switch-cluster"; index: number }
  | { type: "preferences" }
  | { type: "log-panel" };
```

```ts
  if (event.key.toLowerCase() === "l") return { type: "log-panel" };
```

`LogToolbar.svelte`:

```svelte
<script lang="ts">
	import { ChevronDown, MoreHorizontal, RotateCcw } from 'lucide-svelte';
	import { logPanel } from '$lib/stores/logPanel.svelte';
	import type { LogSession } from '$lib/stores/logSession.svelte';

	let { session }: { session: LogSession } = $props();

	let pickerOpen = $state(false);
	let overflowOpen = $state(false);

	const TAIL_OPTIONS = [100, 500, 1000, 5000] as const;

	const selected = $derived(session.containers.find((c) => c.name === session.container) ?? null);
	const mains = $derived(session.containers.filter((c) => !c.init));
	const inits = $derived(session.containers.filter((c) => c.init));

	function pick(name: string) {
		pickerOpen = false;
		logPanel.rememberContainer(session.key, name);
		void session.switchContainer(name);
	}
</script>

<div class="flex h-9 shrink-0 items-center gap-2 border-b border-border-default bg-surface-raised px-2.5">
	<!-- container picker -->
	<div class="relative">
		<button
			type="button"
			class="focus-ring type-caption flex h-7 items-center gap-1.5 rounded-md border border-border-default bg-surface-window px-2.5 font-mono text-text-primary"
			onclick={() => (pickerOpen = !pickerOpen)}
		>
			{session.container ?? '…'}
			<ChevronDown size={12} strokeWidth={1.5} />
		</button>
		{#if pickerOpen}
			<div
				class="absolute bottom-full left-0 z-20 mb-1 min-w-56 rounded-md border border-border-default bg-surface-raised py-1 shadow-lg"
			>
				{#each mains as c (c.name)}
					<button
						type="button"
						class="flex w-full items-center gap-2 px-2.5 py-1 text-left hover:bg-surface-sunken"
						onclick={() => pick(c.name)}
					>
						<span class="type-caption flex-1 font-mono text-text-primary">{c.name}</span>
						<span class="type-caption text-text-tertiary">{c.state}{c.restarts > 0 ? ` · ↺${c.restarts}` : ''}</span>
					</button>
				{/each}
				{#if inits.length > 0}
					<div class="my-1 border-t border-border-default"></div>
					{#each inits as c (c.name)}
						<button
							type="button"
							class="flex w-full items-center gap-2 px-2.5 py-1 text-left hover:bg-surface-sunken"
							onclick={() => pick(c.name)}
						>
							<span class="type-caption flex-1 font-mono text-text-secondary">{c.name}</span>
							<span class="type-caption text-text-tertiary">init</span>
						</button>
					{/each}
				{/if}
			</div>
		{/if}
	</div>

	<!-- previous-instance chip: only when the selected container has restarts -->
	{#if (selected?.restarts ?? 0) > 0}
		<button
			type="button"
			class="focus-ring type-caption flex h-7 items-center gap-1 rounded-md px-2 {session.previous
				? 'bg-surface-sunken text-text-primary'
				: 'text-text-tertiary'}"
			title="Previous instance"
			onclick={() => void session.setPrevious(!session.previous)}
		>
			<RotateCcw size={12} strokeWidth={1.5} /> prev
		</button>
	{/if}

	<span class="flex-1"></span>

	<!-- tail size -->
	<div class="flex overflow-hidden rounded-md border border-border-default">
		{#each TAIL_OPTIONS as n (n)}
			<button
				type="button"
				class="type-section h-7 border-r border-border-default px-2 last:border-r-0"
				style={session.tailLines === n
					? 'background: var(--color-text-secondary); color: var(--color-surface-window);'
					: 'color: var(--color-text-tertiary);'}
				onclick={() => void session.setTail(n)}
			>
				{n}
			</button>
		{/each}
	</div>
	<button
		type="button"
		class="focus-ring type-caption h-7 rounded-md px-2 text-text-tertiary hover:text-text-secondary"
		onclick={() => void session.loadEarlier()}
	>
		Load 500 earlier
	</button>

	<!-- follow/pause -->
	<button
		type="button"
		class="type-caption flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium"
		style={session.following
			? 'background: var(--color-status-ok); color: var(--color-surface-window);'
			: 'background: var(--alpha-pill-warn); color: var(--color-status-warn);'}
		onclick={() => session.toggleFollow()}
	>
		{session.following ? '● Following' : '⏸ Paused'}
	</button>

	<!-- overflow -->
	<div class="relative">
		<button
			type="button"
			class="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:text-text-secondary"
			aria-label="More log options"
			onclick={() => (overflowOpen = !overflowOpen)}
		>
			<MoreHorizontal size={14} strokeWidth={1.5} />
		</button>
		{#if overflowOpen}
			<div class="absolute right-0 bottom-full z-20 mb-1 min-w-44 rounded-md border border-border-default bg-surface-raised py-1 shadow-lg">
				<button type="button" class="type-caption block w-full px-2.5 py-1 text-left text-text-primary hover:bg-surface-sunken"
					onclick={() => { logPanel.timestamps = !logPanel.timestamps; overflowOpen = false; }}>
					{logPanel.timestamps ? '✓ ' : ''}Timestamps
				</button>
				<button type="button" class="type-caption block w-full px-2.5 py-1 text-left text-text-primary hover:bg-surface-sunken"
					onclick={() => { logPanel.wrap = !logPanel.wrap; overflowOpen = false; }}>
					{logPanel.wrap ? '✓ ' : ''}Wrap lines
				</button>
				<div class="my-1 border-t border-border-default"></div>
				<button type="button" class="type-caption block w-full px-2.5 py-1 text-left text-text-primary hover:bg-surface-sunken"
					onclick={() => { session.clear(); overflowOpen = false; }}>
					Clear buffer
				</button>
			</div>
		{/if}
	</div>
</div>
```

`LogPanel.svelte`:

```svelte
<script lang="ts">
	import { ChevronDown, ChevronUp, X } from 'lucide-svelte';
	import LogBody from './LogBody.svelte';
	import LogToolbar from './LogToolbar.svelte';
	import { logPanel, PANEL_COLLAPSED, PANEL_MAX, PANEL_MIN } from '$lib/stores/logPanel.svelte';

	let dragging = $state(false);

	function startDrag(event: PointerEvent) {
		dragging = true;
		const startY = event.clientY;
		const startHeight = logPanel.height;
		const onMove = (e: PointerEvent) => {
			logPanel.height = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startHeight + (startY - e.clientY)));
		};
		const onUp = () => {
			dragging = false;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}
</script>

{#if logPanel.open}
	<section
		class="flex shrink-0 flex-col border-t border-border-default bg-surface-window"
		style="height: {logPanel.collapsed ? PANEL_COLLAPSED : logPanel.height}px;"
		aria-label="Pod logs panel"
	>
		<!-- resize handle -->
		{#if !logPanel.collapsed}
			<div
				role="separator"
				aria-orientation="horizontal"
				class="h-1 shrink-0 cursor-row-resize {dragging ? 'bg-border-default' : 'hover:bg-border-default'}"
				onpointerdown={startDrag}
			></div>
		{/if}

		<!-- header strip: session title + collapse/close -->
		<div class="flex h-[33px] shrink-0 items-center gap-2 border-b border-border-default px-2.5">
			{#if logPanel.active}
				<span
					class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
					style="background: {logPanel.active.status === 'streaming'
						? 'var(--color-status-ok)'
						: logPanel.active.status === 'error'
							? 'var(--color-status-err)'
							: 'var(--color-status-warn)'};"
				></span>
				<span class="type-caption font-mono text-text-primary">{logPanel.active.pod}</span>
				<span class="type-caption font-mono text-text-tertiary">{logPanel.active.container ?? ''}</span>
			{/if}
			<span class="flex-1"></span>
			<button
				type="button"
				class="focus-ring flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:text-text-secondary"
				aria-label={logPanel.collapsed ? 'Expand log panel' : 'Collapse log panel'}
				onclick={() => logPanel.toggleCollapsed()}
			>
				{#if logPanel.collapsed}<ChevronUp size={14} strokeWidth={1.5} />{:else}<ChevronDown size={14} strokeWidth={1.5} />{/if}
			</button>
			<button
				type="button"
				class="focus-ring flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:text-text-secondary"
				aria-label="Close log panel"
				onclick={() => logPanel.active && void logPanel.closeSession(logPanel.active.key)}
			>
				<X size={14} strokeWidth={1.5} />
			</button>
		</div>

		{#if !logPanel.collapsed && logPanel.active}
			<LogToolbar session={logPanel.active} />
			<LogBody session={logPanel.active} />
		{/if}
	</section>
{/if}
```

`+page.svelte` — import and mount inside `<main>`'s parent column so it spans the content area above `StatusBar`, and route the shortcut:

```svelte
import LogPanel from '$lib/components/logpanel/LogPanel.svelte';
import { logPanel } from '$lib/stores/logPanel.svelte';
```

```svelte
			<main class="relative flex min-w-0 flex-1 flex-col overflow-y-auto">
				…existing content…
			</main>
```

becomes a column wrapping main + panel:

```svelte
			<div class="flex min-w-0 flex-1 flex-col">
				<main class="relative flex min-w-0 flex-1 flex-col overflow-y-auto">
					{#if app.view !== 'dashboard' && clusters.connectionState === 'unreachable'}
						<UnreachableView />
					{:else}
						<Current {...entry.props ?? {}} />
					{/if}
				</main>
				<LogPanel />
			</div>
```

and in `onKeydown` after the palette branch:

```ts
			} else if (action.type === 'log-panel') {
				if (logPanel.open) logPanel.toggleCollapsed();
			}
```

`PodDrawer.svelte` — add near the existing action buttons (match their classes exactly; place beside the port-forward/delete actions):

```svelte
<button
	type="button"
	class="…same classes as the neighboring action button…"
	onclick={() => void logPanel.openFor({ namespace: pod.namespace, name: pod.name })}
>
	Logs
</button>
```

with `import { logPanel } from '$lib/stores/logPanel.svelte';`. Read the drawer first and copy the exact button idiom (variant classes, icon usage) of its existing actions.

- [ ] **Step 4: Component test for the toolbar**

```ts
// apps/desktop/src/lib/components/logpanel/log-toolbar.test.ts
// Same render helper as log-body.test.ts.
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte"; // ← mirror logs-view.test.ts
import LogToolbar from "./LogToolbar.svelte";
import { LogSession } from "$lib/stores/logSession.svelte";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("$lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/tauri")>()),
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
}));

describe("LogToolbar", () => {
  it("hides the previous chip when the container has no restarts", async () => {
    const s = new LogSession("default", "api-0");
    s.containers = [{ name: "worker", init: false, sidecar: false, restarts: 0, ready: true, state: "running", state_reason: null, last_terminated_reason: null, last_terminated_at: null }];
    s.container = "worker";
    const { queryByText } = render(LogToolbar, { session: s });
    expect(queryByText("prev")).toBeNull();
  });

  it("shows the previous chip when restarts > 0", async () => {
    const s = new LogSession("default", "api-0");
    s.containers = [{ name: "worker", init: false, sidecar: false, restarts: 3, ready: true, state: "running", state_reason: null, last_terminated_reason: null, last_terminated_at: null }];
    s.container = "worker";
    const { getByText } = render(LogToolbar, { session: s });
    await expect.element(getByText("prev")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run all new tests + full suite**

Run: `pnpm --filter desktop test`
Expected: PASS. Also `pnpm --filter desktop exec svelte-kit sync && pnpm --filter desktop exec svelte-check` if the repo's lint flow uses it (mirror `ci.yml` lint-fe steps).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/components/logpanel/ apps/desktop/src/lib/keyboard.ts apps/desktop/src/lib/keyboard.test.ts apps/desktop/src/routes/+page.svelte apps/desktop/src/lib/components/pods/PodDrawer.svelte
git commit -m "feat(desktop): log panel chrome, toolbar and PodDrawer entry point"
```

---

### Task 7: PR 1 — push and open

**Files:**
- Modify: `docs/superpowers/specs/2026-08-04-desktop-pod-log-viewer-design.md` (delivery table: move "PodDrawer Logs button (bootstrap entry)" into PR 1 row; PR 4 row keeps "row chip, palette")

- [ ] **Step 1: Update the spec delivery table** as above; commit `docs: PodDrawer entry ships with logpanel core`.

- [ ] **Step 2: Full test suite** — `pnpm --filter desktop test` → PASS.

- [ ] **Step 3: Push**

```bash
git -c credential.helper= -c credential.helper='!f() { echo username=massilp; echo "password=$(gh auth token --user massilp)"; }; f' push -u origin feat/desktop-logpanel-core
```

- [ ] **Step 4: Open PR** (write the body to a scratch file first, then):

```bash
GH_TOKEN=$(gh auth token --user massilp) gh pr create --base main --head feat/desktop-logpanel-core \
  --title "feat(desktop): pod log panel core (#295)" --body-file <scratch>/pr-logpanel-core.md
```

Body: summary of panel core scope (session store, virtualized body, toolbar, PodDrawer entry), link to both specs, test plan (unit + component + suite counts). Refs #295.

---

### Task 8: LogSearch model

**Branch:** `git switch -c feat/desktop-logpanel-search` (base: `feat/desktop-logpanel-core`).

**Files:**
- Create: `apps/desktop/src/lib/stores/logSearch.svelte.ts`
- Test: `apps/desktop/src/lib/stores/logSearch.svelte.test.ts`

**Interfaces:**
- Consumes: `KeyedLogLine`.
- Produces:

```ts
export const SEARCH_DEBOUNCE_MS = 150;
export class LogSearch {
  query: string;                 // $state
  filterMode: boolean;           // $state — chip: hide non-matching lines
  matchIds: number[];            // $state — KeyedLogLine ids, ascending
  cursor: number;                // $state — index into matchIds
  get activeId(): number | null; // matchIds[cursor] ?? null
  get count(): number;           // matchIds.length
  setQuery(q: string): void;                    // debounced recompute
  recompute(lines: KeyedLogLine[]): void;       // immediate, called by the debounce and on buffer growth
  next(): void;                                 // wraps
  prev(): void;                                 // wraps
  clear(): void;                                // query "", matches [], filterMode off
}
```

Matching is case-insensitive substring on `line.message`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/lib/stores/logSearch.svelte.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogSearch, SEARCH_DEBOUNCE_MS } from "./logSearch.svelte";
import type { KeyedLogLine } from "./logs.svelte";

function lines(...messages: string[]): KeyedLogLine[] {
  return messages.map((message, id) => ({
    id, pod: "api-0", namespace: "default", time: null, level: "info", message,
  }));
}

describe("LogSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces query changes and matches case-insensitively", () => {
    const search = new LogSearch();
    const data = lines("GET /health 200", "error: timeout", "get /users 500");
    search.attach(() => data);
    search.setQuery("GET");
    expect(search.matchIds).toEqual([]);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    expect(search.matchIds).toEqual([0, 2]);
    expect(search.count).toBe(2);
  });

  it("navigates with wrap in both directions", () => {
    const search = new LogSearch();
    const data = lines("a x", "b", "c x");
    search.attach(() => data);
    search.setQuery("x");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    expect(search.activeId).toBe(0);
    search.next();
    expect(search.activeId).toBe(2);
    search.next(); // wrap
    expect(search.activeId).toBe(0);
    search.prev(); // wrap back
    expect(search.activeId).toBe(2);
  });

  it("clear resets query, matches and filter mode", () => {
    const search = new LogSearch();
    search.attach(() => lines("x"));
    search.setQuery("x");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    search.filterMode = true;
    search.clear();
    expect(search.query).toBe("");
    expect(search.matchIds).toEqual([]);
    expect(search.filterMode).toBe(false);
  });

  it("stays under 50ms recomputing over a 5k-line buffer", () => {
    const search = new LogSearch();
    const big = lines(...Array.from({ length: 5000 }, (_, i) => `line ${i} ${i % 7 === 0 ? "needle" : ""}`));
    search.attach(() => big);
    const start = performance.now();
    search.recompute(big);
    search.setQuery("needle");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    expect(performance.now() - start).toBeLessThan(50 + SEARCH_DEBOUNCE_MS);
    expect(search.count).toBe(Math.ceil(5000 / 7));
  });
});
```

(`attach(getLines: () => KeyedLogLine[])` gives the model its data source without coupling it to a session — add it to the Produces contract.)

- [ ] **Step 2: Run, expect FAIL** — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/lib/stores/logSearch.svelte.ts
/**
 * Live search over a log buffer: case-insensitive substring, match ids
 * precomputed off the render path (150 ms debounce), n/N cursor with wrap,
 * optional filter mode that hides non-matching lines.
 */
import type { KeyedLogLine } from "./logs.svelte";

export const SEARCH_DEBOUNCE_MS = 150;

export class LogSearch {
  query = $state("");
  filterMode = $state(false);
  matchIds = $state<number[]>([]);
  cursor = $state(0);

  #getLines: () => KeyedLogLine[] = () => [];
  #debounce: ReturnType<typeof setTimeout> | null = null;

  get activeId(): number | null {
    return this.matchIds[this.cursor] ?? null;
  }

  get count(): number {
    return this.matchIds.length;
  }

  attach(getLines: () => KeyedLogLine[]): void {
    this.#getLines = getLines;
  }

  setQuery(q: string): void {
    this.query = q;
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      this.recompute(this.#getLines());
    }, SEARCH_DEBOUNCE_MS);
  }

  recompute(lines: KeyedLogLine[]): void {
    const q = this.query.toLowerCase();
    if (!q) {
      this.matchIds = [];
      this.cursor = 0;
      return;
    }
    const ids: number[] = [];
    for (const line of lines) {
      if (line.message.toLowerCase().includes(q)) ids.push(line.id);
    }
    this.matchIds = ids;
    if (this.cursor >= ids.length) this.cursor = 0;
  }

  next(): void {
    if (this.count === 0) return;
    this.cursor = (this.cursor + 1) % this.count;
  }

  prev(): void {
    if (this.count === 0) return;
    this.cursor = (this.cursor - 1 + this.count) % this.count;
  }

  clear(): void {
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = null;
    this.query = "";
    this.matchIds = [];
    this.cursor = 0;
    this.filterMode = false;
  }
}
```

- [ ] **Step 4: Run, expect PASS** (4 tests).

- [ ] **Step 5: Commit** — `feat(desktop): log search model — debounced matching with wrap navigation`

---

### Task 9: Search UI — toolbar input, highlight, filter, shortcuts

**Files:**
- Modify: `apps/desktop/src/lib/stores/logPanel.svelte.ts` (own one `LogSearch`, re-attach on active-session change, recompute on buffer growth)
- Modify: `apps/desktop/src/lib/components/logpanel/LogToolbar.svelte` (search input with `n/N` count, ↵/⇧↵, esc, filter chip)
- Modify: `apps/desktop/src/lib/components/logpanel/LogBody.svelte` (highlight matches, active-match style, scroll-to-match pauses follow, filter mode)
- Modify: `apps/desktop/src/lib/components/logpanel/LogLineRow.svelte` (props `search: { query: string; active: boolean } | null`; render `<mark>` segments)
- Modify: `apps/desktop/src/lib/keyboard.ts` + `apps/desktop/src/routes/+page.svelte` (`mod+F` → `{ type: "log-search" }`, focuses the panel search input when the panel is open; otherwise falls through to browser default prevented no-op)
- Test: extend `log-body.test.ts`, `keyboard.test.ts`

**Interfaces:**
- Consumes: `LogSearch` (Task 8).
- Produces: `logPanel.search: LogSearch`; `logPanel.focusSearch: () => void` (set by the toolbar via `logPanel.registerSearchFocus(fn)`); `LogLineRow` prop `search`.

Key behaviors (write these as assertions):
- Typing recomputes after debounce; count renders `«{cursor+1}/{count}»` when count > 0, `0 results` styled `text-text-tertiary` otherwise.
- ↵ = `next()`, ⇧↵ = `prev()`; navigating scrolls the virtualizer to the match row (`scrollToIndex` on the line's index in `ring.lines`) and pauses follow.
- Filter chip toggles `filterMode`: LogBody renders `ring.lines.filter(l => search.matchSet.has(l.id))`. Add to `LogSearch`:

```ts
  matchSet = $derived(new Set(this.matchIds));
```

- LogBody passes the highlight prop per row:

```svelte
<LogLineRow
	{line}
	timestamps={logPanel.timestamps}
	wrap={logPanel.wrap}
	search={logPanel.search.query
		? { query: logPanel.search.query, active: line.id === logPanel.search.activeId }
		: null}
/>
```
- Esc inside the input: first press clears the query, second (empty query) blurs; both `stopPropagation` so the global Escape handler doesn't fire.
- Highlight: split `line.message` on the query (case-insensitive) and wrap hits in `<mark>`; active match row uses solid warn background (`background: var(--color-status-warn); color: var(--color-surface-window);` on the mark of the active row).

- [ ] **Step 1: Write failing tests** — extend `log-body.test.ts`:

```ts
  it("filter mode hides non-matching lines", async () => {
    const s = sessionWith(["alpha", "beta", "alpha two"]);
    logPanel.search.attach(() => s.ring.lines);
    logPanel.search.setQuery("alpha");
    vi.advanceTimersByTime(200);
    logPanel.search.filterMode = true;
    const { getByText, queryByText } = render(LogBody, { session: s });
    await expect.element(getByText("alpha")).toBeInTheDocument();
    expect(queryByText("beta")).toBeNull();
  });
```

and `keyboard.test.ts` for `mod+F → { type: "log-search" }`.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** per the behaviors above. In `logPanel.svelte.ts`:

```ts
  search = new LogSearch();

  #searchFocus: (() => void) | null = null;
  registerSearchFocus(fn: (() => void) | null): void {
    this.#searchFocus = fn;
  }
  focusSearch(): void {
    this.#searchFocus?.();
  }
```

and re-attach + recompute wiring (inside `openFor` after session creation, and the toolbar adds a `$effect` watching `session.ring.lines.length` → `logPanel.search.recompute(session.ring.lines)` so matches follow the stream).

Toolbar input (place between picker and tail chips):

```svelte
	<div class="flex items-center gap-1">
		<input
			bind:this={searchInput}
			type="text"
			placeholder="Search… (⌘F)"
			value={logPanel.search.query}
			oninput={(e) => logPanel.search.setQuery(e.currentTarget.value)}
			onkeydown={onSearchKeydown}
			class="focus-ring h-7 w-44 rounded-md border border-border-default bg-surface-window px-2.5 text-[11.5px] text-text-primary placeholder:text-text-disabled"
		/>
		{#if logPanel.search.query}
			<span class="type-caption text-text-tertiary">
				{logPanel.search.count === 0 ? '0 results' : `${logPanel.search.cursor + 1}/${logPanel.search.count}`}
			</span>
			<button
				type="button"
				class="type-caption h-7 rounded-md px-2 {logPanel.search.filterMode
					? 'bg-surface-sunken text-text-primary'
					: 'text-text-tertiary'}"
				onclick={() => (logPanel.search.filterMode = !logPanel.search.filterMode)}
			>
				filter
			</button>
		{/if}
	</div>
```

```ts
	let searchInput = $state<HTMLInputElement | null>(null);
	$effect(() => {
		logPanel.registerSearchFocus(() => searchInput?.focus());
		return () => logPanel.registerSearchFocus(null);
	});

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.shiftKey ? logPanel.search.prev() : logPanel.search.next();
			event.preventDefault();
		} else if (event.key === 'Escape') {
			event.stopPropagation();
			if (logPanel.search.query) logPanel.search.clear();
			else (event.currentTarget as HTMLInputElement).blur();
		}
	}
```

`+page.svelte` keydown branch:

```ts
			} else if (action.type === 'log-search') {
				if (logPanel.open) logPanel.focusSearch();
			}
```

`LogLineRow` highlight (segments computed in a `$derived`):

```ts
	const segments = $derived.by(() => {
		if (!search || !search.query) return [{ text: line.message, hit: false }];
		const q = search.query.toLowerCase();
		const src = line.message;
		const out: { text: string; hit: boolean }[] = [];
		let i = 0;
		for (;;) {
			const at = src.toLowerCase().indexOf(q, i);
			if (at === -1) {
				out.push({ text: src.slice(i), hit: false });
				return out;
			}
			if (at > i) out.push({ text: src.slice(i, at), hit: false });
			out.push({ text: src.slice(at, at + q.length), hit: true });
			i = at + q.length;
		}
	});
```

```svelte
	<span class="type-log text-text-log {wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'}">
		{#each segments as seg, i (i)}
			{#if seg.hit}<mark
					style={search?.active
						? 'background: var(--color-status-warn); color: var(--color-surface-window);'
						: 'background: var(--alpha-pill-warn); color: inherit;'}>{seg.text}</mark>
			{:else}{seg.text}{/if}
		{/each}
	</span>
```

- [ ] **Step 4: Run all logpanel tests + full suite** — PASS. Manually sanity-check jank: `pnpm --filter desktop exec vitest run src/lib/stores/logSearch.svelte.test.ts` includes the 5k budget test.

- [ ] **Step 5: Commit** — `feat(desktop): log search UI — highlight, n/N nav, filter mode`

---

### Task 10: PR 2 — push and open

- [ ] **Step 1:** `pnpm --filter desktop test` → PASS.
- [ ] **Step 2:** Push `feat/desktop-logpanel-search` (massilp helper, as Task 7).
- [ ] **Step 3:** `GH_TOKEN=$(gh auth token --user massilp) gh pr create --base feat/desktop-logpanel-core --head feat/desktop-logpanel-search --title "feat(desktop): log panel search (#295)" --body-file <scratch>/pr-logpanel-search.md` — body lists behaviors + the 5k perf test. Refs #295.

---

### Task 11: Multi-session tabs — store

**Branch:** `git switch -c feat/desktop-logpanel-tabs` (base: `feat/desktop-logpanel-search`).

**Files:**
- Modify: `apps/desktop/src/lib/stores/logPanel.svelte.ts`
- Test: extend `apps/desktop/src/lib/stores/logPanel.svelte.test.ts`

**Interfaces:**
- Produces: `openFor` no longer closes other sessions (cap **6** sessions: opening a 7th closes the least-recently-focused); `focus(key: string)` sets `activeKey` and re-attaches `search` to the focused session (search state is global, query survives tab switch, matches recompute against the new buffer).

- [ ] **Step 1: Failing tests** (replace the single-session assertions):

```ts
  it("keeps existing sessions when opening a second pod and focuses the new one", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    expect(logPanel.sessions.map((s) => s.key)).toEqual(["default/api-0", "default/web-1"]);
    expect(logPanel.activeKey).toBe("default/web-1");
  });

  it("focus() switches the active session and closing the active tab falls back to the last one", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    logPanel.focus("default/api-0");
    expect(logPanel.activeKey).toBe("default/api-0");
    await logPanel.closeSession("default/api-0");
    expect(logPanel.activeKey).toBe("default/web-1");
  });

  it("evicts the least-recently-focused session past the cap of 6", async () => {
    for (let i = 0; i < 7; i++) await logPanel.openFor({ namespace: "default", name: `p-${i}` });
    expect(logPanel.sessions).toHaveLength(6);
    expect(logPanel.sessions.some((s) => s.key === "default/p-0")).toBe(false);
  });
```

- [ ] **Step 2: Run, expect FAIL** (single-session behavior).

- [ ] **Step 3: Implement** — `#focusOrder: string[]` private LRU; `openFor` pushes, evicts head past 6 via `closeSession`; `focus(key)` bumps LRU + `this.search.attach(() => this.active!.ring.lines); this.search.recompute(...)`. Delete the "replace whatever is open" loop. Update the earlier "second pod replaces it" test to the new contract (that test is superseded — rewrite it, don't keep both).

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(desktop): multi-session log panel store with LRU cap`

---

### Task 12: LogTabStrip + chrome polish

**Files:**
- Create: `apps/desktop/src/lib/components/logpanel/LogTabStrip.svelte`
- Modify: `apps/desktop/src/lib/components/logpanel/LogPanel.svelte` (replace single-title header with the strip)
- Test: `apps/desktop/src/lib/components/logpanel/log-tabstrip.test.ts`

**Interfaces:**
- Consumes: `logPanel.sessions`, `logPanel.activeKey`, `logPanel.focus`, `logPanel.closeSession`, session `status`.
- Produces: `LogTabStrip.svelte` (no props): one tab per session — status dot (ok=streaming, warn=connecting/reconnecting/ended, err=error) · pod name · container · ✕; click focuses, ✕ closes; strip stays visible when collapsed (34 px row is exactly the strip).

- [ ] **Step 1: Failing test**

```ts
// apps/desktop/src/lib/components/logpanel/log-tabstrip.test.ts — same render helper as siblings
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte"; // ← mirror siblings
import LogTabStrip from "./LogTabStrip.svelte";
import { logPanel } from "$lib/stores/logPanel.svelte";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("$lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/tauri")>()),
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
}));

describe("LogTabStrip", () => {
  it("renders one tab per session and marks the active one", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    const { getByText } = render(LogTabStrip);
    await expect.element(getByText("api-0")).toBeInTheDocument();
    await expect.element(getByText("web-1")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```svelte
<script lang="ts">
	import { X } from 'lucide-svelte';
	import { logPanel } from '$lib/stores/logPanel.svelte';
	import type { SessionStatus } from '$lib/stores/logSession.svelte';

	function dot(status: SessionStatus): string {
		if (status === 'streaming') return 'var(--color-status-ok)';
		if (status === 'error') return 'var(--color-status-err)';
		return 'var(--color-status-warn)';
	}
</script>

<div class="flex h-[33px] shrink-0 items-center gap-1 overflow-x-auto border-b border-border-default px-1.5">
	{#each logPanel.sessions as session (session.key)}
		{@const active = session.key === logPanel.activeKey}
		<div
			class="group flex h-[26px] items-center gap-1.5 rounded-md px-2 {active
				? 'bg-surface-sunken'
				: 'hover:bg-surface-sunken/50'}"
		>
			<button
				type="button"
				class="flex items-center gap-1.5"
				onclick={() => logPanel.focus(session.key)}
			>
				<span class="inline-block h-1.5 w-1.5 rounded-full" style="background: {dot(session.status)};"></span>
				<span class="type-caption font-mono {active ? 'text-text-primary' : 'text-text-secondary'}">{session.pod}</span>
				<span class="type-caption font-mono text-text-tertiary">{session.container ?? ''}</span>
			</button>
			<button
				type="button"
				class="focus-ring rounded p-0.5 text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-text-secondary"
				aria-label={`Close ${session.pod} logs`}
				onclick={() => void logPanel.closeSession(session.key)}
			>
				<X size={11} strokeWidth={1.5} />
			</button>
		</div>
	{/each}
	<span class="flex-1"></span>
	<!-- collapse / close-all buttons move here from the old header -->
</div>
```

In `LogPanel.svelte`, replace the header strip with `<LogTabStrip />` plus the collapse/close buttons (same handlers as before) appended after the flex spacer.

- [ ] **Step 4: Run logpanel tests + full suite — PASS.**
- [ ] **Step 5: Commit** — `feat(desktop): log panel session tabs`

---

### Task 13: PR 3 — push and open

- [ ] **Step 1:** `pnpm --filter desktop test` → PASS.
- [ ] **Step 2:** Push `feat/desktop-logpanel-tabs` (massilp helper).
- [ ] **Step 3:** PR base `feat/desktop-logpanel-search`, title `feat(desktop): log panel session tabs (#295)`, body via file. Refs #295.

---

### Task 14: export_log Tauri command

**Branch:** `git switch -c feat/desktop-logpanel-entry-export` (base: `feat/desktop-logpanel-tabs`).

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add `dirs = "6"`)
- Modify: `apps/desktop/src-tauri/src/commands/kubernetes.rs` (add command + pure filename helper)
- Modify: `apps/desktop/src-tauri/src/lib.rs:23` (register `export_log` in `generate_handler!`)
- Modify: `apps/desktop/src/lib/tauri.ts` (binding)
- Test: Rust unit test in the same module

**Interfaces:**
- Produces:
  - Rust: `export_log(filename: String, contents: String) -> Result<String, String>` — sanitizes `filename` (strip path separators), writes to `~/Downloads/<filename>`, returns the absolute path written. Pure helper `log_export_filename(pod: &str, container: &str, full: bool) -> String` = `format!("{pod}_{container}{}.log", if full { "_full" } else { "" })` — unit-tested.
  - TS: `exportLog(filename: string, contents: string): Promise<string>`.

- [ ] **Step 1: Failing Rust test** (bottom of `kubernetes.rs`):

```rust
#[cfg(test)]
mod export_tests {
    use super::*;

    #[test]
    fn filename_shapes() {
        assert_eq!(log_export_filename("api-0", "worker", false), "api-0_worker.log");
        assert_eq!(log_export_filename("api-0", "worker", true), "api-0_worker_full.log");
    }

    #[test]
    fn sanitize_strips_separators() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("api_worker.log"), "api_worker.log");
    }
}
```

- [ ] **Step 2:** `cargo test -p cubelite-desktop 2>/dev/null || (cd apps/desktop/src-tauri && cargo test)` — FAIL (functions missing). Use whichever package name `apps/desktop/src-tauri/Cargo.toml` declares.

- [ ] **Step 3: Implement**

```rust
/// `<pod>_<container>[_full].log` (spec: export filenames).
pub fn log_export_filename(pod: &str, container: &str, full: bool) -> String {
    format!("{pod}_{container}{}.log", if full { "_full" } else { "" })
}

/// Keep only the final path component so a hostile filename cannot escape
/// the Downloads directory.
pub fn sanitize_filename(name: &str) -> String {
    name.rsplit(['/', '\\']).next().unwrap_or(name).to_string()
}

/// Write exported log contents into ~/Downloads; returns the written path.
#[tauri::command]
pub async fn export_log(filename: String, contents: String) -> Result<String, String> {
    let dir = dirs::download_dir().ok_or("No Downloads directory available")?;
    let path = dir.join(sanitize_filename(&filename));
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}
```

`Cargo.toml` `[dependencies]`: `dirs = "6"`. Register in `lib.rs` `generate_handler![…, export_log]`. Binding:

```ts
/** Write exported log contents to ~/Downloads; resolves to the written path. */
export function exportLog(filename: string, contents: string): Promise<string> {
  return invoke<string>("export_log", { filename, contents });
}
```

- [ ] **Step 4:** `cargo test` in `apps/desktop/src-tauri` → PASS; `cargo clippy --all-targets -- -D warnings` clean (CI lints Rust).
- [ ] **Step 5: Commit** — `feat(desktop): export_log command writing to Downloads`

---

### Task 15: Export menu + entry points

**Files:**
- Modify: `apps/desktop/src/lib/components/logpanel/LogToolbar.svelte` (overflow: "Export visible…", "Export full buffer…")
- Modify: `apps/desktop/src/lib/components/PodTable.svelte` (row chip `logs ⏎` on the selected row + Enter key)
- Modify: `apps/desktop/src/lib/components/CommandPalette.svelte` (action "Open pod logs" when `app.selectedPod`)
- Test: extend `log-toolbar.test.ts`; extend `apps/desktop/src/lib/components/CommandPalette.test.ts`

**Interfaces:**
- Consumes: `exportLog` (Task 14), `toasts.push(message, tone)` from `$lib/stores/toasts.svelte`, `logPanel`, `app.selectedPod`.
- Produces: overflow menu entries; `PodTable` prop `onLogs?: (pod: PodInfo) => void` wired from `PodsView` to `logPanel.openFor`.

Behaviors:
- "Export visible…" serializes the currently rendered set (filter mode applied): lines → `[time] LEVEL message\n` (time omitted when timestamps toggle off). "Export full buffer…" serializes `ring.lines` regardless of filters, filename gets `_full`.
- On success: `toasts.push(`Exported to ${path}`, "ok")`; on failure `toasts.push(msg, "err")`.
- `PodTable`: when a row is selected, show a `logs ⏎` chip in its trailing cell (match the existing selected-row affordance classes); pressing Enter with a selected row calls `onLogs`. Read `PodTable.svelte` first and copy its row/chip idioms exactly.
- Palette: extend the `Action` type with an optional `run?: () => void` that takes precedence over `view` navigation in the select handler. Entry `{ label: 'Open pod logs', icon: FileText, run: () => void logPanel.openFor({ namespace: app.selectedPod!.namespace, name: app.selectedPod!.name }) }` — include it in the actions list only when `app.selectedPod` is set (make `actions` a `$derived`); selecting it closes the palette then invokes `run`.

- [ ] **Step 1: Failing tests**

`log-toolbar.test.ts` — export flows:

```ts
  it("export visible writes via exportLog and toasts the path", async () => {
    const { exportLog } = await import("$lib/tauri");
    vi.mocked(exportLog).mockResolvedValue("/Users/x/Downloads/api-0_worker.log");
    const s = new LogSession("default", "api-0");
    s.container = "worker";
    s.ring.append([{ pod: "api-0", namespace: "default", time: "2026-08-04T10:00:00Z", level: "info", message: "hello" }]);
    const { getByLabelText, getByText } = render(LogToolbar, { session: s });
    await getByLabelText("More log options").click();
    await getByText("Export visible…").click();
    expect(exportLog).toHaveBeenCalledWith("api-0_worker.log", expect.stringContaining("hello"));
  });
```

(add `exportLog: vi.fn(async () => "/tmp/x.log")` to the `$lib/tauri` mock at the top of the file). `CommandPalette.test.ts`: with `app.selectedPod` set, the palette lists "Open pod logs"; without it, it doesn't.

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** per behaviors; serialization helper in `logPanel.svelte.ts`:

```ts
  serialize(lines: KeyedLogLine[]): string {
    return lines
      .map((l) => {
        const ts = this.timestamps && l.time ? `${l.time} ` : "";
        return `${ts}${l.level.toUpperCase()} ${l.message}`;
      })
      .join("\n");
  }
```

- [ ] **Step 4: Run full suite — PASS.**
- [ ] **Step 5: Commit** — `feat(desktop): log export, pod row chip and palette entry`

---

### Task 16: Reconnecting banner

**Files:**
- Modify: `apps/desktop/src/lib/components/logpanel/LogBody.svelte`
- Test: extend `log-body.test.ts`

**Interfaces:**
- Consumes: session `status === "reconnecting"`, `reconnectAttempt`, `nextRetryAt`, `retryNow()`.
- Produces: top-anchored banner inside the body: `Reconnecting — attempt {n} · retrying in {s}s` + "Retry now" button; countdown ticks via a 1 s interval `$effect` while reconnecting.

- [ ] **Step 1: Failing test**

```ts
  it("shows the reconnecting banner with attempt count and retry-now", async () => {
    const s = sessionWith(["a"]);
    s.status = "reconnecting";
    s.reconnectAttempt = 3;
    s.nextRetryAt = Date.now() + 4000;
    const retry = vi.spyOn(s, "retryNow");
    const { getByText } = render(LogBody, { session: s });
    await expect.element(getByText(/Reconnecting — attempt 3/)).toBeInTheDocument();
    await getByText("Retry now").click();
    expect(retry).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**

```svelte
	let now = $state(Date.now());
	$effect(() => {
		if (session.status !== 'reconnecting') return;
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});
	const retryIn = $derived(
		session.nextRetryAt ? Math.max(0, Math.ceil((session.nextRetryAt - now) / 1000)) : 0
	);
```

```svelte
	{#if session.status === 'reconnecting'}
		<div class="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 border-b border-border-default px-2.5 py-1"
			style="background: var(--alpha-pill-warn);">
			<span class="type-caption" style="color: var(--color-status-warn);">
				Reconnecting — attempt {session.reconnectAttempt} · retrying in {retryIn}s
			</span>
			<button type="button" class="type-caption underline" style="color: var(--color-status-warn);"
				onclick={() => session.retryNow()}>
				Retry now
			</button>
		</div>
	{/if}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(desktop): reconnecting banner with retry-now`

---

### Task 17: E2E — panel happy path

**Files:**
- Modify: `apps/desktop/tests/e2e/tauri-mock.ts` (handle `stream_pod_log`, `get_pod_containers`, `stop_logs`, `export_log`; expose a way to emit `pod-log-line:{id}` events through the mocked `listen`)
- Create: `apps/desktop/tests/e2e/logpanel.spec.ts`

**Interfaces:**
- Consumes: `boot(page)` helper pattern from `app.spec.ts`; existing pod fixtures (`api-0`).
- Produces: mock returns stream id `"1"` from `stream_pod_log` and one fixture container (`worker`, restarts 0); `get_pod_containers` fixture; emitted lines land through the same event-listener registry the mock already uses for Tauri events (extend the mock's `listen` shim with a global `window.__emitTauriEvent(name, payload)` test hook if it doesn't have one — inspect the file first and follow its existing event plumbing).

- [ ] **Step 1: Write the spec**

```ts
// apps/desktop/tests/e2e/logpanel.spec.ts
import { test, expect, type Page } from "@playwright/test";
import { tauriMockScript } from "./tauri-mock";

async function boot(page: Page) {
  await page.addInitScript(tauriMockScript());
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

test("open logs from pod drawer, panel persists across navigation", async ({ page }) => {
  await boot(page);
  await page.getByText("Workloads").click();
  await page.getByText("api-0").click();          // opens PodDrawer
  await page.getByRole("button", { name: "Logs" }).click();
  await expect(page.getByLabel("Pod logs panel")).toBeVisible();

  // stream a line through the mock and see it render
  await page.evaluate(() => window.__emitTauriEvent?.("pod-log-line:1", {
    pod: "api-0", namespace: "default", time: "2026-08-04T10:00:00Z", level: "info", message: "e2e-hello",
  }));
  await expect(page.getByText("e2e-hello")).toBeVisible();

  // navigate elsewhere: panel stays
  await page.getByText("Services").click();
  await expect(page.getByLabel("Pod logs panel")).toBeVisible();
  await expect(page.getByText("e2e-hello")).toBeVisible();
});
```

Adjust selectors to the real sidebar/drawer copy after reading `app.spec.ts`'s pods test (it already opens the drawer — reuse its exact selectors).

- [ ] **Step 2: Extend `tauri-mock.ts`** — add invoke handlers and, if absent, the `__emitTauriEvent` hook into its `listen` shim.

- [ ] **Step 3: Run** — `pnpm --filter desktop exec playwright test tests/e2e/logpanel.spec.ts` → PASS.

- [ ] **Step 4: Commit** — `test(desktop): log panel e2e — open, stream, persist across navigation`

---

### Task 18: PR 4 — push, open, wrap up

- [ ] **Step 1:** Full checks: `pnpm --filter desktop test`, Playwright suite, `cargo clippy` + `cargo test` in `src-tauri` → all PASS.
- [ ] **Step 2:** Push `feat/desktop-logpanel-entry-export` (massilp helper).
- [ ] **Step 3:** PR base `feat/desktop-logpanel-tabs`, title `feat(desktop): log panel entry points, export and resilience (#295)`, body via file. Body notes the stack order and that merging the stack closes #295 (`Closes #295` on this final PR).
- [ ] **Step 4:** Report stack status: 4 PR links + CI state. Merge order: core → search → tabs → entry-export (each retargets to `main` as its base merges, or merge bottom-up).

---

## Verification of acceptance criteria (#295)

After the stack merges, walk the parent spec's acceptance list against the desktop app: logs visible while navigating (Task 17 e2e), picker covers init + sidecar with per-pod memory (Tasks 4/6), live search fluid at 5k (Task 8 perf test, Task 9), previous/timestamps/wrap (Tasks 2/6), tail 500 default + load-more (Tasks 2/6), export visible/full (Tasks 14/15), autoscroll only while following + wheel-up pause (Task 5).
