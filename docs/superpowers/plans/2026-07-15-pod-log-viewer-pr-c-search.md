# Pod Log Viewer — PR C (Search) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live case-insensitive search in the log panel: highlight + match count + ↵/⇧↵ navigation with wrap, filter mode hiding non-matching lines, ⌘F focus, esc clears — fluid at 5k lines.

**Architecture:** `LogSearchModel` (`@Observable @MainActor`) owns query/filter/match state and recomputes matched line IDs debounced off keystrokes (a plain array scan over ≤5000 lines, ~O(n·m), fine on the main actor at 150 ms debounce; highlight ranges are computed per visible row at render time, never for the whole buffer). `LogToolbar` gains the search field; `LogBodyView` filters + highlights and scrolls to the active match.

**Tech Stack:** Swift 6, SwiftUI (`@FocusState`, `AttributedString` highlighting), XCTest.

## Global Constraints

- Spec + handoff §Toolbar/§Search highlight/§Interactions. Scope fence: no tabs/resize (PR D), no export (PR E), no reconnect (PR F).
- Match unit = line (n/N counts matching lines; every occurrence inside a rendered line is highlighted).
- Active match: solid `statusWarn` background, `surfaceWindow`-dark text; inactive matches: `accentDefault` 30% background.
- Navigating to a match pauses follow; esc clears query and filter stays untouched (filter is a separate chip).
- Base branch: `feat/294-log-panel-core` (stacked on PR B #300).
- Test command as in PR B plan.

---

### Task 1: `LogSearchModel`

**Files:**
- Create: `apps/macos/cubelite/cubelite/Models/LogSearchModel.swift`
- Test: `apps/macos/cubelite/cubeliteTests/LogSearchModelTests.swift`

**Interfaces:**
- Consumes: `LogLine` (PR B).
- Produces (for Task 2):

```swift
@Observable @MainActor final class LogSearchModel {
    var query: String                       // set by the field; triggers debounced recompute
    var filterMode: Bool
    private(set) var matchingLineIDs: [Int] // ordered
    private(set) var activeMatchIndex: Int? // index into matchingLineIDs
    var activeLineID: Int? { get }
    var isActive: Bool { get }              // query non-empty
    func recompute(over lines: [LogLine])   // immediate (tests); UI calls recomputeDebounced
    func recomputeDebounced(over lines: [LogLine])
    func next()                             // wraps; sets activeMatchIndex
    func previous()                         // wraps
    func clear()                            // query = "", matches reset (filterMode untouched)
    static func matches(_ line: LogLine, query: String) -> Bool
    func visibleLines(from lines: [LogLine]) -> [LogLine]  // applies filterMode
}
```

- [ ] **Step 1: Write failing tests**

```swift
import XCTest

@testable import cubelite

@MainActor
final class LogSearchModelTests: XCTestCase {

    private func lines(_ messages: [String]) -> [LogLine] {
        messages.enumerated().map { LogLine.parse($0.element, id: $0.offset) }
    }

    func testRecompute_caseInsensitiveSubstring() {
        let model = LogSearchModel()
        model.query = "conn"
        model.recompute(over: lines(["DB CONNECTED", "idle", "connection lost"]))
        XCTAssertEqual(model.matchingLineIDs, [0, 2])
        XCTAssertTrue(model.isActive)
    }

    func testRecompute_emptyQuery_noMatches() {
        let model = LogSearchModel()
        model.query = ""
        model.recompute(over: lines(["a", "b"]))
        XCTAssertTrue(model.matchingLineIDs.isEmpty)
        XCTAssertFalse(model.isActive)
    }

    func testNext_advancesAndWraps() {
        let model = LogSearchModel()
        model.query = "x"
        model.recompute(over: lines(["x1", "y", "x2"]))
        model.next()
        XCTAssertEqual(model.activeLineID, 0)
        model.next()
        XCTAssertEqual(model.activeLineID, 2)
        model.next()
        XCTAssertEqual(model.activeLineID, 0)  // wraps
    }

    func testPrevious_wrapsBackwards() {
        let model = LogSearchModel()
        model.query = "x"
        model.recompute(over: lines(["x1", "y", "x2"]))
        model.previous()
        XCTAssertEqual(model.activeLineID, 2)  // wraps to last
    }

    func testRecompute_keepsActiveLineWhenStillMatching() {
        let model = LogSearchModel()
        model.query = "x"
        model.recompute(over: lines(["x1", "y", "x2"]))
        model.next()  // active = line 0
        model.recompute(over: lines(["x1", "y", "x2", "x3"]))
        XCTAssertEqual(model.activeLineID, 0)
    }

    func testVisibleLines_filterModeHidesNonMatching() {
        let model = LogSearchModel()
        model.query = "x"
        let all = lines(["x1", "y", "x2"])
        model.recompute(over: all)
        model.filterMode = true
        XCTAssertEqual(model.visibleLines(from: all).map(\.id), [0, 2])
        model.filterMode = false
        XCTAssertEqual(model.visibleLines(from: all).count, 3)
    }

    func testVisibleLines_filterWithEmptyQuery_showsAll() {
        let model = LogSearchModel()
        model.filterMode = true
        let all = lines(["a", "b"])
        model.recompute(over: all)
        XCTAssertEqual(model.visibleLines(from: all).count, 2)
    }

    func testClear_resetsQueryAndMatchesKeepsFilterFlag() {
        let model = LogSearchModel()
        model.query = "x"
        model.filterMode = true
        model.recompute(over: lines(["x"]))
        model.clear()
        XCTAssertEqual(model.query, "")
        XCTAssertTrue(model.matchingLineIDs.isEmpty)
        XCTAssertNil(model.activeMatchIndex)
        XCTAssertTrue(model.filterMode)
    }

    func testPerformance_recomputeOver5kLines() {
        let model = LogSearchModel()
        model.query = "error"
        let big = lines((0..<5000).map { "line \($0) some error text here" })
        measure { model.recompute(over: big) }
    }
}
```

- [ ] **Step 2: Run** `-only-testing:cubeliteTests/LogSearchModelTests` — expect build FAILURE.

- [ ] **Step 3: Implement**

```swift
import Foundation
import Observation

/// Search state for the log panel: matched line IDs over the current
/// buffer, an active-match cursor, and an optional filter mode.
///
/// Matching is a case-insensitive substring test per line (match unit =
/// line). Recompute is debounced from keystrokes; highlight ranges are
/// computed per rendered row, never for the whole buffer.
@Observable @MainActor
final class LogSearchModel {

    var query = "" {
        didSet { if query.isEmpty { resetMatches() } }
    }
    var filterMode = false

    private(set) var matchingLineIDs: [Int] = []
    private(set) var activeMatchIndex: Int?

    private var debounceTask: Task<Void, Never>?

    var isActive: Bool { !query.isEmpty }

    var activeLineID: Int? {
        guard let activeMatchIndex, matchingLineIDs.indices.contains(activeMatchIndex)
        else { return nil }
        return matchingLineIDs[activeMatchIndex]
    }

    static func matches(_ line: LogLine, query: String) -> Bool {
        !query.isEmpty && line.message.range(of: query, options: .caseInsensitive) != nil
    }

    func recompute(over lines: [LogLine]) {
        guard isActive else { return resetMatches() }
        let previousActiveLine = activeLineID
        matchingLineIDs = lines.filter { Self.matches($0, query: query) }.map(\.id)
        if let previousActiveLine,
            let kept = matchingLineIDs.firstIndex(of: previousActiveLine)
        {
            activeMatchIndex = kept
        } else {
            activeMatchIndex = nil
        }
    }

    /// Debounced recompute for keystroke-driven updates (150 ms).
    func recomputeDebounced(over lines: [LogLine]) {
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            self?.recompute(over: lines)
        }
    }

    func next() {
        guard !matchingLineIDs.isEmpty else { return }
        if let index = activeMatchIndex {
            activeMatchIndex = (index + 1) % matchingLineIDs.count
        } else {
            activeMatchIndex = 0
        }
    }

    func previous() {
        guard !matchingLineIDs.isEmpty else { return }
        if let index = activeMatchIndex {
            activeMatchIndex = (index - 1 + matchingLineIDs.count) % matchingLineIDs.count
        } else {
            activeMatchIndex = matchingLineIDs.count - 1
        }
    }

    func clear() {
        query = ""
    }

    func visibleLines(from lines: [LogLine]) -> [LogLine] {
        guard filterMode, isActive else { return lines }
        let ids = Set(matchingLineIDs)
        return lines.filter { ids.contains($0.id) }
    }

    private func resetMatches() {
        matchingLineIDs = []
        activeMatchIndex = nil
    }
}
```

- [ ] **Step 4: Run tests** — expect PASS (9 tests incl. the `measure` perf case).

- [ ] **Step 5: Commit**

```bash
git add apps/macos/cubelite/cubelite/Models/LogSearchModel.swift \
        apps/macos/cubelite/cubeliteTests/LogSearchModelTests.swift
git commit -m "feat(macos): LogSearchModel — debounced line matching with cursor and filter"
```

---

### Task 2: Search UI — toolbar field, highlight, match navigation

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Models/LogSessionStore.swift` (each `LogSession` owns a `let search = LogSearchModel()`; `restart()`/`switchContainer` keep the query — only matches recompute)
- Modify: `apps/macos/cubelite/cubelite/Views/LogPanel/LogToolbar.swift` (search field between the stream-context group and the Spacer)
- Modify: `apps/macos/cubelite/cubelite/Views/LogPanel/LogBodyView.swift` (visible lines from `search.visibleLines`, highlight, scroll-to-active)

**Interfaces:**
- Consumes: `LogSearchModel` (Task 1).
- Produces: none new (UI endpoint).

- [ ] **Step 1: Session owns search**

In `LogSession`: add `let search = LogSearchModel()`. In `append(_:)` do nothing search-related (recompute is driven by the view's `.onChange(of: buffer.totalAppended)` → `search.recomputeDebounced(over: buffer.lines)` so paused panels don't pay for hidden updates — actually drive it from the view to keep the model free of view timing). In `restart()` call `search.recompute(over: [])` to reset match state (query survives, per the container-switch spec).

- [ ] **Step 2: Toolbar search field**

In `LogToolbar`, add between `previousChip`/`containerPicker` group and `Spacer()`:

```swift
    @FocusState private var searchFocused: Bool

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 10))
                .foregroundStyle(DesignTokens.textTertiary)
            TextField("search logs", text: Bindable(session.search).query)
                .textFieldStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .focused($searchFocused)
                .onSubmit {
                    if NSEvent.modifierFlags.contains(.shift) {
                        session.search.previous()
                    } else {
                        session.search.next()
                    }
                    session.isFollowing = false
                }
                .onKeyPress(.escape) {
                    session.search.clear()
                    searchFocused = false
                    return .handled
                }
            if session.search.isActive {
                Text(matchCountLabel)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
                Button { session.search.previous(); session.isFollowing = false } label: {
                    Image(systemName: "chevron.up").font(.system(size: 9))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Previous match")
                Button { session.search.next(); session.isFollowing = false } label: {
                    Image(systemName: "chevron.down").font(.system(size: 9))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Next match")
                Button {
                    session.search.filterMode.toggle()
                } label: {
                    Text("filter")
                        .font(.system(size: 10, weight: .medium))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            session.search.filterMode
                                ? DesignTokens.accentDefault : Color.clear)
                        .foregroundStyle(
                            session.search.filterMode
                                ? DesignTokens.surfaceWindow : DesignTokens.textTertiary)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Filter to matching lines")
            } else {
                Text("⌘F")
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(DesignTokens.textDisabled)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .overlay(
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(DesignTokens.borderDefault, lineWidth: 1))
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 28)
        .frame(maxWidth: 400)
        .background(DesignTokens.surfaceWindow)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(
            RoundedRectangle(cornerRadius: 6).stroke(
                session.search.isActive
                    ? DesignTokens.accentDefault.opacity(0.45) : DesignTokens.borderDefault,
                lineWidth: 1))
        .background(
            // ⌘F focuses the field from anywhere in the window.
            Button("") { searchFocused = true }
                .keyboardShortcut("f", modifiers: .command)
                .opacity(0)
        )
    }

    private var matchCountLabel: String {
        let total = session.search.matchingLineIDs.count
        guard total > 0 else { return "0/0" }
        let current = (session.search.activeMatchIndex ?? -1) + 1
        return current > 0 ? "\(current)/\(total)" : "\(total)"
    }
```

Layout change in `body`: `containerPicker`, optional `previousChip`, `searchField`, `Spacer()`, `tailMenu`, `followButton`, `overflowMenu`. Note `.onKeyPress` needs macOS 14 — available (target 14.6).

- [ ] **Step 3: Body — filter, highlight, scroll-to-active**

In `LogBodyView.logList`:
- Render `session.search.visibleLines(from: session.buffer.lines)`.
- `.onChange(of: session.buffer.totalAppended)` additionally calls `session.search.recomputeDebounced(over: session.buffer.lines)`.
- `.onChange(of: session.search.query)` calls `session.search.recomputeDebounced(over: session.buffer.lines)`.
- `.onChange(of: session.search.activeLineID)` → `if let id = session.search.activeLineID { proxy.scrollTo(id, anchor: .center) }`.
- No-matches state: when `session.search.filterMode && session.search.isActive && visible.isEmpty && !session.buffer.lines.isEmpty` show "no matches for “\(query)”" / "esc clears search · filter off shows all \(count) lines" (same fonts as empty state).

In `LogLineRow`: add `let searchQuery: String?` and `let isActiveMatch: Bool`; message text becomes `Text(highlightedMessage)`:

```swift
    private var highlightedMessage: AttributedString {
        var attributed = AttributedString(line.message)
        guard let searchQuery, !searchQuery.isEmpty else { return attributed }
        var searchStart = attributed.startIndex
        while let range = attributed[searchStart...].range(
            of: searchQuery, options: .caseInsensitive)
        {
            attributed[range].backgroundColor =
                isActiveMatch ? DesignTokens.statusWarn : DesignTokens.accentDefault.opacity(0.3)
            if isActiveMatch {
                attributed[range].foregroundColor = DesignTokens.surfaceWindow
            }
            searchStart = range.upperBound
        }
        return attributed
    }
```

Call sites pass `searchQuery: session.search.isActive ? session.search.query : nil`, `isActiveMatch: line.id == session.search.activeLineID`.

- [ ] **Step 4: Full unit suite** — expect PASS.

- [ ] **Step 5: Commit + push + PR**

```bash
git add -A apps/macos/cubelite
git commit -m "feat(macos): log search — ⌘F, highlight, match nav, filter mode"
git push -u origin feat/294-log-search
gh pr create --base feat/294-log-panel-core \
  --title "feat(macos): log panel search — highlight, n/N nav, filter (#294 PR C)" \
  --body "Third stacked PR for #294 (base: PR B). Live case-insensitive search per the design handoff: debounced match recompute (tested at 5k lines), highlight with active-match styling, ↵/⇧↵ navigation with wrap (pauses follow), filter chip, ⌘F focus, esc clears.

Part of #294.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
