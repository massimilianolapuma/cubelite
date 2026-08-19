# Desktop Pop-out Log Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detach a desktop log session into its own Tauri OS window (`⧉`), move + re-attach semantics, full toolbar parity (issue #298, desktop half).

**Architecture:** The pop-out `WebviewWindow` is a separate JS context running its **own** `LogSession`, seeded by a one-shot `SessionTransfer` handoff over Tauri events; re-attach reverses the transfer. Stream continuity reuses `ContainerStream`'s existing `sinceTime` reconnect mechanism. The window reuses `LogToolbar`/`LogBody` unchanged against its window-local `logPanel` singleton.

**Tech Stack:** Svelte 5 (runes), TypeScript, Tauri v2 JS APIs (`WebviewWindow`, events), vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-desktop-log-popout-design.md`

## Global Constraints

- Branch: `feat/desktop-log-popout` (already created; spec committed there).
- No Claude attribution footers in commits or PRs.
- Detached state is NOT persisted; windows do not survive relaunch.
- Detached sessions live OUTSIDE the panel's `SESSION_CAP` (6, LRU); re-attach into a full panel LRU-evicts like `openFor`.
- Window label: `logs-<key with "/" replaced by "-">`; URL `index.html?logWindow=<encodeURIComponent(key)>`; size 900×500.
- Event names verbatim: `log-window-ready:<key>`, `log-window-seed:<key>`, `log-window-reattach`, `log-window-close-all`.
- All commands run in `apps/desktop/`: tests `pnpm test`, lint `pnpm lint`, typecheck `pnpm typecheck`.
- Gate for every task: `pnpm test` green; final task adds `pnpm lint` + `pnpm typecheck`.
- Sonar duplication gate: reuse existing components/helpers, no copy-pasted view bodies.

---

### Task 1: `ContainerStream` initial `sinceTime` + `LogSession` seeding

**Files:**
- Modify: `apps/desktop/src/lib/stores/containerStream.svelte.ts`
- Modify: `apps/desktop/src/lib/stores/logSession.svelte.ts`
- Test: `apps/desktop/src/lib/stores/logSession.svelte.test.ts` (append to existing describe or a new `describe("LogSession seeding")`)

**Interfaces:**
- Consumes: existing `ContainerStream` constructor `(namespace, pod, container, onLines, params, onEnd?)`; `LogSession` constructor `(namespace, pod, initialContainer?)`; `LogRing.append(batch)` (re-keys ids itself), `LogRing.totalAppended`.
- Produces (used by Tasks 2–4):
  - `ContainerStream` constructor gains optional 7th param `initialSinceTime?: string` — pre-loads the private `#lastTime` so the FIRST `start()` already streams from that point (today `#lastTime` only fills after the first received line).
  - `export type SessionSeed = { lines: KeyedLogLine[]; previous: boolean; tailLines: number; following: boolean }` (in `logSession.svelte.ts`).
  - `LogSession` constructor gains optional 4th param `seed?: SessionSeed`. A seeded session: ring pre-populated (before `open()`), `previous`/`tailLines`/`following` taken from the seed, `seenCount` set to the ring's `totalAppended` (the "new lines" pill state is not preserved across a transfer — accepted), and its streams start with `initialSinceTime` = the last seeded line's `time` (last line with a non-null `time`, scanning from the end).

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/lib/stores/logSession.svelte.test.ts` (inside the file, as a new top-level `describe` — the file's existing `vi.mock` setup, `emitLine` helper, and `beforeEach` apply to the whole file; reuse them):

```ts
describe("LogSession seeding (#298 pop-out)", () => {
  const seedLines = (n: number, lastTime = "2026-08-19T10:00:05Z"): KeyedLogLine[] =>
    Array.from({ length: n }, (_, i) => ({
      id: i,
      pod: "api-0",
      namespace: "default",
      time: i === n - 1 ? lastTime : "2026-08-19T10:00:00Z",
      level: "info" as const,
      message: `seeded ${i}`,
    }));

  it("pre-populates the ring before open() and keeps it on open()", async () => {
    const session = new LogSession("default", "api-0", "worker", {
      lines: seedLines(3),
      previous: false,
      tailLines: 500,
      following: true,
    });
    expect(session.ring.lines).toHaveLength(3);
    await session.open();
    // open() must NOT reset the seeded buffer
    expect(session.ring.lines).toHaveLength(3);
    expect(session.ring.lines[0]?.message).toBe("seeded 0");
  });

  it("adopts previous/tailLines/following from the seed", () => {
    const session = new LogSession("default", "api-0", "worker", {
      lines: seedLines(1),
      previous: false,
      tailLines: 1000,
      following: false,
    });
    expect(session.tailLines).toBe(1000);
    expect(session.following).toBe(false);
    expect(session.seenCount).toBe(session.ring.totalAppended);
  });

  it("starts its stream with sinceTime = last seeded line's time", async () => {
    const session = new LogSession("default", "api-0", "worker", {
      lines: seedLines(3, "2026-08-19T10:00:05Z"),
      previous: false,
      tailLines: 500,
      following: true,
    });
    await session.open();
    expect(vi.mocked(streamPodLog).mock.lastCall?.[3]).toMatchObject({
      sinceTime: "2026-08-19T10:00:05Z",
    });
  });

  it("unseeded session behaves as before (no sinceTime on first start)", async () => {
    const session = new LogSession("default", "api-0", "worker");
    await session.open();
    expect(vi.mocked(streamPodLog).mock.lastCall?.[3].sinceTime).toBeUndefined();
  });
});
```

Add `KeyedLogLine` to the test file's imports (`import type { KeyedLogLine } from "./logs.svelte";`).

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `pnpm --dir apps/desktop test -- logSession`
Expected: FAIL — `LogSession` constructor does not accept a 4th argument / `sinceTime` undefined.

- [ ] **Step 3: Implement**

`containerStream.svelte.ts` — constructor tail (keep every existing line; add the parameter and one assignment):

```ts
  constructor(
    namespace: string,
    pod: string,
    container: string | null,
    onLines: (lines: LogLine[]) => void,
    params: () => StreamParams,
    /** Called synchronously right before the status transition on stream end (e.g. to force a final flush). */
    onEnd: () => void = () => {},
    /** Seeded start point (#298 pop-out handoff): stream from here on the
     * FIRST start, exactly as #lastTime does on reconnect. */
    initialSinceTime?: string,
  ) {
    this.namespace = namespace;
    this.pod = pod;
    this.container = container;
    this.#onLines = onLines;
    this.#params = params;
    this.#onEndCallback = onEnd;
    this.#lastTime = initialSinceTime;
  }
