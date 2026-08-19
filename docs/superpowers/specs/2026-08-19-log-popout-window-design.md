# Pop-out Log Window — Design Spec

**Issue:** #298 · **Order:** macOS first; desktop (Tauri) replays the model in a later cycle
**Parent design:** `docs/superpowers/specs/2026-07-15-pod-log-viewer-design.md` (§Placement decision: pop-out is post-v1, additive only — the in-shell panel stays the primary surface)

## Summary

Detach a log session from the bottom panel into its own OS window via the `⧉` button in the panel toolbar. Semantics: **move + re-attach** — the tab leaves the panel, the session lives in the window, and closing the window (or pressing `⏷`) returns the tab to the panel with the stream never interrupted. One window per session, unlimited concurrent windows. The window has full feature parity with the panel (container picker, search, follow/pause, tail/load-more, toggles, export, previous instance).

## Decisions

| Question | Decision |
|----------|----------|
| App order | macOS first, desktop later (parity pattern, as #294 → #295) |
| Detach semantics | Move + re-attach; tab leaves the panel |
| Window close | Re-attaches the session to the panel (stream continues); sessions are only closed via explicit close-tab |
| Concurrent windows | One per session, unlimited |
| Feature set in window | Full parity with the panel toolbar/body |
| Persistence | Detached state is not persisted; windows do not survive relaunch |

## Architecture (macOS)

### State — `LogSessionStore` (existing, app-scoped)

- New `detachedSessionIDs: Set<String>` (not persisted).
- New computed `attachedSessions: [LogSession]` — `sessions` minus detached. The tab strip and the panel's `activeSession` resolution use this instead of `sessions`.
- New `detach(sessionID:)` — inserts into the set; if the session was the panel's active tab, moves `activeSessionID` to the next attached session (same fallback rule as `close`).
- New `reattach(sessionID:)` — removes from the set and makes the session the active panel tab.
- `close(sessionID:)` and `closeAll()` also clear the ID(s) from `detachedSessionIDs`.
- New `isDetached(_ sessionID:) -> Bool` — `openWindow` is a SwiftUI Environment action and cannot be called from the store, so entry-point views consult this: when opening logs for a pod whose session is detached, the view calls `openWindow(value:)` (focusing the existing window) instead of `store.open(pod:)`.

No new streams and no buffer copies anywhere: the window binds the same `LogSession` object.

### Scene — `CubeliteApp`

New scene alongside the main `WindowGroup`:

```swift
WindowGroup("Pod Logs", for: String.self) { $sessionID in
    DetachedLogWindowView(sessionID: sessionID)
        .environment(logSessionStore)
        .environment(appSettings)   // Dynamic Type + theme
        .preferredColorScheme(appSettings.colorScheme)
}
.defaultSize(width: 900, height: 500)
```

`openWindow(value: sessionID)` with an already-open value focuses the existing window rather than duplicating it — this gives one-window-per-session for free.

## Views

- **`LogSessionContentView(session:)`** — extracted from `LogPanelView` (currently inline: toolbar + divider + reconnect banner + `LogBodyView`). Both the panel and the detached window compose it. `LogToolbar` and `LogBodyView` are already session-parameterized; no changes to their APIs.
- **`DetachedLogWindowView(sessionID:)`** — resolves the session from the store; minimal header (pod/container title + `⏷` re-attach button) above `LogSessionContentView`. If the ID no longer resolves (session closed elsewhere), the view dismisses its own window.
- **`⧉` detach button** — added to `LogToolbar`, shown only in panel context (an `isDetached`-style flag or environment value). In the window, `⏷` takes its place in the header.
- **Export toast** — remains store-global; `DetachedLogWindowView` replicates the panel's toast overlay so exports triggered from a window surface their confirmation there.

## Lifecycle & edge cases

- **Window closed by any means** (⌘W, traffic-light close, app-level close) → root view `onDisappear` → `reattach(sessionID:)`. The stream is never stopped by detach/re-attach.
- **Session closed while detached** (close-all, pod deleted): the store removes the session; the window's ID stops resolving and the window auto-dismisses.
- **Last attached tab detached**: the panel disappears (existing behavior when no sessions, now keyed on `attachedSessions`); sessions continue in their windows.
- **Logs re-opened for a detached pod**: the entry-point view checks `store.isDetached(sessionID)` and focuses the existing window via `openWindow(value:)` instead of activating a panel tab.
- **App quit**: normal teardown; `stop()` on all sessions (already handled).
- **⌘F and shortcuts**: per-window via the focused scene; the search model is per-session, so no cross-window conflicts.

## Testing

- **Unit** (`LogSessionStoreTests`): detach/re-attach transitions — attached filtering; `activeSessionID` fallback after detaching the active tab; re-attach makes the session active; close-while-detached clears the set; `closeAll` clears the set; `open` on a detached session does not re-attach it.
- **UI**: detach → tab leaves the panel and the window shows the live stream; window close → tab returns; export from the window → toast in the window.
- **Not covered**: heavy XCUITest window-management e2e — SwiftUI multi-window is unreliable under headless XCUITest; the behavior is covered at the store level plus UI smoke.

## Desktop (Tauri) — direction only, detailed design in its own cycle

Same conceptual model (move + re-attach, full parity, one window per session), different mechanics: a second `WebviewWindow` is a separate JS context, so state does not travel for free.

- Window opens on a dedicated route (`/logs-window?session=...`).
- On detach the main window serializes the session's ring buffer + settings over a Tauri event; the pop-out opens its **own** stream and seeds from the transferred buffer. Re-attach reverses the transfer.
- Window close → Tauri `onCloseRequested` → notify main window → re-attach.

The desktop cycle writes its own spec against this model after the macOS implementation lands.
