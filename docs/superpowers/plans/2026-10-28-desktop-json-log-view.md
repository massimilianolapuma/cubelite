# Desktop JSON Log View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A persisted, default-off "JSON view" toggle in the desktop log panel that renders JSON object log lines humanised on one row and expands a clicked line into a formatted JSON tree with Copy JSON / Copy raw.

**Architecture:** Frontend only. A pure TS module (`log-json.ts`) turns a line's `message` into a `JsonLogView` (time/level/message/tail) or `null`; `LogLineRow.svelte` branches on it; a recursive `JsonTree.svelte` renders the expanded object; the toggle lives on the `logPanel` store (persisted) and the per-line expansion set on `LogSession`. The virtualiser already measures variable row heights, so expansion needs no scroller changes.

**Tech Stack:** Svelte 5 runes, TypeScript 6, Vitest + @testing-library/svelte, Playwright with the Tauri IPC mock, Tailwind v4 design tokens, lucide icons (`@lucide/svelte`).

**Spec:** `docs/superpowers/specs/2026-10-28-desktop-json-log-view-design.md`

## Global Constraints

- Desktop imports use `#lib/...` with explicit file extensions (`#lib/log-json.ts`, `#lib/stores/logPanel.svelte.ts`).
- No `text-[Npx]` classes and no raw hex colours in `apps/desktop/src/**/*.svelte`; use `type-*` utilities and `var(--color-*)` / `var(--alpha-*)` tokens. `scripts/design-lint.sh` (run with `/opt/homebrew/bin/bash`) must report zero desktop findings.
- Persisted key name: `logPanel.jsonView`, default `false`.
- Field recognition (first match wins, case-insensitive key): time `@timestamp`, `timestamp`, `time`, `ts`, `t`; level `level`, `severity`, `lvl`, then nested `log.level`, then literal key `log.level`; message `message`, `msg`, `event`.
- Level mapping: `trace|debug|verbose`→`debug`; `info|notice`→`info`; `warn|warning`→`warn`; `error|err|fatal|panic|critical|crit|alert|emerg`→`error`; numbers `<30`→`debug`, `30–39`→`info`, `40–49`→`warn`, `≥50`→`error`; otherwise `null` (caller keeps the core level).
- Tail values: strings as-is, numbers/booleans/null as literals, objects/arrays `JSON.stringify` cut at 60 characters plus `…`.
- Tree: 12px indent per level, open by default to depth 2, collapsed beyond showing `{N keys}` / `[N items]`; tokens: keys `text-text-secondary`, strings `var(--color-cluster-teal)`, numbers `var(--color-cluster-amber)`, booleans and null `var(--color-cluster-violet)`, punctuation `text-text-tertiary`; `type-micro` monospace.
- Copy buttons copy via `navigator.clipboard.writeText`; failures are swallowed (same as `YamlModal.svelte`).
- Core (`crates/`), Tauri backend, `LogSearch`, `logPanel.serialize`, `views/LogsView.svelte`, `stores/logs.svelte.ts` are not modified.
- Commits: Conventional Commits, no Claude attribution, reference `#454`.
- Run unit tests with `pnpm --filter desktop exec vitest run <file>`; lint `pnpm --filter desktop lint`; typecheck `pnpm --filter desktop typecheck`; e2e `pnpm --filter desktop test:e2e`.

## Review Focus

1. A line with a leading BOM/whitespace or trailing `\r` is still JSON (kubelet output often has CRLF) — Task 1 tests `parses with surrounding whitespace and CRLF`.
2. A JSON `message` field that is not a string (object/number) must not crash the row — Task 1 test `falls back when the message field is not a string`.
3. A pino-style level given as the string `"30"` maps like the number — Task 1 test `maps numeric level strings`.
4. A deeply nested object (depth 20) renders without blowing the stack and stays collapsed beyond depth 2 — Task 4 test `caps default expansion at depth 2 for deep objects`.
5. `navigator.clipboard` missing (WebKit without permission) must not throw out of the click handler — Task 4 test `copy buttons swallow clipboard errors`.

---

### Task 1: JSON line parser (`log-json.ts`)