```

`logSession.svelte.ts`:

Add after the `SessionStatus` re-export:

```ts
/** One-shot state handoff for the pop-out window (#298): ring contents plus
 * the stream settings the receiving side must adopt before opening. */
export type SessionSeed = {
  lines: KeyedLogLine[];
  previous: boolean;
  tailLines: number;
  following: boolean;
};
```

Add the import: `import type { KeyedLogLine } from "./logs.svelte";`

Constructor and seeding:

```ts
  /** sinceTime for the first stream start; set once from the seed. */
  #initialSinceTime: string | undefined;

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
```

Note: `LogRing.append` re-keys ids itself (`{ ...l, id: this.#nextId++ }`), so passing `KeyedLogLine[]` is fine — old ids are overwritten.

In `#start()`, pass the initial sinceTime to each new stream and consume it (one-shot — restarts after container/tail changes must not resurrect it; the stream's own `#lastTime` carries forward on reconnects):

```ts
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
```

No other change: `open()` does not touch the ring today (only `switchContainer`/`setTail`/etc. call `#resetBuffer`), so the seeded buffer survives `open()` as-is — the test pins that.

- [ ] **Step 4: Run tests, verify green (new + all pre-existing logSession tests)**

Run: `pnpm --dir apps/desktop test -- logSession`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/stores/containerStream.svelte.ts apps/desktop/src/lib/stores/logSession.svelte.ts apps/desktop/src/lib/stores/logSession.svelte.test.ts
git commit -m "feat(desktop): LogSession seeding and initial sinceTime for pop-out handoff (#298)"
```

---

### Task 2: `SessionTransfer` + serialization + `logPanel.openSeeded`

**Files:**
- Create: `apps/desktop/src/lib/stores/sessionTransfer.ts`
- Modify: `apps/desktop/src/lib/stores/logPanel.svelte.ts`
- Test: `apps/desktop/src/lib/stores/sessionTransfer.test.ts`, `apps/desktop/src/lib/stores/logPanel.svelte.test.ts` (append)

**Interfaces:**
- Consumes: `LogSession` + `SessionSeed` (Task 1), `logPanel` internals (`sessions`, `focus`, `SESSION_CAP` LRU logic in `openFor`), `app.kubeconfigPath` / `app.activeCluster`.
- Produces (used by Tasks 3–4):
  - `sessionTransfer.ts`:
    ```ts
    export type SessionTransfer = {
      key: string;
      namespace: string;
      pod: string;
      container: string | null;
      previous: boolean;
      tailLines: number;
      following: boolean;
      lines: KeyedLogLine[];
      kubeconfigPath: string;
      activeCluster: string | null;
    };
    export function serializeSession(session: LogSession): SessionTransfer;
    export function isSessionTransfer(v: unknown): v is SessionTransfer;
    ```
  - `logPanel.openSeeded(transfer: SessionTransfer): Promise<void>` — creates a seeded `LogSession`, applies the same `SESSION_CAP` LRU eviction as `openFor`, focuses it, calls `session.open()`. If a session with that key already exists, it just focuses it (defensive; normal flows prevent this).

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/lib/stores/sessionTransfer.test.ts` (new file — no Tauri mocks needed for pure serialization, but `LogSession` construction pulls in `$lib/tauri` imports; mirror the mock preamble from `logSession.svelte.test.ts`):

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("$lib/tauri", async (importOriginal) => {
  const original = await importOriginal<typeof import("$lib/tauri")>();
  return {
    ...original,
    streamPodLog: vi.fn(async () => "1"),
    stopLogs: vi.fn(async () => {}),
    getPodContainers: vi.fn(async () => []),
  };
});

import { app } from "./app.svelte";
import { LogSession } from "./logSession.svelte";
import { isSessionTransfer, serializeSession } from "./sessionTransfer";

describe("SessionTransfer", () => {
  it("serializes a session round-trip compatible with SessionSeed", () => {
    app.kubeconfigPath = "/tmp/kc";
    app.activeCluster = "ctx-1";
    const session = new LogSession("default", "api-0", "worker", {
      lines: [
        { id: 0, pod: "api-0", namespace: "default", time: "2026-08-19T10:00:00Z", level: "info", message: "hello" },
      ],
      previous: false,
      tailLines: 1000,
      following: false,
    });
    const t = serializeSession(session);
    expect(t).toMatchObject({
      key: "default/api-0",
      namespace: "default",
      pod: "api-0",
      container: "worker",
      previous: false,
      tailLines: 1000,
      following: false,
      kubeconfigPath: "/tmp/kc",
      activeCluster: "ctx-1",
    });
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]?.message).toBe("hello");
    // JSON round-trip (what the Tauri event does) preserves the guard
    expect(isSessionTransfer(JSON.parse(JSON.stringify(t)))).toBe(true);
  });

  it("isSessionTransfer rejects malformed payloads", () => {
    expect(isSessionTransfer(null)).toBe(false);
    expect(isSessionTransfer({})).toBe(false);
    expect(isSessionTransfer({ key: "a/b", lines: "nope" })).toBe(false);
  });
});
```

Append to `apps/desktop/src/lib/stores/logPanel.svelte.test.ts` (reuse its existing mock preamble/style — read the file's setup first and follow it):

```ts
describe("logPanel.openSeeded (#298 pop-out)", () => {
  const transfer = (key: string): SessionTransfer => {
    const [namespace = "default", pod = "x"] = key.split("/");
    return {
      key, namespace, pod,
      container: "worker",
      previous: false,
      tailLines: 500,
      following: true,
      lines: [{ id: 0, pod, namespace, time: "2026-08-19T10:00:00Z", level: "info", message: "seeded" }],
      kubeconfigPath: "/tmp/kc",
      activeCluster: null,
    };
  };

  it("creates a seeded focused session", async () => {
    await logPanel.openSeeded(transfer("default/re-1"));
    expect(logPanel.activeKey).toBe("default/re-1");
    expect(logPanel.active?.ring.lines).toHaveLength(1);
    expect(logPanel.active?.container).toBe("worker");
  });

  it("focuses instead of duplicating when the key already exists", async () => {
    await logPanel.openFor({ namespace: "default", name: "re-2" });
    const count = logPanel.sessions.length;
    await logPanel.openSeeded(transfer("default/re-2"));
    expect(logPanel.sessions.length).toBe(count);
    expect(logPanel.activeKey).toBe("default/re-2");
  });

  it("LRU-evicts when the panel is full", async () => {
    for (let i = 0; i < 6; i++) {
      await logPanel.openFor({ namespace: "default", name: `p-${i}` });
    }
    await logPanel.openSeeded(transfer("default/re-3"));
    expect(logPanel.sessions.length).toBe(6);
    expect(logPanel.sessions.some((s) => s.key === "default/p-0")).toBe(false);
    expect(logPanel.activeKey).toBe("default/re-3");
  });
});
```

(Adapt imports to the file's existing ones; add `import type { SessionTransfer } from "./sessionTransfer";`. If the existing file resets `logPanel` state between tests via a helper, use it; otherwise call `await logPanel.closeAll()` in a `beforeEach` for this describe.)

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `pnpm --dir apps/desktop test -- sessionTransfer logPanel`
Expected: FAIL — module `./sessionTransfer` not found; `openSeeded` is not a function.

- [ ] **Step 3: Implement**

`apps/desktop/src/lib/stores/sessionTransfer.ts`:

```ts
/**
 * One-shot session handoff payload for the pop-out log window (#298):
 * everything the receiving JS context needs to recreate the session —
 * identity, stream settings, ring contents, and the kube connection the
 * pop-out (which never runs full app boot) must adopt.
 */
