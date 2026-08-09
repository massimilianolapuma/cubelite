# Desktop Merged "All Containers" Log Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a merged "all containers" mode to the desktop log panel: one interleaved stream of every container in the pod, identity-color-tagged, per spec `docs/superpowers/specs/2026-08-08-desktop-merged-log-stream-design.md` (#297).

**Architecture:** Frontend merge. Extract the per-stream lifecycle from `LogSession` into a `ContainerStream` class (single mode = N=1), then merged mode opens one `ContainerStream` per container, all feeding the session's shared pending buffer and single 5k `LogRing`. No Rust changes.

**Tech Stack:** Svelte 5 runes ($state/$derived), Tauri events, vitest, Playwright e2e with tauri-mock.

## Global Constraints

- Two stacked PRs: PR1 = Task 1 (pure refactor, branch `feat/297-desktop-merged-stream`), PR2 = Tasks 2–6 (branch `feat/297-desktop-merged-mode` stacked on PR1).
- Identity palette tokens already exist: `--color-cluster-blue`, `--color-cluster-teal`, `--color-cluster-amber` (`apps/desktop/src/app.css:39-43`). Init containers always amber; regular containers cycle blue → teal by pod-spec order. Never status colors.
- Merged sentinel: `ALL_CONTAINERS = "*"` (a name k8s cannot give a real container).
- Ring cap stays `RING_CAP = 5000`; flush batching stays `FLUSH_MS`.
- Merged export filename: `<pod>_all.log` / `<pod>_all_full.log`.
- Gate ogni task con exit code espliciti (`; echo "X=$?"`), mai pipe che li mascherano.
- Test runner: `cd apps/desktop && pnpm vitest run <file>`; e2e: `pnpm test:e2e` (Playwright).
- Commit senza attribution Claude.

---

### Task 1: Extract `ContainerStream` from `LogSession` (PR1, pure refactor)

**Files:**
- Create: `apps/desktop/src/lib/stores/containerStream.svelte.ts`
- Modify: `apps/desktop/src/lib/stores/logSession.svelte.ts` (full rewrite of stream plumbing, public API unchanged)
- Test: existing `apps/desktop/src/lib/stores/logSession.svelte.test.ts` must stay green untouched; new `apps/desktop/src/lib/stores/containerStream.svelte.test.ts`

**Interfaces:**
- Consumes: `streamPodLog`, `stopLogs`, `LogLine` from `$lib/tauri`; `app` store; `errorMessage`.
- Produces (later tasks rely on these exact names):
  - `type StreamStatus = "connecting" | "streaming" | "reconnecting" | "ended" | "error"`
  - `class ContainerStream { status; error; reconnectAttempt; nextRetryAt; readonly container: string | null; start(); retryNow(); stop(); }`
  - `LogSession` keeps its public surface: `status`, `error`, `reconnectAttempt`, `nextRetryAt` become `$derived` aggregates over `#streams` (length 1 in this task); everything else unchanged.
  - Frontend-only optional field `container?: string` on `LogLine` in `$lib/tauri.ts` — tagged by `ContainerStream` on every line it forwards.

- [ ] **Step 1: Add the `container` tag field to the frontend `LogLine` type**

In `apps/desktop/src/lib/tauri.ts` (type at line 293):

```ts
export type LogLine = {
  pod: string;
  namespace: string;
  time: string | null;
  level: LogLevel;
  message: string;
  /** Frontend-only: source container, tagged by ContainerStream. Absent on aggregated-view lines. */
  container?: string;
};
```

- [ ] **Step 2: Write the failing test for `ContainerStream`**

`apps/desktop/src/lib/stores/containerStream.svelte.test.ts` — follow the mocking pattern at the top of `logSession.svelte.test.ts` (vi.mock of `$lib/tauri` and `@tauri-apps/api/event`; reuse its `emitLine`/listener-capture helpers by copying them, they are small):

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ContainerStream } from "./containerStream.svelte";
// vi.mock("$lib/tauri", ...) e vi.mock("@tauri-apps/api/event", ...)
// identici a logSession.svelte.test.ts (streamPodLog → "1", listener capture map).