**Files:**
- Create: `apps/desktop/src/lib/log-json.ts`
- Test: `apps/desktop/src/lib/log-json.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
  export type JsonObject = { [key: string]: JsonValue };
  export type JsonLogView = {
    object: JsonObject;
    time: string | null;            // raw value of the recognised time field, String()-ed
    level: LogLevel | null;         // mapped level or null (caller keeps the core level)
    message: string;                // recognised message, else first string field, else compact JSON
    tail: { key: string; value: string }[]; // remaining top-level fields, insertion order
  };
  export function parseJsonLine(message: string): JsonLogView | null;
  export function mapLevel(raw: unknown): LogLevel | null;
  export function compactValue(value: JsonValue, max?: number): string; // max default 60
  export function prettyJson(object: JsonObject): string;             // JSON.stringify(object, null, 2)
  ```
  `LogLevel` is imported from `#lib/tauri.ts`.

- [ ] **Step 1: Write the failing tests** in `apps/desktop/src/lib/log-json.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { parseJsonLine, mapLevel, compactValue, prettyJson } from "#lib/log-json.ts";

describe("parseJsonLine detection", () => {
  it("returns a view for a JSON object line", () => {
    const v = parseJsonLine('{"level":"info","msg":"order accepted","orderId":"A-1931"}');
    expect(v).not.toBeNull();
    expect(v?.message).toBe("order accepted");
  });
  it("returns null for arrays, primitives, text prefixes, trailing text and invalid JSON", () => {
    expect(parseJsonLine('[{"a":1}]')).toBeNull();
    expect(parseJsonLine("42")).toBeNull();
    expect(parseJsonLine('app[1]: {"a":1}')).toBeNull();
    expect(parseJsonLine('{"a":1} tail')).toBeNull();
    expect(parseJsonLine('{"a":')).toBeNull();
    expect(parseJsonLine("plain text line")).toBeNull();
  });
  it("parses with surrounding whitespace and CRLF", () => {
    expect(parseJsonLine('﻿  {"msg":"x"}\r')?.message).toBe("x");
  });
});

describe("parseJsonLine fields", () => {
  it("picks time/level/message by precedence, case-insensitively, and drops them from the tail", () => {
    // candidate order decides, not key order: time beats TS, level beats Severity, message beats msg
    const v = parseJsonLine('{"TS":"1","time":"2","Severity":"warn","level":"info","msg":"m","message":"n","k":1}');
    expect(v?.time).toBe("2");
    expect(v?.level).toBe("info");
    expect(v?.message).toBe("n");
    expect(v?.tail.map((t) => t.key)).toEqual(["TS", "Severity", "msg", "k"]);
  });
  it("reads the nested ECS log.level and keeps the log object in the tail", () => {
    const v = parseJsonLine('{"log":{"level":"ERROR","logger":"x"},"message":"boom"}');
    expect(v?.level).toBe("error");
    expect(v?.tail).toEqual([{ key: "log", value: '{"level":"ERROR","logger":"x"}' }]);
  });
  it("accepts a literal log.level key", () => {
    expect(parseJsonLine('{"log.level":"warning","msg":"x"}')?.level).toBe("warn");
  });
  it("falls back to the first string field, then to the compact JSON, for the message", () => {
    expect(parseJsonLine('{"n":1,"name":"svc","b":true}')?.message).toBe("svc");
    expect(parseJsonLine('{"n":1,"b":true}')?.message).toBe('{"n":1,"b":true}');
  });
  it("falls back when the message field is not a string", () => {
    const v = parseJsonLine('{"msg":{"nested":true},"name":"svc"}');
    expect(v?.message).toBe("svc");
    expect(v?.tail.map((t) => t.key)).toEqual(["msg"]);
  });
  it("keeps level null when unrecognised so the caller keeps the core level", () => {
    expect(parseJsonLine('{"level":"loud","msg":"x"}')?.level).toBeNull();
    expect(parseJsonLine('{"msg":"x"}')?.level).toBeNull();
  });
});

describe("mapLevel", () => {
  it("maps level strings", () => {
    expect(mapLevel("TRACE")).toBe("debug");
    expect(mapLevel("notice")).toBe("info");
    expect(mapLevel("Warning")).toBe("warn");
    expect(mapLevel("fatal")).toBe("error");
    expect(mapLevel("emerg")).toBe("error");
  });
  it("maps pino numbers", () => {
    expect(mapLevel(20)).toBe("debug");
    expect(mapLevel(30)).toBe("info");
    expect(mapLevel(40)).toBe("warn");
    expect(mapLevel(60)).toBe("error");
  });
  it("maps numeric level strings", () => {
    expect(mapLevel("30")).toBe("info");
  });
  it("returns null for anything else", () => {
    expect(mapLevel(null)).toBeNull();
    expect(mapLevel({ a: 1 })).toBeNull();
    expect(mapLevel("")).toBeNull();
  });
});

describe("compactValue / prettyJson", () => {
  it("renders scalars as literals and compacts containers", () => {
    expect(compactValue("s")).toBe("s");
    expect(compactValue(1.5)).toBe("1.5");
    expect(compactValue(false)).toBe("false");
    expect(compactValue(null)).toBe("null");
    expect(compactValue({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });
  it("cuts containers at 60 characters with an ellipsis", () => {
    const long = { k: "x".repeat(100) };
    const out = compactValue(long);
    expect(out.length).toBe(61);
    expect(out.endsWith("…")).toBe(true);
  });
  it("pretty prints with two spaces", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter desktop exec vitest run src/lib/log-json.test.ts`