import type { KeyedLogLine } from "./logs.svelte";
import type { LogSession } from "./logSession.svelte";
import { app } from "./app.svelte";

export type SessionTransfer = {
  key: string;
  namespace: string;
  pod: string;
  container: string | null;
  previous: boolean;
  tailLines: number;
  following: boolean;
  lines: KeyedLogLine[];
  kubeconfigPath: string;
  activeCluster: string | null;
};

export function serializeSession(session: LogSession): SessionTransfer {
  return {
    key: session.key,
    namespace: session.namespace,
    pod: session.pod,
    container: session.container,
    previous: session.previous,
    tailLines: session.tailLines,
    following: session.following,
    lines: [...session.ring.lines],
    kubeconfigPath: app.kubeconfigPath,
    activeCluster: app.activeCluster,
  };
}

/** Runtime guard for event payloads crossing the window boundary. */
export function isSessionTransfer(v: unknown): v is SessionTransfer {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.key === "string" &&
    typeof t.namespace === "string" &&
    typeof t.pod === "string" &&
    (t.container === null || typeof t.container === "string") &&
    typeof t.previous === "boolean" &&
    typeof t.tailLines === "number" &&
    typeof t.following === "boolean" &&
    Array.isArray(t.lines) &&
    typeof t.kubeconfigPath === "string" &&
    (t.activeCluster === null || typeof t.activeCluster === "string")
  );
}
```

`logPanel.svelte.ts` — add import `import type { SessionTransfer } from "./sessionTransfer";` and the method after `openFor`:

```ts
  /** Recreates a transferred session (#298): pop-out bootstrap in the log
   * window, re-attach in the main window. Same LRU eviction as `openFor`. */
  async openSeeded(transfer: SessionTransfer): Promise<void> {
    const existing = this.sessions.find((s) => s.key === transfer.key);
    if (existing) {
      this.focus(transfer.key);
      return;
    }
    while (this.sessions.length >= SESSION_CAP) {
      const lruKey = this.#focusOrder[0];
      if (lruKey === undefined) break;
      await this.closeSession(lruKey);
    }
    const session = new LogSession(transfer.namespace, transfer.pod, transfer.container, {
      lines: transfer.lines,
      previous: transfer.previous,
      tailLines: transfer.tailLines,
      following: transfer.following,
    });
    this.sessions = [...this.sessions, session];
    this.activeKey = transfer.key;
    this.#focusOrder = [...this.#focusOrder.filter((k) => k !== transfer.key), transfer.key];
    this.search.clear();
    this.search.attach(() => session.ring.lines);
    await session.open();
  }
