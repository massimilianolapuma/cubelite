# Desktop: JSON log view — design

Date: 2026-10-28 · Owner: desktop-agent · Status: approved in chat, awaiting plan

## 1. Intent

Structured (JSON) logs are becoming the norm in the clusters CubeLite is used
on: the same services ship their logs to Kibana, where each line is a document
with `@timestamp`, `level`, `message` and extra fields. In CubeLite's log
panel such a line is a single wall of text:

```
{"level":"info","ts":"2026-10-28T09:41:02.113Z","msg":"order accepted","orderId":"A-1931","tenant":"acme","latencyMs":41}
```

Goal: with one toggle, the log panel renders JSON lines the way a person
reads them (time, level, message, then the remaining fields) and lets the
user open any line as a formatted, navigable JSON tree. Off by default, so
plain-text logs and the current look are untouched unless asked for.

## 2. Goals, non-goals, anti-goals

Goals
- A per-user **JSON view** toggle in the log toolbar, remembered across
  sessions, default off.
- When on, every line that is a JSON object is shown humanised on one row;
  non-JSON lines render exactly as today.
- Clicking a JSON row expands it in place into a formatted tree; clicking
  again collapses it.
- Search, filter mode, follow/autoscroll, export and the pop-out log
  window keep working unchanged.

Non-goals (this feature)
- No change to the Rust core or the Tauri backend: parsing happens in the
  frontend on the lines already in the ring buffer.
- No column/field picker, no per-field filtering, no field-based search
  syntax. Search stays full-text on the raw line.