Expected: FAIL, module `#lib/log-json.ts` not found.

- [ ] **Step 3: Implement `apps/desktop/src/lib/log-json.ts`**

Signatures from the Interfaces block. Detection: `const s = message.replace(/^﻿/, "").trim()`; require `s.startsWith("{") && s.endsWith("}")`; `JSON.parse` in try/catch; require a non-null, non-array object. Field pick: iterate the object's own keys once, matching `key.toLowerCase()` against each candidate list in order (first candidate that has a match wins, not first key); for level, after the flat candidates fail, check `object.log` is an object with a `level` key, then the literal `"log.level"` key. Message: recognised field only if `typeof === "string"`; else first own string value; else `JSON.stringify(object)`. Tail: every own key except the ones consumed (time key, flat level key or literal `log.level`, message key); the nested-ECS case consumes nothing from the tail. `mapLevel`: lower-case strings through the table; `Number(raw)` for numbers and numeric strings (`/^\d+$/`). `compactValue`: `String(value)` for scalars, `JSON.stringify` for containers cut to `max` characters plus `…` when longer.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter desktop exec vitest run src/lib/log-json.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `pnpm --filter desktop lint && pnpm --filter desktop typecheck`
Expected: exit 0.

```bash
git add apps/desktop/src/lib/log-json.ts apps/desktop/src/lib/log-json.test.ts
git commit -m "feat(desktop): parse JSON log lines into a humanised view (#454)"
```

---

### Task 2: `jsonView` toggle (store + toolbar button)

**Files:**
- Modify: `apps/desktop/src/lib/stores/logPanel.svelte.ts` (next to `#wrap` / `get wrap`)
- Modify: `apps/desktop/src/lib/components/logpanel/LogToolbar.svelte` (imports; between the follow/pause button and the pop-out button)
- Test: `apps/desktop/src/lib/components/logpanel/log-toolbar.test.ts`

**Interfaces:**
- Produces: `logPanel.jsonView: boolean` getter/setter, persisted under `"logPanel.jsonView"`, default `false`.
- Toolbar button: `aria-label="JSON view"`, `title="JSON view"`, `aria-pressed={logPanel.jsonView}`, `data-testid="logpanel-json-view"`, icon `Braces` from `@lucide/svelte/icons/braces` at `size={14} strokeWidth={1.5}`.

- [ ] **Step 1: Write the failing tests** (append a `describe("JSON view toggle (#454)")` block to `log-toolbar.test.ts`, reusing its `sessionWith`)

```ts
describe("JSON view toggle (#454)", () => {
  afterEach(() => {
    logPanel.jsonView = false;
  });
  it("is off by default and flips logPanel.jsonView with aria-pressed", async () => {
    render(LogToolbar, { props: { session: sessionWith(["x"]) } });
    const btn = screen.getByRole("button", { name: "JSON view" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    await fireEvent.click(btn);
    expect(logPanel.jsonView).toBe(true);
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });
  it("persists under logPanel.jsonView", async () => {
    render(LogToolbar, { props: { session: sessionWith(["x"]) } });
    await fireEvent.click(screen.getByRole("button", { name: "JSON view" }));
    expect(window.localStorage.getItem("cubelite.logPanel.jsonView")).toBe("true");
  });
});
```