```

- [ ] **Step 4: Run tests, verify green**

Run: `pnpm --dir apps/desktop test -- sessionTransfer logPanel`
Expected: PASS (new + all pre-existing logPanel tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/stores/sessionTransfer.ts apps/desktop/src/lib/stores/sessionTransfer.test.ts apps/desktop/src/lib/stores/logPanel.svelte.ts apps/desktop/src/lib/stores/logPanel.svelte.test.ts
git commit -m "feat(desktop): SessionTransfer serialization and logPanel.openSeeded (#298)"
```

---

### Task 3: `logWindows` store — detach orchestration, re-attach listener, close-all

**Files:**
- Create: `apps/desktop/src/lib/stores/logWindows.svelte.ts`
- Test: `apps/desktop/src/lib/stores/logWindows.svelte.test.ts`

**Interfaces:**
- Consumes: `serializeSession` / `isSessionTransfer` / `SessionTransfer` (Task 2), `logPanel` (`sessions`, `closeSession`, `openSeeded`), Tauri APIs `WebviewWindow` (`@tauri-apps/api/webviewWindow`), `emit`, `emitTo`, `listen` (`@tauri-apps/api/event`).
- Produces (used by Task 4):
  - `export function windowLabelFor(key: string): string` — `"logs-" + key.replaceAll("/", "-")`
  - `logWindows.init(): Promise<void>` — registers the `log-window-reattach` listener (main window only; called once from `+page.svelte`'s main branch). Import of the module has NO side effects.
  - `logWindows.detach(key: string): Promise<void>` — serialize → spawn `WebviewWindow` → await `log-window-ready:<key>` → `emitTo(label, "log-window-seed:<key>", transfer)` → `logPanel.closeSession(key)`. No-op if the key has no panel session.
  - `logWindows.has(key: string): boolean` — true while a window for the key is registered.
  - `logWindows.focus(key: string): Promise<void>` — `WebviewWindow.getByLabel(label)` → `setFocus()`.
  - `logWindows.closeAll(): Promise<void>` — `emit("log-window-close-all")` and clears the registry.
  - Registry self-cleans: on re-attach for a key, and on the spawned window's `onCloseRequested`-driven destroy the entry is dropped (re-attach event and the `tauri://destroyed` event both clear it).

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/lib/stores/logWindows.svelte.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const eventListeners = new Map<string, (event: { payload: unknown }) => void>();
const emitted: Array<{ target: string | null; name: string; payload?: unknown }> = [];
const spawned: Array<{ label: string; options: Record<string, unknown> }> = [];
const focusCalls: string[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
    eventListeners.set(name, cb);
    return () => eventListeners.delete(name);
  }),
  emit: vi.fn(async (name: string, payload?: unknown) => {
    emitted.push({ target: null, name, payload });
  }),
  emitTo: vi.fn(async (target: string, name: string, payload?: unknown) => {
    emitted.push({ target, name, payload });
  }),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => {
  class FakeWebviewWindow {
    label: string;
    constructor(label: string, options: Record<string, unknown>) {
      this.label = label;
      spawned.push({ label, options });
    }
    // Tauri fires window lifecycle events through listen(); tests trigger
    // the ready event directly via eventListeners, so `once` here is only
    // used for tauri://destroyed cleanup.
    once = vi.fn(async (name: string, cb: () => void) => {
      eventListeners.set(`${this.label}:${name}`, cb as never);
      return () => eventListeners.delete(`${this.label}:${name}`);
    });
    setFocus = vi.fn(async () => {
      focusCalls.push(this.label);
    });
    static getByLabel = vi.fn(async (label: string) =>
      spawned.some((s) => s.label === label) ? new FakeWebviewWindow(label, {}) : null,
    );
  }
  return { WebviewWindow: FakeWebviewWindow };
});

vi.mock("./logPanel.svelte", () => ({
  logPanel: {
    sessions: [] as unknown[],
    closeSession: vi.fn(async () => {}),
    openSeeded: vi.fn(async () => {}),
  },
}));
vi.mock("./sessionTransfer", async (importOriginal) => {
  const original = await importOriginal<typeof import("./sessionTransfer")>();
  return {
    ...original,
    serializeSession: vi.fn(() => FAKE_TRANSFER),
  };
});

const FAKE_TRANSFER = {
  key: "default/api-0", namespace: "default", pod: "api-0", container: "worker",
  previous: false, tailLines: 500, following: true,
  lines: [], kubeconfigPath: "/tmp/kc", activeCluster: null,
};

import { logPanel } from "./logPanel.svelte";
import { logWindows, windowLabelFor } from "./logWindows.svelte";

