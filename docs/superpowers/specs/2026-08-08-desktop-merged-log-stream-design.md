# Desktop merged "all containers" log stream — design (#297)

Date: 2026-08-08 · Scope: desktop app (Tauri/Svelte) · Follow-up of the #295 log panel stack.
The macOS implementation is a separate sub-project that translates this same design to Swift.

References: `design_handoff_pod_log_viewer` README (§Menus, §Line anatomy),
`docs/superpowers/specs/2026-08-04-desktop-pod-log-viewer-design.md`, issue #297.

## Decision

Merge happens **in the frontend**. The existing `stream_pod_log` Tauri command is
untouched: the session opens one single-container stream per container and merges
client-side. Rationale: no new Rust API surface, the per-stream reconnect/backoff
logic in `logSession.svelte.ts` is reused as-is, and the design maps 1:1 onto the
macOS Swift architecture (which has no Tauri backend), so both apps share one
design with two translations.

## Architecture

### 1. `ContainerStream` extraction (refactor, no behavior change)

Extract the per-stream lifecycle currently inlined in `LogSession` into an
internal `ContainerStream` class owning: `streamId`, event unlisteners,
`lastTime` (resume point), retry timer/attempt/`nextRetryAt`, and the
generation guard. It pushes received lines into a sink callback provided by the
session and reports status transitions (`connecting | streaming | reconnecting |
ended | error`) upward.

Single-container mode becomes the N=1 case of the same code path.

### 2. Merged mode

- Sentinel `ALL_CONTAINERS = "*"` as the session's `container` value; remembered
  per pod via the existing `logPanel.containers` persistence.
- On open with the sentinel, the session creates one `ContainerStream` per
  container in the pod — **including init containers** (the handoff shows
  init-migrate color-tagged amber in the merged view).
- Each stream tags its lines with its container name: frontend-only optional
  `container?: string` field on `LogLine` (`tauri.ts`); the Rust struct is not
  modified. Tagged lines go into the session's shared pending buffer → batched
  flush into the single 5k `LogRing`, ordered by receive time (per issue spec).

### 3. Aggregate session status

- `streaming` if ≥1 sub-stream is streaming;
- else `reconnecting` if ≥1 sub-stream is retrying (banner shows the countdown
  of the sub-stream with the nearest retry);
- else `error` if all sub-streams errored; `ended` when all ended.
- `retryNow()` fires every waiting sub-stream immediately.
- Tail semantics: `tailLines` applies per container stream (N × tail lines may
  arrive at open; ring cap bounds memory).

## UI

- **Container picker**: "all containers" entry after a separator, subtitle
  "merged stream, color-tagged" (§Menus).
- **Source column** (merged mode only): 52px, Geist Mono 600 9.5px, container
  name colored from the **identity palette** (§Line anatomy): init containers
  always `--identity-amber`; regular containers cycle `--identity-blue` →
  `--identity-teal` by pod-spec order (matches the handoff: worker blue, envoy
  teal, init-migrate amber). Identity colors, never status colors.
- **Disabled in merged mode**: previous-instance toggle and the `⟲` chip.
- **Search/filter**: operate on the merged buffer unchanged; switching
  merged ↔ single preserves the search query (`logSearch` state lives outside
  `LogSession`; covered by test).

## Export

Merged export filename: `<pod>_all.log` / `<pod>_all_full.log`. Implemented by
passing `"all"` as the container to the existing `log_export_filename`; verify
sanitization accepts it (it does — plain alphanumeric), no Rust change expected.

## Testing

- Unit (vitest): sub-stream tagging lands container names in the ring; receive-
  order interleaving; aggregate status transitions (one stream drops → still
  `streaming`; all drop → `reconnecting`); `retryNow()` fans out; switch
  merged ↔ single preserves search query; export filename `<pod>_all[_full].log`;
  previous/⟲ disabled state.
- Ring bound: no dropped lines below cap with N producers (5k cap respected).
- e2e (playwright + tauri-mock): multi-container pod fixture, open merged view,
  assert color-tagged source column and interleaved lines from all containers.

## Delivery

Two stacked PRs:
1. `refactor(desktop): extract ContainerStream from LogSession` — pure refactor,
   existing tests stay green.
2. `feat(desktop): merged all-containers log stream` — sentinel, tagging, status
   aggregation, picker entry, source column, export, tests.

Out of scope: macOS translation (follow-up sub-project under #297), pop-out
window (#298).