- No change to the macOS app. Parity is a follow-up issue once the desktop
  behaviour has been used for a while (the user's reference app is desktop).
- The aggregated **Logs** view (`views/LogsView.svelte`, multi-pod stream with
  level chips) is out of scope: see §7, open question.
- Logfmt (`key=value key2=value2`) is out of scope; only JSON objects.

Anti-goals
- JSON view must never alter, hide or reorder lines: same count, same
  order, same raw text available (copy/export).
- No measurable slowdown of the live stream: parsing is done only for
  rendered (virtualised) rows and only while the toggle is on.
- No new colours or font sizes outside the design tokens (`scripts/design-lint.sh`
  is held at zero findings on desktop).

## 3. Behaviour

### 3.1 Toggle

- Toolbar button with the lucide `Braces` icon (`{}`), `aria-pressed`,
  title `JSON view`, placed with the other view controls of
  `LogToolbar.svelte`; the overflow menu (Timestamps / Wrap lines) is left
  as is.
- State: `logPanel.jsonView`, `persisted("logPanel.jsonView", false)` in
  `logPanel.svelte.ts`, same mechanism as `timestamps` / `wrap`. The pop-out
  window reads the same key at start-up (no live sync between windows, like
  the other toggles).

### 3.2 Detection

A line is "JSON" when its `message` (the kubelet timestamp is already
stripped by the core) trimmed starts with `{`, ends with `}`, `JSON.parse`
succeeds and the result is a plain object. Arrays, primitives and lines
with a text prefix before the `{` (e.g. `app[1]: {...}`) are not JSON for
this feature and render raw.

Field recognition, first match wins, case-insensitive on the key:
- time: `@timestamp`, `timestamp`, `time`, `ts`, `t`
- level: `level`, `severity`, `lvl`, then the ECS nested path `log.level`
  (`{"log":{"level":"INFO"}}`); a literal top-level `"log.level"` key is
  also accepted
- message: `message`, `msg`, `event`

Level mapping to the existing `LogLevel` union (`debug | info | warn | error`):
- `trace`, `debug`, `verbose` → `debug`
- `info`, `notice` → `info`
- `warn`, `warning` → `warn`
- `error`, `err`, `fatal`, `panic`, `critical`, `crit`, `alert`, `emerg` → `error`
- numeric (pino/bunyan): `< 30` → `debug`, `30–39` → `info`, `40–49` → `warn`,
  `≥ 50` → `error`
- anything else or missing → keep the core-detected `line.level`

The recognised `time` field is only used to keep it out of the tail: the row
keeps the kubelet clock column (always present, already normalised), and the
raw value stays visible in the expanded tree. No epoch/ISO normalisation.

### 3.3 Humanised row (collapsed)

Same row chrome as today (left border and tint by level, optional kubelet
timestamp column, optional container badge in merged mode), then:

```
[94px time] [52px source] LEVEL  message text                 key=value  key2=value2  obj={…}
```

- `LEVEL` and the row tint use the JSON level when recognised, else the
  core level (display-only override; the core `line.level` is untouched, see §6).
- `message` in `type-log` / `text-text-log` like a raw line. If no message
  field exists, the first string field is used; if none, the message cell
  shows the compact JSON itself.
- The tail lists the remaining top-level fields in insertion order, `type-micro`
  monospace, key in `text-text-tertiary`, value in `text-text-secondary`,
  separated by two spaces. The recognised time/level/message fields are not
  repeated in the tail (for the nested ECS case the `log` object stays in
  the tail, compacted). Values: strings as-is, numbers/booleans/null as
  literals, objects and arrays compacted with `JSON.stringify` and cut at
  60 characters with `…`.
- With `wrap` off the row is one line and truncates like today; with `wrap`
  on the tail wraps after the message.
- Search highlighting applies inside the message text and inside tail values
  using the existing segment logic; the match set itself is still computed
  on the raw line by `LogSearch`, so a hit on a key name counts but may not
  be highlighted. Acceptable.
- A small `ChevronRight` affordance (rotates when expanded) precedes the
  message; the whole message cell is a `button` with `aria-expanded`.

### 3.4 Expanded row

- Clicking the message cell (or pressing Enter/Space on it) toggles the
  expansion of that line. Expansion state is a `SvelteSet<number>` of line
  ids kept on the `LogSession`, so switching tabs keeps it; it is cleared
  with the buffer (`session.clear()`) and ids evicted by the ring are
  dropped lazily (an id that no longer exists simply never renders).
  Expansion is **not** carried across detach/re-attach to the pop-out window
  (`SessionTransfer` is unchanged; the ring re-keys seeded lines anyway).
- Below the humanised row a `JsonTree` component renders the full object:
  one line per key, indentation 12px per level, keys in `text-text-secondary`,
  strings in `--color-cluster-teal`, numbers in `--color-cluster-amber`,
  booleans and `null` in `--color-cluster-violet`, punctuation in
  `text-text-tertiary`; `type-micro` monospace. Nested objects/arrays have
  their own chevron, open by default down to depth 2, collapsed beyond
  (showing `{3 keys}` / `[12 items]`). Long string values wrap.
- Two `type-caption` text buttons at the top right of the tree: `Copy JSON`
  (pretty-printed, 2-space indent) and `Copy raw` (the line exactly as
  received), both via `navigator.clipboard.writeText` as in `YamlModal`.
  This keeps the raw text reachable while JSON view is on.
- The expanded block keeps the row's left border/tint and sits on
  `bg-surface-raised` to read as part of the same line.
- Row heights are variable already (wrap on); the virtualiser's
  `measureElement` action in `LogBody.svelte` handles the expanded height
  with no further changes. Expanding a row while following does not pause
  follow; the view keeps autoscrolling (expanding the last line is the common
  case and must not fight the user).
- Turning JSON view off collapses everything visually (the set is kept, so
  toggling back restores it).

### 3.5 Untouched surfaces

- `logPanel.serialize` (export, copy) keeps emitting raw lines.
- `LogSearch` (`recompute`, filter mode, n/N navigation) unchanged.
- Core `LogLine` and the `detect_level` heuristic unchanged.
- `views/LogsView.svelte` and `stores/logs.svelte.ts` (aggregated view,
  `LevelFilter`) untouched.

## 4. Structure (frontend only)

- `apps/desktop/src/lib/log-json.ts` (new, pure TS, no Svelte):
  `parseJsonLine(message): JsonLogView | null` and helpers
  (`pickField`, `mapLevel`, `compactValue`). `JsonLogView = { object, time, level,
  message, tail: { key, value }[] }`.
- `apps/desktop/src/lib/components/logpanel/JsonTree.svelte` (new):
  recursive tree with its own collapsed-set, props `value`, `depth`.
- `LogLineRow.svelte`: new props `jsonView: boolean`, `expanded: boolean`,
  `ontoggle: () => void`; derives `view = jsonView ? parseJsonLine(line.message) : null`
  and branches between the raw row (today) and the humanised row + tree.
- `LogBody.svelte`: passes `jsonView={logPanel.jsonView}`, `expanded`, `ontoggle`.
- `LogSession`: `expanded = new SvelteSet<number>()`, cleared in `clear()`.
- `logPanel.svelte.ts`: `jsonView` persisted getter/setter.
- `LogToolbar.svelte`: the `Braces` toggle button, between Follow and Pop-out.

Design-first rule: this modifies an existing view (log panel) and adds no
new section, so no Penpot board is required (AGENTS.md exemption).

## 5. Tests

- vitest `log-json.test.ts`: detection (object yes; array, number, text prefix,
  trailing text, invalid JSON no), field picking incl. precedence,
  case-insensitivity and the nested ECS `log.level`, level mapping (strings, pino numbers, unknown → fallback),
  tail order and compaction/truncation, message fallback rules.
- vitest `log-line-row` cases inside `log-body.test.ts` (or a new
  `log-line-row.test.ts`): raw line unchanged with `jsonView` on; JSON line
  humanised; click toggles `aria-expanded` and renders the tree; search
  highlight inside the message; level badge from JSON overrides core level.
- vitest `log-toolbar.test.ts`: toggle button flips `logPanel.jsonView`,
  persisted key `logPanel.jsonView`.
- vitest `JsonTree`: nested collapse beyond depth 2, type colouring by token,
  Copy JSON writes the pretty-printed text, Copy raw writes `line.message`.
- Playwright `logpanel.spec.ts`: new case — emit a JSON line via
  `emitPodLogLine`, toggle JSON view, assert the humanised row text and that
  clicking shows a tree node for one of the fields; toggle off restores the
  raw text.
- `scripts/design-lint.sh` stays at zero desktop findings.

## 6. Left to the builder / follow-ups

Builder's calls
- Exact spacing/width of the chevron cell and the tail separator; whether
  the tail uses `title=` tooltips for truncated values.
- Whether `parseJsonLine` results are memoised per row instance (`$derived`)
  or in a bounded module cache; either is fine as long as parsing is lazy.

Follow-ups (separate issues, not blocking)
- Level detection in the core for JSON lines (`"level":"warn"` currently
  relies on the substring heuristic, which also fires on words inside the
  payload); would make the toolbar level filter consistent with the badge.
- macOS app parity: same toggle and tree in `LogsView` / `LogPanel`.
- Logfmt humanisation.

## 7. Scope decision

Decided 2026-10-28: the log panel only (this document). The aggregated
**Logs** view (`views/LogsView.svelte`, multi-pod stream with `LevelFilter`
chips and its own row markup) gets the same toggle in a follow-up that first
extracts the row into a shared component.