describe("ContainerStream", () => {
  it("tags every forwarded line with its container name", async () => {
    const got: LogLine[][] = [];
    const s = new ContainerStream("ns", "pod", "envoy", (lines) => got.push(lines), () => ({
      previous: false,
      tailLines: 500,
      autoReconnect: true,
    }));
    await s.start();
    emit("pod-log-line:1", { pod: "pod", namespace: "ns", time: null, level: "info", message: "hi" });
    expect(got.flat()[0].container).toBe("envoy");
    expect(s.status).toBe("streaming");
  });

  it("backs off and exposes nextRetryAt when the stream ends with autoReconnect", async () => {
    vi.useFakeTimers();
    const s = new ContainerStream("ns", "pod", "worker", () => {}, () => ({
      previous: false, tailLines: 500, autoReconnect: true,
    }));
    await s.start();
    emit("pod-log-end:1", null);
    expect(s.status).toBe("reconnecting");
    expect(s.reconnectAttempt).toBe(1);
    expect(s.nextRetryAt).not.toBeNull();
  });

  it("ends without reconnect when autoReconnect is false", async () => {
    const s = new ContainerStream("ns", "pod", "worker", () => {}, () => ({
      previous: true, tailLines: 500, autoReconnect: false,
    }));
    await s.start();
    emit("pod-log-end:1", null);
    expect(s.status).toBe("ended");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/lib/stores/containerStream.svelte.test.ts; echo "X=$?"`
Expected: FAIL — module `./containerStream.svelte` not found.

- [ ] **Step 4: Implement `ContainerStream`**

`apps/desktop/src/lib/stores/containerStream.svelte.ts` — move the stream plumbing out of `logSession.svelte.ts` (lines 43–50, 76–144, 214–253 of the current file):

```ts
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
  ) {
    this.namespace = namespace;
    this.pod = pod;
    this.container = container;
    this.#onLines = onLines;
    this.#params = params;
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

  /** Forget the resume point so the next start() tails fresh. */
  resetResume(): void {
    this.#lastTime = undefined;
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
```

- [ ] **Step 5: Run the new test — expect PASS**

Run: `cd apps/desktop && pnpm vitest run src/lib/stores/containerStream.svelte.test.ts; echo "X=$?"`

- [ ] **Step 6: Rewire `LogSession` to delegate to one `ContainerStream`**

In `logSession.svelte.ts`: delete the moved plumbing (`#streamId`, `#unlisteners`, `#lastTime`, `#retryTimer`, `#generation`, `#start` stream body, `#onStreamEnd`, `#scheduleReconnect`, `retryNow` body, `#teardownStream`) and replace with:

```ts
import { ContainerStream, type StreamParams, type StreamStatus } from "./containerStream.svelte";

export type SessionStatus = StreamStatus; // unchanged union, re-exported for callers

export class LogSession {
  // ... existing $state fields minus status/error/reconnectAttempt/nextRetryAt ...
  #streams = $state<ContainerStream[]>([]);

  /** Aggregate over sub-streams (single mode: exactly one). Order matters. */
  status = $derived.by((): SessionStatus => {
    const st = this.#streams.map((s) => s.status);
    if (st.length === 0) return "connecting";
    if (st.includes("streaming")) return "streaming";
    if (st.includes("connecting")) return "connecting";
    if (st.includes("reconnecting")) return "reconnecting";
    if (st.every((s) => s === "error")) return "error";
    return "ended";
  });
  error = $derived(this.#streams.find((s) => s.error)?.error ?? null);
  nextRetryAt = $derived.by(() => {
    const ts = this.#streams.map((s) => s.nextRetryAt).filter((t): t is number => t !== null);
    return ts.length ? Math.min(...ts) : null;
  });
  reconnectAttempt = $derived(Math.max(0, ...this.#streams.map((s) => s.reconnectAttempt)));

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
    await this.#stopStreams();
    this.#streams = [
      new ContainerStream(this.namespace, this.pod, this.container, this.#receive, this.#streamParams),
    ];
    await Promise.all(this.#streams.map((s) => s.start()));
  }

  retryNow(): void {
    for (const s of this.#streams) s.retryNow();
  }

  async #stopStreams(): Promise<void> {
    const streams = this.#streams;
    this.#streams = [];
    await Promise.all(streams.map((s) => s.stop()));
  }

  async close(): Promise<void> {
    await this.#stopStreams();
  }
}
```

Attenzione ai punti delicati:
- `#resetBuffer()` non può più azzerare `#lastTime` direttamente: `switchContainer`/`setPrevious`/`setTail`/`loadEarlier` ricreano gli stream via `#start()`, quindi il resume point muore con l'istanza vecchia — rimuovere il riferimento a `#lastTime` da `#resetBuffer`.
- `toggleFollow()` riavvia con `void this.#start()` quando `status === "ended" && !this.previous` — invariato, ora ricrea lo stream.
- Il campo `status` era `$state` scritto in più punti: rimuovere TUTTE le scritture (`this.status = ...`) da LogSession; lo stato vive nei sub-stream. `open()` in caso di errore `getPodContainers` non può più fare `this.status = "error"`: introdurre `#openError = $state<string | null>(null)` e includerlo negli aggregati:
  `status` → se `#openError` non-null ritorna `"error"` prima di guardare gli stream; `error` → `#openError ?? …`.

- [ ] **Step 7: Run the full existing suite — refactor must be invisible**

Run: `cd apps/desktop && pnpm vitest run; echo "X=$?"`
Expected: PASS, incluso `logSession.svelte.test.ts` NON modificato.

- [ ] **Step 8: Lint + typecheck**

Run: `cd apps/desktop && pnpm check && pnpm lint; echo "X=$?"`

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/lib/stores/containerStream.svelte.ts apps/desktop/src/lib/stores/containerStream.svelte.test.ts apps/desktop/src/lib/stores/logSession.svelte.ts apps/desktop/src/lib/tauri.ts
git commit -m "refactor(desktop): extract ContainerStream from LogSession"
```

---

### Task 2: Merged mode in `LogSession` + `logPanel` (PR2)

**Files:**
- Modify: `apps/desktop/src/lib/stores/logSession.svelte.ts`
- Modify: `apps/desktop/src/lib/stores/logPanel.svelte.ts` (nessun cambio atteso: `rememberContainer` persiste già stringhe arbitrarie — verificare soltanto)
- Test: `apps/desktop/src/lib/stores/logSession.svelte.test.ts` (append new describe block)

**Interfaces:**
- Consumes: `ContainerStream` (Task 1 exact API).
- Produces: `export const ALL_CONTAINERS = "*"`; `LogSession.merged: boolean` ($derived `this.container === ALL_CONTAINERS`); merged `open()`/`switchContainer(ALL_CONTAINERS)` spawn one stream per entry of `containers` (init inclusi); `setPrevious()` guard: no-op when merged.

- [ ] **Step 1: Write failing tests (append to `logSession.svelte.test.ts`)**

Il file di test esistente ha già: mock di `$lib/tauri` (con `getPodContainers` → fixture), mock eventi con capture, helper `emit`. Fixture multi-container da usare: `[{ name: "worker", init: false, ... }, { name: "envoy", init: false, ... }, { name: "init-migrate", init: true, ... }]` (rispettare la shape `ContainerDetail` del mock esistente). `streamPodLog` mock: far tornare id incrementali ("1", "2", "3") per distinguere gli stream.

```ts
describe("merged all-containers mode", () => {
  it("opens one stream per container, init included", async () => {
    const s = new LogSession("ns", "pod", ALL_CONTAINERS);
    await s.open();
    expect(streamPodLog).toHaveBeenCalledTimes(3);
    const containersArg = vi.mocked(streamPodLog).mock.calls.map((c) => c[3].container);
    expect(containersArg).toEqual(["worker", "envoy", "init-migrate"]);
  });

  it("interleaves tagged lines into one ring by receive order", async () => {
    const s = new LogSession("ns", "pod", ALL_CONTAINERS);
    await s.open();
    emit("pod-log-line:1", line("from worker"));
    emit("pod-log-line:2", line("from envoy"));
    emit("pod-log-line:1", line("worker again"));
    await flushTimers();
    expect(s.ring.lines.map((l) => l.container)).toEqual(["worker", "envoy", "worker"]);
  });

  it("stays streaming when one stream drops, reconnecting when all drop", async () => {
    const s = new LogSession("ns", "pod", ALL_CONTAINERS);
    await s.open();
    emit("pod-log-end:1", null);
    expect(s.status).toBe("streaming");      // envoy + init still live
    emit("pod-log-end:2", null);
    emit("pod-log-end:3", null);
    expect(s.status).toBe("reconnecting");
  });

  it("retryNow fans out to every waiting stream", async () => {
    const s = new LogSession("ns", "pod", ALL_CONTAINERS);
    await s.open();
    vi.mocked(streamPodLog).mockClear();
    emit("pod-log-end:1", null);
    emit("pod-log-end:2", null);
    emit("pod-log-end:3", null);
    s.retryNow();
    await vi.waitFor(() => expect(streamPodLog).toHaveBeenCalledTimes(3));
  });

  it("setPrevious is a no-op in merged mode", async () => {
    const s = new LogSession("ns", "pod", ALL_CONTAINERS);
    await s.open();
    await s.setPrevious(true);
    expect(s.previous).toBe(false);
  });

  it("switching merged ↔ single preserves the panel search query", async () => {
    // logPanel-level (usare gli helper di logPanel.svelte.test.ts; LogPanelStore
    // non è esportata — usare il singleton `logPanel` o il pattern del file di test)
    const panel = logPanel;
    await panel.open({ namespace: "ns", name: "pod" });
    panel.search.setQuery("err");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1);
    await panel.active!.switchContainer(ALL_CONTAINERS);
    expect(panel.search.query).toBe("err");
    await panel.active!.switchContainer("worker");
    expect(panel.search.query).toBe("err");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`ALL_CONTAINERS` not exported)

Run: `cd apps/desktop && pnpm vitest run src/lib/stores/logSession.svelte.test.ts; echo "X=$?"`

- [ ] **Step 3: Implement merged mode**

In `logSession.svelte.ts`:

```ts
/** Sentinel container value: merged stream of every container in the pod. */
export const ALL_CONTAINERS = "*";

export class LogSession {
  merged = $derived(this.container === ALL_CONTAINERS);

  async open(): Promise<void> {
    // ... getPodContainers invariato, MA il fallback default non deve
    // scartare il sentinel:
    if (
      this.container !== ALL_CONTAINERS &&
      (!this.container || !this.containers.some((c) => c.name === this.container))
    ) {
      this.container = this.containers.find((c) => !c.init)?.name ?? this.containers[0]?.name ?? null;
    }
    await this.#start();
  }

  async #start(): Promise<void> {
    await this.#stopStreams();
    const targets = this.merged ? this.containers.map((c) => c.name) : [this.container];
    this.#streams = targets.map(
      (name) => new ContainerStream(this.namespace, this.pod, name, this.#receive, this.#streamParams),
    );
    await Promise.all(this.#streams.map((s) => s.start()));
  }

  async setPrevious(on: boolean): Promise<void> {
    if (this.merged) return; // previous-instance has no meaning on a merged stream
    // ... resto invariato
  }
}
```

`switchContainer(ALL_CONTAINERS)` funziona già col codice esistente (set container → resetBuffer → #start). Se `previous` era attivo quando si passa a merged: `switchContainer` deve azzerarlo (`if (name === ALL_CONTAINERS) this.previous = false;`).

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd apps/desktop && pnpm vitest run; echo "X=$?"`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/stores/logSession.svelte.ts apps/desktop/src/lib/stores/logSession.svelte.test.ts
git commit -m "feat(desktop): merged all-containers session mode"
```

---

### Task 3: Identity color helper + source column in `LogLineRow`

**Files:**
- Create: `apps/desktop/src/lib/stores/identityColor.ts`
- Modify: `apps/desktop/src/lib/components/logpanel/LogLineRow.svelte`
- Modify: `apps/desktop/src/lib/components/logpanel/LogBody.svelte` (pass source info when merged)
- Test: `apps/desktop/src/lib/stores/identityColor.test.ts`, extend `apps/desktop/src/lib/components/logpanel/log-body.test.ts`

**Interfaces:**
- Consumes: `ContainerDetail[]` (has `name` and `init` fields), `KeyedLogLine.container`.
- Produces: `identityColorFor(containers: ContainerDetail[], name: string): string` → CSS var string; `LogLineRow` new optional prop `source?: { name: string; color: string } | null`.

- [ ] **Step 1: Failing test for the color helper**

```ts
import { identityColorFor } from "./identityColor";

const cs = [
  { name: "worker", init: false },
  { name: "envoy", init: false },
  { name: "extra", init: false },
  { name: "init-migrate", init: true },
] as ContainerDetail[];

it("init containers are always amber", () => {
  expect(identityColorFor(cs, "init-migrate")).toBe("var(--color-cluster-amber)");
});
it("regular containers cycle blue → teal by spec order", () => {
  expect(identityColorFor(cs, "worker")).toBe("var(--color-cluster-blue)");
  expect(identityColorFor(cs, "envoy")).toBe("var(--color-cluster-teal)");
  expect(identityColorFor(cs, "extra")).toBe("var(--color-cluster-blue)"); // cycles
});
it("unknown container falls back to blue", () => {
  expect(identityColorFor(cs, "ghost")).toBe("var(--color-cluster-blue)");
});
```

Run: `cd apps/desktop && pnpm vitest run src/lib/stores/identityColor.test.ts; echo "X=$?"` → FAIL.

- [ ] **Step 2: Implement**

```ts
/**
 * Identity palette for the merged log view source column (§Line anatomy):
 * init containers always amber; regular containers cycle blue → teal by
 * pod-spec order. Identity, never status colors.
 */
import type { ContainerDetail } from "$lib/tauri";

const CYCLE = ["var(--color-cluster-blue)", "var(--color-cluster-teal)"];

export function identityColorFor(containers: ContainerDetail[], name: string): string {
  const c = containers.find((x) => x.name === name);
  if (c?.init) return "var(--color-cluster-amber)";
  const regulars = containers.filter((x) => !x.init);
  const i = regulars.findIndex((x) => x.name === name);
  return CYCLE[(i >= 0 ? i : 0) % CYCLE.length];
}
```

Run test → PASS.

- [ ] **Step 3: Source column in `LogLineRow`**

Add prop and column (after the timestamp span, before severity — order per handoff §Line anatomy):

```svelte
let { line, timestamps, wrap, search = null, source = null }: {
  // ... existing ...
  source?: { name: string; color: string } | null;
} = $props();
```

```svelte
{#if source}
  <span
    class="w-[52px] shrink-0 truncate font-mono text-[9.5px] font-semibold"
    style="color: {source.color};">{source.name}</span>
{/if}
```

- [ ] **Step 4: Wire from `LogBody`**

Dove `LogBody.svelte` renderizza `<LogLineRow …>`: passare

```svelte
source={session.merged && row.container
  ? { name: row.container, color: identityColorFor(session.containers, row.container) }
  : null}
```

(adattare `row` al nome della variabile dell'`{#each}` esistente; import di `identityColorFor`).

- [ ] **Step 5: Extend `log-body.test.ts`**

Test: rendering in merged mode con righe taggate mostra il nome container nella colonna source con lo stile identity; in single mode la colonna è assente. Seguire il pattern di render/asserzione già usato nel file (testing-library o render harness esistente).

- [ ] **Step 6: Run full suite + commit**

Run: `cd apps/desktop && pnpm vitest run; echo "X=$?"`

```bash
git add apps/desktop/src/lib/stores/identityColor.ts apps/desktop/src/lib/stores/identityColor.test.ts apps/desktop/src/lib/components/logpanel/LogLineRow.svelte apps/desktop/src/lib/components/logpanel/LogBody.svelte apps/desktop/src/lib/components/logpanel/log-body.test.ts
git commit -m "feat(desktop): identity-colored source column in merged log view"
```

---

### Task 4: Toolbar — picker entry, disabled previous chip, export filename

**Files:**
- Modify: `apps/desktop/src/lib/components/logpanel/LogToolbar.svelte`
- Test: extend `apps/desktop/src/lib/components/logpanel/log-toolbar.test.ts`

**Interfaces:**
- Consumes: `ALL_CONTAINERS`, `session.merged` (Task 2).
- Produces: picker menu item labeled `all containers` (sub "merged stream, color-tagged"); merged export filename `<pod>_all[_full].log`.

- [ ] **Step 1: Failing tests (extend `log-toolbar.test.ts`, pattern esistente del file)**

1. Il menu del picker contiene la voce "all containers" dopo i gruppi containers/init, e cliccarla chiama `switchContainer(ALL_CONTAINERS)`.
2. In merged mode il previous-instance chip NON è renderizzato (oggi appare solo `{#if selected has restarts}` — aggiungere condizione `!session.merged`).
3. In merged mode il label del picker mostra `all containers`.
4. Export: con `session.container === ALL_CONTAINERS`, `exportVisible()` produce filename `pod_all.log` e `exportFull()` → `pod_all_full.log` (mockare `exportLog` come già fa il file e asserire il primo argomento).

Run: `cd apps/desktop && pnpm vitest run src/lib/components/logpanel/log-toolbar.test.ts; echo "X=$?"` → FAIL.

- [ ] **Step 2: Implement in `LogToolbar.svelte`**

- Picker label (riga ~96): `{session.merged ? "all containers" : (session.container ?? "…")}`.
- Menu: dopo i gruppi `mains`/`inits`, separatore + voce:

```svelte
<button role="menuitem" onclick={() => pick(ALL_CONTAINERS)}>
  <span>all containers</span>
  <span class="type-caption text-text-tertiary">merged stream, color-tagged</span>
</button>
```

(riusare le classi delle voci esistenti del menu; `pick` è la funzione esistente che chiama `switchContainer`).
- Previous chip (riga ~132): condizione diventa `{#if !session.merged && selected && selected.restarts > 0}` (adattare alla condizione esistente).
- `exportFilename` (riga 46):

```ts
function exportFilename(full: boolean): string {
  const container = session.merged ? "all" : (session.container ?? "unknown");
  return `${session.pod}_${container}${full ? "_full" : ""}.log`;
}
```

- [ ] **Step 3: Run tests → PASS, full suite, commit**

Run: `cd apps/desktop && pnpm vitest run; echo "X=$?"`

```bash
git add apps/desktop/src/lib/components/logpanel/LogToolbar.svelte apps/desktop/src/lib/components/logpanel/log-toolbar.test.ts
git commit -m "feat(desktop): all-containers picker entry, merged export filename"
```

---

### Task 5: Ring bound under N producers + search preservation lock-in

**Files:**
- Test only: extend `apps/desktop/src/lib/stores/logSession.svelte.test.ts`, `apps/desktop/src/lib/stores/logPanel.svelte.test.ts`

- [ ] **Step 1: Ring bound test (logSession)**

Merged session, 3 stream: emettere 2000 righe per stream (6000 totali, sopra il cap 5000) via gli helper del file; dopo flush: `s.ring.lines.length === 5000`, `s.ring.totalAppended === 6000`, e le ultime righe sono le più recenti (asserire l'ultimo messaggio). Nessun drop sotto cap: con 1500×3 = 4500 righe, `length === 4500`.

- [ ] **Step 2: Search preservation test (logPanel)**

Nel file `logPanel.svelte.test.ts` (pattern esistente): aprire pod, `panel.search.setQuery("boom")`, `session.switchContainer(ALL_CONTAINERS)`, avanzare i timer del debounce → `panel.search.query === "boom"` e `matchIds` ricalcolati sul buffer nuovo (vuoto → 0 match, poi emetti riga matching e riverifica > 0).

- [ ] **Step 3: Run + commit**

Run: `cd apps/desktop && pnpm vitest run; echo "X=$?"`

```bash
git add apps/desktop/src/lib/stores/logSession.svelte.test.ts apps/desktop/src/lib/stores/logPanel.svelte.test.ts
git commit -m "test(desktop): merged-mode ring bound and search preservation"
```

---

### Task 6: e2e — merged view on a multi-container pod

**Files:**
- Modify: `apps/desktop/tests/e2e/tauri-mock.ts` (multi-container fixture + per-container line emission)
- Modify: `apps/desktop/tests/e2e/logpanel.spec.ts` (new spec)

- [ ] **Step 1: Extend the tauri mock**

`tauri-mock.ts` mocka i comandi Tauri nel browser. Estendere: `get_pod_containers` per il pod fixture ritorna `worker` + `envoy` + `init-migrate` (init); `stream_pod_log` registra il container richiesto e l'helper di emissione righe emette `pod-log-line:{id}` con messaggi distinti per container (`"hello from worker"`, ...). Seguire la struttura esistente del file (stream id counter, event emit helper).

- [ ] **Step 2: New spec in `logpanel.spec.ts`**

```ts
test("merged all-containers view interleaves color-tagged lines", async ({ page }) => {
  // open log panel on the multi-container pod (helper esistente nel file)
  // open container picker → click "all containers"
  await page.getByRole("menuitem", { name: /all containers/ }).click();
  // lines from both regular containers are visible
  await expect(page.getByText("hello from worker")).toBeVisible();
  await expect(page.getByText("hello from envoy")).toBeVisible();
  // source column shows the container names
  await expect(page.getByText("worker", { exact: true })).toBeVisible();
  await expect(page.getByText("envoy", { exact: true })).toBeVisible();
  // previous chip is gone in merged mode
  await expect(page.getByRole("button", { name: /previous/i })).toHaveCount(0);
});
```

(adattare selettori agli helper/nomi accessibili reali del file; il previous chip ha un accessible name — verificarlo nel componente prima di scrivere il selettore).

- [ ] **Step 3: Run e2e + full gates + commit**

Run: `cd apps/desktop && pnpm test:e2e; echo "X=$?"`
Run: `cd apps/desktop && pnpm vitest run && pnpm check && pnpm lint; echo "X=$?"`

```bash
git add apps/desktop/tests/e2e/tauri-mock.ts apps/desktop/tests/e2e/logpanel.spec.ts
git commit -m "test(desktop): e2e merged all-containers log view"
```

---

## Delivery

- PR1: branch `feat/297-desktop-merged-stream` (contiene già spec + questo piano) → Task 1. Titolo: `refactor(desktop): extract ContainerStream from LogSession (#297)`.
- PR2: branch `feat/297-desktop-merged-mode` stacked su PR1 → Task 2–6. Titolo: `feat(desktop): merged "all containers" log stream (#297)`.
- Push con account `massilp`; merge dell'utente (branch protection). Dopo il merge di PR1, PR2 va ribasata su main (pattern stacked già collaudato).