Check the storage prefix in `settings.svelte.ts` `persisted()` before relying on `cubelite.` (the e2e boot script writes `cubelite.onboardingSeen`, so that is the expected prefix); adjust the key string if `persisted()` uses another one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter desktop exec vitest run src/lib/components/logpanel/log-toolbar.test.ts -t "JSON view"`
Expected: FAIL, no button named "JSON view".

- [ ] **Step 3: Add `jsonView` to `LogPanelStore`**

`#jsonView = persisted<boolean>("logPanel.jsonView", false, isBoolean);` plus `get jsonView(): boolean` / `set jsonView(v: boolean)` mirroring `wrap`.

- [ ] **Step 4: Add the toolbar button**

In `LogToolbar.svelte`, import `Braces`, and insert after the follow/pause button a `<button type="button">` with the attributes from Interfaces, class `focus-ring flex h-7 w-7 items-center justify-center rounded-md` and inline style `color: var(--color-accent)` when on, `color: var(--color-text-tertiary)` when off (hover `text-text-secondary` via class as the pop-out button does), `onclick={() => (logPanel.jsonView = !logPanel.jsonView)}`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter desktop exec vitest run src/lib/components/logpanel/log-toolbar.test.ts`
Expected: PASS (whole file, existing cases untouched).

- [ ] **Step 6: Lint, typecheck, design-lint, commit**

Run: `pnpm --filter desktop lint && pnpm --filter desktop typecheck && /opt/homebrew/bin/bash scripts/design-lint.sh`
Expected: exit 0, desktop findings 0.

```bash
git add apps/desktop/src/lib/stores/logPanel.svelte.ts apps/desktop/src/lib/components/logpanel/LogToolbar.svelte apps/desktop/src/lib/components/logpanel/log-toolbar.test.ts
git commit -m "feat(desktop): JSON view toggle in the log toolbar (#454)"
```

---

### Task 3: Per-session expansion set

**Files:**
- Modify: `apps/desktop/src/lib/stores/logSession.svelte.ts` (fields near `ring`; `clear()` and `#resetBuffer()`)
- Test: `apps/desktop/src/lib/stores/logSession.svelte.test.ts`

**Interfaces:**
- Produces: `session.expanded: SvelteSet<number>` (line ids), `session.toggleExpanded(id: number): void`. Cleared in `clear()` and `#resetBuffer()`.

- [ ] **Step 1: Write the failing tests** (append to `logSession.svelte.test.ts`, following its existing construction of a `LogSession`)

```ts
describe("expanded lines (#454)", () => {
  it("toggles ids on and off", () => {
    const s = new LogSession("default", "api-0");
    s.toggleExpanded(3);
    expect(s.expanded.has(3)).toBe(true);
    s.toggleExpanded(3);
    expect(s.expanded.has(3)).toBe(false);
  });
  it("is cleared with the buffer", () => {
    const s = new LogSession("default", "api-0");
    s.toggleExpanded(1);
    s.clear();
    expect(s.expanded.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter desktop exec vitest run src/lib/stores/logSession.svelte.test.ts -t "expanded"`
Expected: FAIL, `toggleExpanded is not a function`.

- [ ] **Step 3: Implement**

Import `SvelteSet` from `svelte/reactivity` (as `logSearch.svelte.ts` does). `expanded = new SvelteSet<number>();` `toggleExpanded(id)` adds or deletes. Add `this.expanded.clear();` to both `clear()` and `#resetBuffer()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter desktop exec vitest run src/lib/stores/logSession.svelte.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/stores/logSession.svelte.ts apps/desktop/src/lib/stores/logSession.svelte.test.ts
git commit -m "feat(desktop): remember expanded JSON log lines per session (#454)"
```

---

### Task 4: `JsonTree.svelte`

**Files:**
- Create: `apps/desktop/src/lib/components/logpanel/JsonTree.svelte`
- Test: `apps/desktop/src/lib/components/logpanel/json-tree.test.ts`

