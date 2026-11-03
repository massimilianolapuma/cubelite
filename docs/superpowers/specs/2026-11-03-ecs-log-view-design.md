# ECS log view (desktop + macOS) — design

Date: 2026-11-03 · Issue: #486 · Owner: desktop-agent, macos-agent · Status: approved 2026-11-03 (A: Raw · JSON · ECS mode, B: custom fields at top level)

## 1. Intent

The services in the user's clusters ship their logs to Elastic, and the user
reads them in Kibana as **Elastic Common Schema (ECS)** documents:
`@timestamp`, `log.level`, `message`, `service.name`, `error.*`, `trace.id`,
`kubernetes.*`… In CubeLite the same line is either a wall of text (raw) or a
generic JSON row (JSON view, #454/#461 desktop, #477 macOS).

Goal (scope decided 2026-11-02: **both**):
1. **View**: lines that are already ECS are shown the way Kibana shows them —
   flattened dotted field names (`error.stack_trace`, not a nested tree), the
   useful fields on the row, a field table when expanded.
2. **Conversion**: *any* line — plain text or non-ECS JSON — can be shown,
   copied and exported as the ECS document it would become in Elastic, with
   the Kubernetes metadata CubeLite already knows (namespace, pod, container).

## 2. Goals, non-goals, anti-goals

Goals
- A third log view mode, **ECS**, next to Raw and JSON, in every place that
  has the JSON toggle today: log panel, pop-out log window, aggregated Logs
  view; desktop and macOS.
- In ECS mode every line is rendered as an ECS document (§4): collapsed row
  Kibana-Discover style, expanded row = sorted field table.
- `Copy ECS` on an expanded line; `Export … ` in ECS mode writes NDJSON
  (`.ndjson`, one ECS document per line).

Non-goals
- No connection to Elasticsearch/Kibana (that is #483).
- No ECS validation against the full schema, no field-type mapping, no
  ingest-pipeline emulation beyond the alias table in §4.2.
- No field picker / column chooser, no field-based search: search stays
  full-text on the raw line, level filter unchanged.
- No change to the Rust core or Tauri backend on desktop (frontend-only, like
  the JSON view); no change to `LogStreamService` on macOS beyond §6.
- Logfmt and multi-line (stack trace spread over several lines) joining.

Anti-goals
- ECS mode never alters, hides or reorders lines; the raw text stays reachable
  (`Copy raw`).
- No slowdown of the live stream: conversion is lazy, only for rendered rows,
  only in ECS mode (export converts once, on click).
- No new colours or font sizes outside the design tokens (design-lint at 0).
- The conversion must not invent data: a field is added only from the line
  itself or from metadata CubeLite knows for sure.

## 3. Mode control

- The `{}` toggle becomes a 3-way segmented control **Raw · JSON · ECS** in
  the same toolbar position (desktop `LogToolbar.svelte` and the aggregated
  view header; macOS `LogToolbar.swift` and `AggregatedLogsView`), `type-caption`,
  same chrome as the existing segmented controls (builder picks the existing
  component on each platform).
- State: one persisted `viewMode: "raw" | "json" | "ecs"` per surface,
  replacing the boolean keys. Migration on read: old `jsonView == true` →
  `"json"`, else `"raw"` (desktop keys `logPanel.jsonView` / the aggregated
  key; macOS `logPanel.jsonView` / `logs.jsonView`). New keys
  `logPanel.viewMode` and `logs.viewMode`.
- Expanded-line state (`expanded` set) is shared by JSON and ECS modes and
  survives switching between them, as today.

## 4. Conversion: line → ECS document

A pure function on each platform, same rules, same test vectors:

```
toEcs(line, meta) -> EcsDocument     // ordered map of dotted key -> JSON value
meta = { namespace, pod, container? }
```

`EcsDocument` is kept **flattened** (dotted keys, `{"log.level": "info"}`) for
display; `Copy ECS` and export emit the nested form (`{"log":{"level":"info"}}`),
which is what Elasticsearch stores and what an ECS logger writes.

### 4.1 Plain-text line (not a JSON object per the JSON-view detection rule)

| ECS field | value |
|---|---|
| `@timestamp` | kubelet timestamp of the line (full RFC 3339), omitted if none |
| `log.level` | core-detected level (`debug`/`info`/`warn`/`error`) |
| `message` | the message (kubelet prefix stripped), verbatim |
| + metadata | §4.3 |

### 4.2 JSON-object line

1. Flatten the object to dotted keys (`{"log":{"level":"x"}}` → `log.level`;
   arrays are values, not flattened; a literal dotted key and a nested path
   that collide → the nested one wins, the other is kept under its own key
   with a `_` suffix — edge case, builder may pick the exact suffix).
2. If the line is **already ECS** (`ecs.version` present) only steps 4–5
   apply: fields are kept as they are.
3. Otherwise rename the first match of each alias group, case-insensitive on
   the key, when the target field is absent (unmatched keys stay at top
   level unchanged — Filebeat `keys_under_root` behaviour):

| target | aliases |
|---|---|
| `@timestamp` | the JSON-view time keys (`timestamp`, `time`, `ts`, `t`) — only if the value is an ISO-8601 string; epoch numbers stay where they are |
| `log.level` | `level`, `severity`, `lvl` — value lowercased; pino numbers mapped to names (`10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal`) |
| `message` | `msg`, `event` (string values only) |
| `log.logger` | `logger`, `logger_name`, `loggerName`, `name` (string, only when `log.logger` absent) |
| `error.message` | `error`, `err` when a string; `error.message`/`err.message` when an object |
| `error.stack_trace` | `stack`, `stacktrace`, `stack_trace`, `err.stack` |
| `trace.id` | `trace_id`, `traceId`, `traceid` |
| `span.id` | `span_id`, `spanId` |
| `service.name` | `service`, `service_name`, `serviceName` (string) |

4. Fill when absent: `@timestamp` from the kubelet timestamp; `log.level`
   from the core level; `message`: none is invented (Kibana shows the
   document without it).
5. Metadata §4.3, then `ecs.version` = `"8.11.0"` when absent.

### 4.3 Kubernetes metadata (only when absent in the line)

`kubernetes.namespace`, `kubernetes.pod.name`, `container.name` (when the line
came from a known container — merged mode tag or the single selected
container; omitted for "all containers" lines without a tag). Nothing else:
no node, labels, image or cluster name (CubeLite would have to fetch them).

## 5. Rendering

### 5.1 Collapsed row (ECS mode)

```
[94px time] [source] LEVEL  [service.name]  message      error.message=…  trace.id=…  other.field=…
```

- Level badge and row tint from `log.level` (mapped like JSON view).
- `service.name`, when present, as a `type-micro` chip in `text-text-secondary`
  before the message.
- Message: `message`, else the JSON-view fallback rules. Display flattening
  of control characters as in JSON view (`↵ `).
- Tail: the remaining flattened fields, `key=value`, JSON-view styling and 60-char
  compaction, **excluding** `@timestamp`, `log.level`, `message`,
  `service.name`, `ecs.version` and the §4.3 metadata (identical on every row
  of a pod — noise). `error.message`, `error.type` and `trace.id` come first
  when present, then the rest in document order.
- Plain-text lines in ECS mode look like raw lines with the level badge
  (their document has no extra fields); they are expandable like any ECS row.

### 5.2 Expanded row — Kibana-like field table

- Two columns: field name (`type-micro` mono, `text-text-secondary`) and value
  (`type-micro` mono; scalar colours as the JSON tree: strings teal, numbers
  amber, booleans/null violet; arrays/objects compact JSON). Rows sorted by
  field name, Kibana order (`@timestamp` sorts first). Long values wrap;
  multi-line values (stack traces) keep their newlines in the table.
- Header buttons, `type-caption`, as in the JSON tree: `Copy ECS` (nested,
  pretty-printed, 2-space) and `Copy raw` (line exactly as received).
- Fields added by the conversion (§4.1 fill, §4.3, `ecs.version`) are marked
  with a small `text-text-tertiary` "added" hint after the value so the user
  can tell the line from the enrichment.
- Same row chrome, `bg-surface-raised` block, virtualiser measuring as JSON view.

### 5.3 Export

- In ECS mode the export actions (panel overflow menu on both platforms;
  aggregated view where it has export) write NDJSON: one compact nested ECS
  document per line, filename `<pod>_<container>[_full].ndjson`. Raw/JSON
  modes keep today's `.log` export.

## 6. Platform notes

- **Desktop**: `lib/log-ecs.ts` (pure, next to `log-json.ts`, reusing its
  parser, `mapLevel`, `jsonText`), `EcsFieldTable.svelte`, `LogLineRow.svelte`
  gains a `mode` prop replacing `jsonView`. `LogLine.time` already holds the
  full kubelet RFC 3339 timestamp.
- **macOS**: `Models/ECSDocument.swift` (pure, reusing `JSONValue`),
  `Views/LogPanel/ECSFieldTable.swift`, `LogLineRow` mode parameter.
  `LogLine.time` keeps only the time of day today
  (`components(separatedBy: "T").last`): add the full RFC 3339 timestamp to
  `LogLine` (e.g. `timestamp: String?`) so `@timestamp` carries the date; the
  displayed clock is unchanged. `LogExporter` gains the NDJSON variant.
- macOS numbers keep the source text (as in the JSON view), desktop keeps
  `bigint` for large integers; both serialise them exactly.

## 7. Tests

- Unit, same vectors on both platforms: plain line → document; non-ECS JSON
  with each alias group; pino numeric level; epoch `ts` not moved to
  `@timestamp`; already-ECS line (has `ecs.version`) kept as is + metadata
  only when absent; nested ↔ flattened round trip; collision rule; container
  omitted when unknown; tail exclusion and ordering.
- Desktop vitest: segmented control + migration from `logPanel.jsonView`;
  row/table rendering; Copy ECS; NDJSON export content and filename.
  Playwright: emit a JSON line, switch to ECS, assert `service.name` chip and
  a table row after expand.
- macOS XCTest: converter, store mode migration, exporter NDJSON.
- design-lint at zero.

## 8. Delivery

Two issues/PRs from #486: desktop first, then macOS (same order as the JSON
view), each closing its half; #486 closes with the second.

## 9. Decisions for the user

A. **Where ECS lives.** Third mode **Raw · JSON · ECS** in the toolbar
   (recommended: one place, converts every line, export follows the mode)
   **or** an `ECS` tab inside the expanded JSON row only (smaller change, but
   plain-text lines never get converted and export stays raw).

B. **Unmapped custom fields** of non-ECS JSON. Keep them at top level as
   logged (recommended: what Filebeat does with `keys_under_root`, what the
   user sees in Kibana today) **or** move them under a `labels.*` /
   custom namespace (stricter ECS, but differs from the user's Kibana).

## 10. Calls made by the author (check while reading)

- `ecs.version` `8.11.0` added when absent.
- Epoch-number timestamps are not converted to `@timestamp` (no unit guessing).
- `container.name` (ECS) rather than `kubernetes.container.name` (Filebeat);
  `kubernetes.namespace` and `kubernetes.pod.name` as in Filebeat.
- No `event.original`: `Copy raw` already covers it and it would double the
  export size.
- Penpot board not required: mode of an existing view, same exemption as the
  JSON view spec.