describe("logWindows", () => {
  beforeEach(() => {
    eventListeners.clear();
    emitted.length = 0;
    spawned.length = 0;
    focusCalls.length = 0;
    vi.clearAllMocks();
    (logPanel.sessions as unknown[]).length = 0;
  });

  it("windowLabelFor slugs the key", () => {
    expect(windowLabelFor("default/api-0")).toBe("logs-default-api-0");
  });

  it("detach: spawn → ready → seed → close local session", async () => {
    (logPanel.sessions as unknown[]).push({ key: "default/api-0" });
    const detachPromise = logWindows.detach("default/api-0");
    await vi.waitFor(() => {
      expect(eventListeners.has("log-window-ready:default/api-0")).toBe(true);
    });
    expect(spawned[0]?.label).toBe("logs-default-api-0");
    // seed not sent before ready
    expect(emitted.filter((e) => e.name.startsWith("log-window-seed:"))).toHaveLength(0);
    eventListeners.get("log-window-ready:default/api-0")?.({ payload: null });
    await detachPromise;
    const seed = emitted.find((e) => e.name === "log-window-seed:default/api-0");
    expect(seed?.target).toBe("logs-default-api-0");
    expect(seed?.payload).toBe(FAKE_TRANSFER);
    expect(vi.mocked(logPanel.closeSession)).toHaveBeenCalledWith("default/api-0");
    expect(logWindows.has("default/api-0")).toBe(true);
  });

  it("detach is a no-op without a panel session", async () => {
    await logWindows.detach("default/ghost");
    expect(spawned).toHaveLength(0);
  });

  it("init wires re-attach: valid payload → openSeeded, registry cleared", async () => {
    await logWindows.init();
    (logPanel.sessions as unknown[]).push({ key: "default/api-0" });
    const p = logWindows.detach("default/api-0");
    await vi.waitFor(() => eventListeners.has("log-window-ready:default/api-0"));
    eventListeners.get("log-window-ready:default/api-0")?.({ payload: null });
    await p;
    eventListeners.get("log-window-reattach")?.({ payload: FAKE_TRANSFER });
    await vi.waitFor(() => {
      expect(vi.mocked(logPanel.openSeeded)).toHaveBeenCalledWith(FAKE_TRANSFER);
    });
    expect(logWindows.has("default/api-0")).toBe(false);
  });

  it("init ignores malformed re-attach payloads", async () => {
    await logWindows.init();
    eventListeners.get("log-window-reattach")?.({ payload: { junk: true } });
    expect(vi.mocked(logPanel.openSeeded)).not.toHaveBeenCalled();
  });

  it("closeAll broadcasts and clears the registry", async () => {
    (logPanel.sessions as unknown[]).push({ key: "default/api-0" });
    const p = logWindows.detach("default/api-0");
    await vi.waitFor(() => eventListeners.has("log-window-ready:default/api-0"));
    eventListeners.get("log-window-ready:default/api-0")?.({ payload: null });
    await p;
    await logWindows.closeAll();
    expect(emitted.some((e) => e.name === "log-window-close-all")).toBe(true);
    expect(logWindows.has("default/api-0")).toBe(false);
  });

  it("focus targets the window by label", async () => {
    (logPanel.sessions as unknown[]).push({ key: "default/api-0" });
    const p = logWindows.detach("default/api-0");
    await vi.waitFor(() => eventListeners.has("log-window-ready:default/api-0"));
    eventListeners.get("log-window-ready:default/api-0")?.({ payload: null });
    await p;
    await logWindows.focus("default/api-0");
    expect(focusCalls).toContain("logs-default-api-0");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --dir apps/desktop test -- logWindows`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/desktop/src/lib/stores/logWindows.svelte.ts`:

```ts
/**
 * Main-window registry of popped-out log windows (#298): spawns them,
 * runs the one-shot seed handoff, receives re-attach transfers, and
 * broadcasts close-all (cluster switch / app quit). Import is
 * side-effect-free — `init()` is called once from the main window's page.
 * Never imported by pop-out window code paths.
 */
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { logPanel } from "./logPanel.svelte";
import { isSessionTransfer, serializeSession } from "./sessionTransfer";

export function windowLabelFor(key: string): string {
  return `logs-${key.replaceAll("/", "-")}`;
}

class LogWindowsStore {
  /** key → window label of the live pop-out. */
  #open = new Map<string, string>();

  has(key: string): boolean {
    return this.#open.has(key);
  }

  /** Main-window bootstrap: receive re-attach transfers from pop-outs. */
  async init(): Promise<void> {
    await listen<unknown>("log-window-reattach", (event) => {
      if (!isSessionTransfer(event.payload)) return;
      const transfer = event.payload;
      this.#open.delete(transfer.key);
      void logPanel.openSeeded(transfer);
    });
  }

  /** Serialize → spawn → await ready → seed → close the local session. */
  async detach(key: string): Promise<void> {
    const session = logPanel.sessions.find((s) => s.key === key);
    if (!session) return;
    const transfer = serializeSession(session);
    const label = windowLabelFor(key);
    const ready = new Promise<void>((resolve) => {
      void listen(`log-window-ready:${key}`, () => resolve());
    });
    const win = new WebviewWindow(label, {
      url: `index.html?logWindow=${encodeURIComponent(key)}`,
      title: `${transfer.pod} — logs`,
      width: 900,
      height: 500,
    });
    // Registry hygiene: drop the entry when the OS window goes away by any
    // path (re-attach destroy, close-all destroy).
    void win.once("tauri://destroyed", () => {
      if (this.#open.get(key) === label) this.#open.delete(key);
    });
    this.#open.set(key, label);
    await ready;
    await emitTo(label, `log-window-seed:${key}`, transfer);
    await logPanel.closeSession(key);
  }

  async focus(key: string): Promise<void> {
    const win = await WebviewWindow.getByLabel(windowLabelFor(key));
    await win?.setFocus();
  }

  /** Cluster switch / app quit: windows close without re-attaching. */
  async closeAll(): Promise<void> {
    await emit("log-window-close-all");
    this.#open.clear();
  }
}

export const logWindows = new LogWindowsStore();
```

- [ ] **Step 4: Run tests, verify green**

Run: `pnpm --dir apps/desktop test -- logWindows`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/stores/logWindows.svelte.ts apps/desktop/src/lib/stores/logWindows.svelte.test.ts
git commit -m "feat(desktop): logWindows registry with detach/reattach orchestration (#298)"
```

---

### Task 4: `LogWindowShell`, page branching, toolbar `⧉`, wiring, capabilities

**Files:**
- Create: `apps/desktop/src/lib/components/logpanel/LogWindowShell.svelte`
- Modify: `apps/desktop/src/routes/+page.svelte` (branch on `logWindow` query param; main-branch wiring)
- Modify: `apps/desktop/src/lib/components/logpanel/LogToolbar.svelte` (add `⧉`, `detached` prop)
- Modify: `apps/desktop/src/lib/stores/logPanel.svelte.ts` (`openFor` focuses detached windows; `closeAll` broadcasts)
- Modify: `apps/desktop/src-tauri/capabilities/default.json`
- Test: `apps/desktop/src/lib/components/logpanel/log-toolbar.test.ts` (append), full suite as regression gate

**Interfaces:**
- Consumes: `logWindows` (Task 3), `logPanel.openSeeded` (Task 2), `SessionSeed` path via `openSeeded`, `isSessionTransfer`, existing `LogToolbar`/`LogBody`.
- Produces: user-visible feature. `LogToolbar` prop `detached?: boolean` (default `false`).

- [ ] **Step 1: Write the failing toolbar test**

Append to `apps/desktop/src/lib/components/logpanel/log-toolbar.test.ts`, following the file's existing render/mock pattern (read its setup first and reuse it — it already renders `LogToolbar` with a session):

```ts
describe("detach button (#298)", () => {
  it("renders ⧉ in panel context and calls logWindows.detach", async () => {
    // render LogToolbar with a session, default props (detached omitted)
    // assert a button with aria-label "Pop out log session" exists
    // click it; assert vi.mocked(logWindows.detach) called with session.key
  });

  it("is hidden when detached=true", () => {
    // render with detached: true; assert the button is absent
  });
});
```

Write these as REAL tests using the file's established helpers (the pseudo-comments above name the assertions; the mechanics — `render`, `screen`, fire events — must match how the file already tests the overflow/tail buttons; mock `./../../stores/logWindows.svelte` with `{ logWindows: { detach: vi.fn(async () => {}) } }` in the file's mock preamble). If the file has no click-interaction precedent, assert presence/absence of the `aria-label` only and cover the click handler by direct inspection — but prefer the click test.

- [ ] **Step 2: Run, verify failure**

Run: `pnpm --dir apps/desktop test -- log-toolbar`
Expected: FAIL — no such button / unknown prop.

- [ ] **Step 3: Implement the UI pieces**

**`LogToolbar.svelte`** — add prop and button:

Props line becomes:

```ts
	let { session, detached = false }: { session: LogSession; detached?: boolean } = $props();
```

Imports add:

```ts
	import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
	import { logWindows } from '$lib/stores/logWindows.svelte';
```

Button, placed between the follow button and the overflow menu (match the markup idiom of the neighbouring buttons — same classes/sizing as the overflow trigger):

```svelte
	{#if !detached}
		<button
			type="button"
			class="flex h-7 w-7 items-center justify-center rounded text-text-secondary hover:bg-surface-raised"
			title="Open this session in a separate window"
			aria-label="Pop out log session"
			data-testid="logpanel-detach"
			onclick={() => void logWindows.detach(session.key)}
		>
			<SquareArrowOutUpRight size={14} strokeWidth={1.5} />
		</button>
	{/if}
```

(Adapt the classes to the exact ones the sibling buttons use — read them; the Lucide 1.5px stroke rule comes from the parent spec's design system.)

**`LogWindowShell.svelte`** (new):

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { setMode } from 'mode-watcher';
	import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import SquareArrowOutDownLeft from '@lucide/svelte/icons/square-arrow-out-down-left';
	import LogBody from '$lib/components/logpanel/LogBody.svelte';
	import LogToolbar from '$lib/components/logpanel/LogToolbar.svelte';
	import Toaster from '$lib/components/ui/Toaster.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { logPanel } from '$lib/stores/logPanel.svelte';
	import { isSessionTransfer, serializeSession } from '$lib/stores/sessionTransfer';
	import { settings } from '$lib/stores/settings.svelte';

	let { windowKey }: { windowKey: string } = $props();

	const session = $derived(logPanel.active);
	/** Set when close-all arrived or a re-attach is in flight: the
	 * close-requested handler must destroy without re-attaching (again). */
	let leaving = false;

	async function reattach(): Promise<void> {
		if (leaving || !session) return;
		leaving = true;
		const transfer = serializeSession(session); // serialize BEFORE closing streams
		await session.close();
		await emit('log-window-reattach', transfer);
		await getCurrentWindow().destroy();
	}

	onMount(() => {
		setMode(settings.theme.value);
		const unlisteners: UnlistenFn[] = [];
		void (async () => {
			unlisteners.push(
				await listen<unknown>(`log-window-seed:${windowKey}`, (event) => {
					if (!isSessionTransfer(event.payload)) return;
					const transfer = event.payload;
					app.kubeconfigPath = transfer.kubeconfigPath;
					app.activeCluster = transfer.activeCluster;
					void logPanel.openSeeded(transfer);
				}),
				await listen('log-window-close-all', async () => {
					leaving = true;
					await getCurrentWindow().destroy();
				}),
				await getCurrentWindow().onCloseRequested(async (event) => {
					if (leaving) return; // let the close proceed
					event.preventDefault();
					await reattach();
				}),
			);
			await emit(`log-window-ready:${windowKey}`);
		})();
		return () => {
			for (const un of unlisteners) un();
		};
	});
</script>

<div class="flex h-screen flex-col overflow-hidden bg-surface-window">
	{#if session}
		<header class="flex min-h-[34px] items-center gap-2 border-b border-border-default bg-surface-raised px-3">
			<span
				class="h-1.5 w-1.5 rounded-full"
				class:bg-status-ok={session.status === 'streaming'}
				class:bg-status-warn={session.status !== 'streaming'}
				aria-hidden="true"
			></span>
			<span class="type-caption font-medium">{session.pod}</span>
			{#if session.container}
				<span class="type-caption text-text-tertiary">{session.container}</span>
			{/if}
			<div class="flex-1"></div>
			<button
				type="button"
				class="flex h-7 w-7 items-center justify-center rounded text-text-secondary hover:bg-surface-window"
				title="Return this session to the log panel"
				aria-label="Return to log panel"
				data-testid="logwindow-reattach"
				onclick={() => void reattach()}
			>
				<SquareArrowOutDownLeft size={14} strokeWidth={1.5} />
			</button>
		</header>
		<LogToolbar {session} detached />
		<LogBody {session} />
	{:else}
		<div class="flex flex-1 items-center justify-center">
			<span class="type-caption text-text-tertiary">Connecting…</span>
		</div>
	{/if}
</div>
<Toaster />
```

(Adapt Tailwind classes/typography utility names to what the sibling shell components actually use — read `LogPanel.svelte`/`Titlebar.svelte` for the exact tokens; the structure above is the contract. Re-attach order is serialize → close → emit → destroy, as the code shows.)

**`+page.svelte`** — branch at the top:

```ts
	import LogWindowShell from '$lib/components/logpanel/LogWindowShell.svelte';
	import { logWindows } from '$lib/stores/logWindows.svelte';

	const logWindowKey =
		typeof window !== 'undefined'
			? new URLSearchParams(window.location.search).get('logWindow')
			: null;
```

Template becomes:

```svelte
{#if logWindowKey}
	<LogWindowShell windowKey={logWindowKey} />
{:else}
	<!-- entire existing page markup, unchanged -->
{/if}
```

The existing `onMount` boot must NOT run in log-window mode: guard its body with `if (logWindowKey) return;` at the top (keyboard handler too: early-return in `onKeydown` except log-search/log-panel actions, which are harmless — simplest correct move: at the top of `onKeydown`, `if (logWindowKey) return;`).

Main-branch wiring, inside the existing `onMount` boot (after `health.start()`):

```ts
			void logWindows.init();
			const un = await getCurrentWindow().onCloseRequested(async () => {
				await logWindows.closeAll();
			});
```

(add `import { getCurrentWindow } from '@tauri-apps/api/window';`; store `un` with the other teardown callbacks). Do not preventDefault: the main window closes normally; the pop-outs destroy themselves on close-all, so the app exits with it.

**`logPanel.svelte.ts`** — two integrations:

In `openFor`, before the existing-session check, route detached pods to their window (lazy import to keep pop-out contexts from touching `logWindows` at module level — top-level static import is fine ONLY because `logWindows` import is side-effect-free per Task 3; use the static import):

```ts
  async openFor(pod: { namespace: string; name: string }): Promise<void> {
    const key = `${pod.namespace}/${pod.name}`;
    if (logWindows.has(key)) {
      await logWindows.focus(key);
      return;
    }
    // ... existing body unchanged
```

In `closeAll`, first line: `await logWindows.closeAll();` — wait: `closeAll` is also called by pop-out contexts? No — pop-out never calls `logPanel.closeAll`. Keep it: cluster switch in main must close pop-outs (spec). Add as first statement.

Import cycle warning: `logWindows.svelte.ts` imports `logPanel.svelte.ts` and vice versa — a real cycle. Break it: `logPanel` must NOT import `logWindows`. Instead, `logWindows.init()` (Task 3) wires the two integrations from its side by monkey-patching nothing — cleaner: move the `openFor` guard OUT of `logPanel` and into the call sites? There are many call sites. Cleanest cycle-break: `logPanel` gains two injectable hooks, set by `logWindows.init()`:

```ts
  /** Set by logWindows.init() (main window only): route open-logs for a
   * detached pod to its OS window instead of a panel tab. (#298) */
  detachedRouter: { has(key: string): boolean; focus(key: string): Promise<void> } | null = null;
  /** Set by logWindows.init(): broadcast close-all to pop-out windows. */
  onCloseAll: (() => Promise<void>) | null = null;
```

`openFor` guard becomes:

```ts
    if (this.detachedRouter?.has(key)) {
      await this.detachedRouter.focus(key);
      return;
    }
```

`closeAll` first line: `await this.onCloseAll?.();`

And in `logWindows.init()` (Task 3 file — this task adds these two lines there):

```ts
    logPanel.detachedRouter = { has: (k) => this.has(k), focus: (k) => this.focus(k) };
    logPanel.onCloseAll = () => this.closeAll();
```

(Add a unit test for the `openFor` routing in `logPanel.svelte.test.ts`: set `logPanel.detachedRouter` to a stub, call `openFor` for that key, assert `focus` called and no session created; reset the router in the test's cleanup.)

```ts
  it("openFor routes detached pods to their window (#298)", async () => {
    const focus = vi.fn(async () => {});
    logPanel.detachedRouter = { has: (k) => k === "default/det-1", focus };
    const count = logPanel.sessions.length;
    await logPanel.openFor({ namespace: "default", name: "det-1" });
    expect(focus).toHaveBeenCalledWith("default/det-1");
    expect(logPanel.sessions.length).toBe(count);
    logPanel.detachedRouter = null;
  });
```

**`src-tauri/capabilities/default.json`** — extend windows and permissions:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability for the CubeLite desktop app",
  "windows": ["main", "logs-*"],
  "permissions": [
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-toggle-maximize",
    "core:window:allow-destroy",
    "core:window:allow-set-focus",
    "core:webview:allow-create-webview-window",
    "updater:default",
    "process:allow-restart"
  ]
}
```

If a runtime permission error names a different missing permission (the console error states the exact identifier), add that identifier — the list above is the expected set for `WebviewWindow` creation, `destroy`, and `setFocus`; `emit`/`emitTo`/`listen` are covered by `core:default`.

- [ ] **Step 4: Run the full unit suite + typecheck**

Run: `pnpm --dir apps/desktop test && pnpm --dir apps/desktop typecheck`
Expected: PASS — new toolbar tests, logPanel routing test, and zero regressions across the suite.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/components/logpanel/LogWindowShell.svelte apps/desktop/src/lib/components/logpanel/LogToolbar.svelte apps/desktop/src/lib/components/logpanel/log-toolbar.test.ts apps/desktop/src/routes/+page.svelte apps/desktop/src/lib/stores/logPanel.svelte.ts apps/desktop/src/lib/stores/logPanel.svelte.test.ts apps/desktop/src/lib/stores/logWindows.svelte.ts apps/desktop/src-tauri/capabilities/default.json
git commit -m "feat(desktop): pop out log session to separate OS window (#298)"
```

---

### Task 5: Verification pass + PR

**Files:** none new.

**Interfaces:**
- Consumes: everything above.
- Produces: PR from `feat/desktop-log-popout` to `main`, closing #298.

- [ ] **Step 1: Full gates**

```bash
pnpm --dir apps/desktop test
pnpm --dir apps/desktop lint
pnpm --dir apps/desktop typecheck
```

Expected: all green, zero warnings.

- [ ] **Step 2: Dev-run smoke (needs a reachable cluster; ask the user to drive if unavailable)**

`pnpm --dir apps/desktop tauri:dev`, then:
1. Open logs for a pod → `⧉` → tab leaves the panel; window shows the seeded history AND live continuation (no gap, no duplicates around the handoff point).
2. Search, container switch, tail change, previous, export all work in the window (each against the window's own session).
3. Close window (X) → tab returns to the panel with history intact.
4. `⏷` → same.
5. Two pods detached → two windows; opening logs for a detached pod focuses its window.
6. Cluster switch in main → pop-outs close, no re-attach ghosts.
7. Close main window → pop-outs close, app exits.
8. Relaunch → no log windows restored.

- [ ] **Step 3: Push and open PR (user gate first)**

Pushes require the `massilp` account helper (see repo memory). **Stop and confirm with the user before pushing.**

```bash
git -c credential.helper= -c credential.helper='!f() { echo username=massilp; echo "password=$(gh auth token --user massilp)"; }; f' push -u origin feat/desktop-log-popout
GH_TOKEN=$(gh auth token --user massilp) gh pr create --base main --title "feat(desktop): pop out log session to separate OS window (#298)" --body "Implements the desktop (Tauri) half of #298 — completes the issue (macOS half shipped in #348).

- Autonomous pop-out WebviewWindow: own LogSession/streams, seeded by a one-shot SessionTransfer handoff; sinceTime reuse gives gapless, duplicate-free continuity
- Events: log-window-ready/seed (per-key), log-window-reattach, log-window-close-all
- logWindows registry (main only): detach orchestration, focus-instead-of-open for detached pods, close-all on cluster switch and main-window close
- LogWindowShell reuses LogToolbar/LogBody unchanged against the window-local logPanel singleton; ⧉ in the toolbar, ⏷ in the window header
- Detached sessions live outside the panel's SESSION_CAP; re-attach LRU-evicts like openFor
- Capabilities: windows [main, logs-*], window create/destroy/set-focus permissions

Spec: docs/superpowers/specs/2026-08-19-desktop-log-popout-design.md

Closes #298

Testing: vitest — LogSession seeding, SessionTransfer round-trip, logPanel.openSeeded (create/focus/LRU), logWindows orchestration, toolbar detach button, openFor routing; full suite + lint + typecheck green; manual multi-window smoke."
```

No Claude attribution in the PR body or commits.