**Interfaces:**
- Consumes: `JsonValue`, `JsonObject`, `prettyJson` from `#lib/log-json.ts`.
- Produces: component props `{ value: JsonValue; raw: string; depth?: number }`. At `depth === 0` it renders the header row with two buttons `Copy JSON` and `Copy raw` (`type-caption`, `aria-label` equal to their text), then the tree. Each object/array node at depth `d` renders a `<button aria-expanded>` chevron (`ChevronRight` from `@lucide/svelte/icons/chevron-right`, `size={10}`, rotated 90° when open via a `rotate-90` class) followed by the key and either its children (open) or the placeholder `{N keys}` / `[N items]` (closed). Open by default when `d < 2`. Scalars: `<span data-json="string|number|boolean|null">` with the token colours from Global Constraints; keys in a `<span class="text-text-secondary">`; punctuation (`:`) in `text-text-tertiary`. Root container has `data-testid="json-tree"`, `type-micro font-mono`, `style="padding-left: {depth * 12}px"` on each nested row.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import JsonTree from "./JsonTree.svelte";

const obj = { a: "str", n: 2, ok: true, z: null, nest: { deep: { deeper: { deepest: 1 } } }, list: [1, 2, 3] };
const raw = JSON.stringify(obj);

afterEach(() => vi.restoreAllMocks());

describe("JsonTree", () => {
  it("renders scalars with their type token", () => {
    render(JsonTree, { props: { value: obj, raw } });
    expect(screen.getByText('"str"')).toHaveAttribute("data-json", "string");
    expect(screen.getByText("2")).toHaveAttribute("data-json", "number");
    expect(screen.getByText("true")).toHaveAttribute("data-json", "boolean");
    expect(screen.getByText("null")).toHaveAttribute("data-json", "null");
  });
  it("caps default expansion at depth 2 for deep objects", () => {
    render(JsonTree, { props: { value: obj, raw } });
    expect(screen.getByText("deep")).toBeInTheDocument();      // depth 1 key, open
    expect(screen.getByText("{1 keys}")).toBeInTheDocument();  // `deeper` collapsed at depth 2
    expect(screen.queryByText("deepest")).toBeNull();
  });
  it("expands a collapsed node on click", async () => {
    render(JsonTree, { props: { value: obj, raw } });
    const toggle = screen.getAllByRole("button", { expanded: false })[0]; // the collapsed `deep` node
    await fireEvent.click(toggle);
    expect(screen.getByText("deeper")).toBeInTheDocument();   // its direct child key appears
    expect(screen.queryByText("deepest")).toBeNull();         // `deeper` (depth 3) stays collapsed
  });
  it("shows [N items] for collapsed arrays", () => {
    render(JsonTree, { props: { value: { l: { m: [1, 2] } }, raw: "{}" } });
    expect(screen.getByText("[2 items]")).toBeInTheDocument();
  });
  it("Copy JSON writes the pretty text and Copy raw writes the raw line", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(JsonTree, { props: { value: { a: 1 }, raw: '{"a":1}' } });
    await fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    expect(writeText).toHaveBeenLastCalledWith('{\n  "a": 1\n}');
    await fireEvent.click(screen.getByRole("button", { name: "Copy raw" }));
    expect(writeText).toHaveBeenLastCalledWith('{"a":1}');
  });
  it("copy buttons swallow clipboard errors", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    render(JsonTree, { props: { value: { a: 1 }, raw: "{}" } });
    await expect(fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }))).resolves.not.toThrow();
  });
  it("does not render copy buttons on nested instances", () => {
    render(JsonTree, { props: { value: { a: 1 }, raw: "{}", depth: 1 } });
    expect(screen.queryByRole("button", { name: "Copy JSON" })).toBeNull();
  });
});
```

The `{1 keys}` placeholder text is literal (no singular form), as in the spec.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter desktop exec vitest run src/lib/components/logpanel/json-tree.test.ts`
Expected: FAIL, cannot resolve `./JsonTree.svelte`.

- [ ] **Step 3: Implement `JsonTree.svelte`**

Recursive component (`<svelte:self>` is not available in runes mode; import itself as `JsonTree from './JsonTree.svelte'`). Local `collapsed = new SvelteSet<string>()` keyed by child key, seeded closed for `depth + 1 >= 2`. `copy(text)` as in `YamlModal.svelte` (try/await/catch, no toast). Keep all colours as `style="color: var(--color-cluster-…)"` or token classes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter desktop exec vitest run src/lib/components/logpanel/json-tree.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, design-lint, commit**

Run: `pnpm --filter desktop lint && pnpm --filter desktop typecheck && /opt/homebrew/bin/bash scripts/design-lint.sh`
Expected: exit 0, desktop findings 0.

