# Pod Log Viewer — PR F (Resilience) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the live log stream drops, reconnect automatically with exponential backoff (2s·2ⁿ, cap 30s), show the warn banner ("stream lost — reconnecting (attempt N, next retry Xs)" + "retry now"), resume without duplicate lines via `sinceTime`.

**Architecture:** The live-follow branch of `LogSession.stream(container:)` becomes a reconnect loop: on stream end/error (excluding cancellation and previous-mode fetches) it bumps `reconnectAttempt`, sleeps the backoff (interruptible by `retryNow()`), and re-opens the stream passing the last seen raw timestamp as `sinceTime`. `reconnectAttempt` resets on the first received line. Backoff base is injectable (`backoffBase`, default 2s; tests use 0.02s) through `LogSessionStore`. Banner renders under the toolbar in `LogPanelView`.

## Global Constraints

- Handoff §States (Reconnecting). Base branch: `feat/294-log-entry-export` (stacked on PR E #303). Test command as in PR B plan.
- Fatal setup errors (container fetch failure) keep the existing `streamError` → `UnifiedErrorState` path; only live-stream drops reconnect.

## Tasks

### Task 1: Session reconnect loop (TDD)

`MockLogStreamer` gains `var failFirstNStreams = 0` (those calls return a stream that finishes immediately after yielding `liveLines`; later calls stay open) and records `sinceTime` per call. Tests:
- `testStreamDrop_entersReconnectingAndRetries`: failFirstNStreams=1 → reconnectAttempt reaches 1, then a second stream call arrives and attempt resets to 0.
- `testReconnect_passesSinceTimeOfLastLine`: first stream yields a timestamped line then dies → second `streamCalls` entry has `sinceTime == "2026-07-15T10:00:00Z"`.
- `testRetryNow_shortcutsBackoff`: backoffBase high (5s), drop → wait for reconnectAttempt==1 → `retryNow()` → second stream call arrives well before the backoff.

Implementation (`LogSession`): `private(set) var reconnectAttempt = 0`, `private(set) var nextRetrySeconds = 0`, `var isReconnecting: Bool { reconnectAttempt > 0 }`, `private var lastRawTimestamp: String?` (set in `append` from the RFC3339 prefix when present), `private var retryNowRequested = false`, `func retryNow()`. Live branch loops: open stream (with `sinceTime: lastRawTimestamp`), reset attempt on each line, on end/error bump attempt, compute `min(30, backoffBase * 2^(attempt-1))`, sleep in 50ms slices until elapsed or `retryNowRequested`/cancelled. `restart()` resets attempt/lastRawTimestamp. `LogSession`/`LogSessionStore` init gain `backoffBase: Double = 2`.

### Task 2: Banner UI

`LogPanelView`: between toolbar and body, when `session.isReconnecting`:
warn-tinted banner (bg `statusWarn` 8%, bottom border warn 25%): pulsing 7pt warn dot · "stream lost — reconnecting (attempt \(n), next retry \(s)s)" mono 11 warn · Spacer · "retry now" button (plain, warn, underline on hover) → `session.retryNow()`.

### Task 3: Suite, PR

Full unit suite → commit → push → PR base `feat/294-log-entry-export`, title `feat(macos): log stream auto-reconnect with backoff (#294 PR F)`.