```bash
git add apps/desktop/src/lib/components/logpanel/JsonTree.svelte apps/desktop/src/lib/components/logpanel/json-tree.test.ts
git commit -m "feat(desktop): JsonTree for expanded JSON log lines (#454)"
```

---

### Task 5: Humanised row and expansion in `LogLineRow` / `LogBody`

**Files:**
- Modify: `apps/desktop/src/lib/components/logpanel/LogLineRow.svelte`
- Modify: `apps/desktop/src/lib/components/logpanel/LogBody.svelte` (the `<LogLineRow …/>` call, lines 173–182)
- Test: `apps/desktop/src/lib/components/logpanel/log-body.test.ts`

**Interfaces:**
- Consumes: `parseJsonLine`, `compactValue` (Task 1); `logPanel.jsonView` (Task 2); `session.expanded`, `session.toggleExpanded` (Task 3); `JsonTree` (Task 4).
- Produces: `LogLineRow` props `jsonView?: boolean` (default `false`), `expanded?: boolean` (default `false`), `ontoggle?: () => void`. When `jsonView` and `parseJsonLine(line.message)` is non-null:
  - level badge text and `rowStyle` use `view.level ?? line.level`;
  - the message cell is a `<button type="button" aria-expanded={expanded} data-testid="json-row">` containing a `ChevronRight` (size 10, `rotate-90` when expanded), the message segments (same highlight logic, applied to `view.message`), then the tail as `<span class="type-micro font-mono">` items `key` (`text-text-tertiary`) `=` `value` (`text-text-secondary`), separated by two spaces; values go through the segment highlighter too;
  - when `expanded`, a second row below with `JsonTree value={view.object} raw={line.message}` inside a `bg-surface-raised` block that keeps the same left border/tint style;
  - `wrap` controls `whitespace-pre` vs `break-all whitespace-pre-wrap` on the message cell as today.
  Otherwise the raw row renders unchanged.

- [ ] **Step 1: Write the failing tests** (append a `describe("JSON view (#454)")` to `log-body.test.ts`; `sessionWith` is already there)

```ts
describe("JSON view (#454)", () => {
  const json = '{"level":"warn","msg":"order accepted","orderId":"A-1931","meta":{"a":1}}';
  afterEach(() => {
    logPanel.jsonView = false;
  });
  it("renders raw lines unchanged with the toggle on", async () => {
    logPanel.jsonView = true;
    render(LogBody, { props: { session: sessionWith(["plain text"]) } });
    expect(await screen.findByText("plain text")).toBeInTheDocument();
    expect(screen.queryByTestId("json-row")).toBeNull();
  });
  it("humanises a JSON line: message, tail and JSON level", async () => {
    logPanel.jsonView = true;
    render(LogBody, { props: { session: sessionWith([json]) } });
    const row = await screen.findByTestId("json-row");
    expect(row).toHaveTextContent("order accepted");
    expect(row).toHaveTextContent("orderId=A-1931");
    expect(row).toHaveTextContent('meta={"a":1}');
    expect(screen.getByText("warn")).toBeInTheDocument();   // badge from the JSON level, core level is info
    expect(row).toHaveAttribute("aria-expanded", "false");
  });
  it("leaves the JSON line raw with the toggle off", async () => {
    render(LogBody, { props: { session: sessionWith([json]) } });
    expect(await screen.findByText(json)).toBeInTheDocument();
  });
  it("click expands the tree and toggles session.expanded", async () => {
    logPanel.jsonView = true;
    const s = sessionWith([json]);
    render(LogBody, { props: { session: s } });
    const row = await screen.findByTestId("json-row");
    await fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("json-tree")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy raw" })).toBeInTheDocument();
    expect(s.expanded.size).toBe(1);
    await fireEvent.click(row);
    expect(screen.queryByTestId("json-tree")).toBeNull();
  });
  it("highlights the search query inside the humanised message", async () => {
    logPanel.jsonView = true;
    const s = sessionWith([json]);
    logPanel.search.attach(() => s.ring.lines);
    vi.useFakeTimers();
    logPanel.search.setQuery("accepted");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    render(LogBody, { props: { session: s } });
    const mark = await screen.findByText("accepted");
    expect(mark.tagName).toBe("MARK");
  });
});
```

Import `fireEvent` from `@testing-library/svelte` at the top of the file if missing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter desktop exec vitest run src/lib/components/logpanel/log-body.test.ts -t "JSON view"`
Expected: FAIL, no element with test id `json-row`.

- [ ] **Step 3: Implement the row**

In `LogLineRow.svelte`: add the three props; `const view = $derived(jsonView ? parseJsonLine(line.message) : null);` `const shownLevel = $derived(view?.level ?? line.level);` extract the existing segment splitter into `function segmentsOf(text: string)` and reuse it for `view.message` and each tail value. Keep the raw branch byte-for-byte as today.

- [ ] **Step 4: Wire `LogBody`**

Pass `jsonView={logPanel.jsonView}`, `expanded={session.expanded.has(line.id)}`, `ontoggle={() => session.toggleExpanded(line.id)}`. No virtualiser change (the `measure` action already handles the taller row).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter desktop exec vitest run src/lib/components/logpanel/log-body.test.ts`
Expected: PASS (whole file, existing cases still green).

- [ ] **Step 6: Lint, typecheck, design-lint, full unit suite, commit**

Run: `pnpm --filter desktop lint && pnpm --filter desktop typecheck && /opt/homebrew/bin/bash scripts/design-lint.sh && pnpm --filter desktop test`
Expected: exit 0; all unit tests pass.

```bash
git add apps/desktop/src/lib/components/logpanel/LogLineRow.svelte apps/desktop/src/lib/components/logpanel/LogBody.svelte apps/desktop/src/lib/components/logpanel/log-body.test.ts
git commit -m "feat(desktop): humanised JSON rows with in-place tree expansion (#454)"
```

---

### Task 6: End-to-end case, changelog, final gates

**Files:**
- Modify: `apps/desktop/tests/e2e/logpanel.spec.ts` (new test at the end; reuse `boot`, `openLogPanel`)
- Modify: `CHANGELOG.md` (Unreleased → Added)

- [ ] **Step 1: Write the failing e2e test**

```ts
test("JSON view humanises structured lines and expands them on click (#454)", async ({ page }) => {
  await boot(page);
  await openLogPanel(page, "api-0");
  const json = '{"level":"error","msg":"e2e-json-boom","orderId":"A-1931"}';
  await page.evaluate((message) =>
    window.__emitTauriEvent?.("pod-log-line:1", {
      pod: "api-0", namespace: "default", time: "2026-08-04T10:00:00Z", level: "info", message,
    }), json);
  await expect(page.getByText(json)).toBeVisible();

  await page.getByRole("button", { name: "JSON view" }).click();
  const row = page.getByTestId("json-row");
  await expect(row).toContainText("e2e-json-boom");
  await expect(row).toContainText("orderId=A-1931");
  await expect(page.getByText(json, { exact: true })).toHaveCount(0);

  await row.click();
  await expect(page.getByTestId("json-tree")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy raw" })).toBeVisible();

  await page.getByRole("button", { name: "JSON view" }).click();
  await expect(page.getByText(json)).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails on `main` behaviour**

Run: `pnpm --filter desktop test:e2e -- -g "JSON view"` (first `pnpm --filter desktop test:e2e:setup` if Chromium is missing)
Expected: with Tasks 1–5 in place this passes; if run before them it fails on the "JSON view" button. Record the result either way.

- [ ] **Step 3: CHANGELOG entry** under `## [Unreleased]` → `### Added`

```markdown
- **JSON view for structured logs** (desktop, #454): a `{}` toggle in the log
  toolbar (off by default, remembered) renders JSON log lines as
  `LEVEL  message  key=value …`, taking the level from the line itself, and a
  click expands the line into a formatted tree with Copy JSON / Copy raw.
  Plain-text lines, search, export and the pop-out window are unchanged.
```

- [ ] **Step 4: Full gates**

Run: `pnpm --filter desktop lint && pnpm --filter desktop typecheck && pnpm --filter desktop test && pnpm --filter desktop test:e2e && /opt/homebrew/bin/bash scripts/design-lint.sh`
Expected: all exit 0.

- [ ] **Step 5: Commit and push**

```bash
git add apps/desktop/tests/e2e/logpanel.spec.ts CHANGELOG.md
git commit -m "test(desktop): e2e for the JSON log view and changelog entry (#454)"
```

Open the PR to `main` with `Closes #454`, the spec and plan paths, and a manual checklist: toggle off → unchanged; toggle on with a pino/zap/ECS line; expand/collapse; wrap on/off; search highlight; pop-out window; export still raw.
