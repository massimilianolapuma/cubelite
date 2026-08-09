# macOS Merged "All Containers" Log Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate the desktop merged "all containers" log mode (#297, spec `docs/superpowers/specs/2026-08-08-desktop-merged-log-stream-design.md`) to the native macOS app: one interleaved stream of every container in the pod, identity-color-tagged source column, per the same design.

**Architecture:** Client-side merge, mirroring the desktop: extract the per-container follow loop from `LogSession` into a `ContainerLogStream` class (single mode = N=1), then merged mode runs one per container, all appending into the session's single 5000-line `LogRingBuffer`. macOS difference vs desktop: the follow loop never intentionally ends (pause is UI-only), so there is no "restart ended sub-streams on resume" seam; previous-instance is a static fetch and is disabled in merged mode.

**Tech Stack:** Swift 6 / SwiftUI, `@Observable @MainActor`, XCTest.

## Global Constraints

- Two stacked PRs: PR1 = Task 1 (pure refactor, branch `feat/297-macos-merged-stream`), PR2 = Tasks 2–4 (branch `feat/297-macos-merged-mode` stacked on PR1).
- Merged sentinel: `LogSession.allContainers = "*"`, persisted in the existing per-pod UserDefaults key.
- Identity colors from `DesignTokens.swift` (generated — NEVER edit): init containers (`isInit == true`) always `Color.DS.clusterAmber`; non-init containers (sidecars included) cycle `clusterBlue` → `clusterTeal` by the order `fetchPodContainers` returns. Identity, never status colors.
- Source column: 52pt fixed width, between the timestamp column and the severity column, monospaced semibold ~9.5pt, truncating tail — only rendered in merged mode.
- Merged export filename: `<pod>_all.log` / `<pod>_all_full.log` (pass `"all"` to the existing `LogExporter.filename` — zero exporter changes).
- Ring cap stays 5000; ids assigned centrally by the session (MainActor-serialized appends).
- Build/test gates with explicit exit codes (`; echo "X=$?"`, never masked by pipes):
  - Build: `xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build 2>&1 | tail -5; echo "X=${pipestatus[1]}"` (zsh; `PIPESTATUS[0]` in bash)
  - Test: `xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -skip-testing cubeliteUITests 2>&1 | tail -20; echo "X=${pipestatus[1]}"`
  - UITests are NOT runnable from this terminal (TCC) — do not attempt.
- Known flaky (pass when run isolated, unrelated to this work): `LoadClientIdentityTests`, `AppSettingsContextNamespacesTests`. A failure there alone is not a gate failure — rerun isolated with `-only-testing:cubeliteTests/<name>` to confirm.
- Conventional Commits, NO Claude attribution, no session links.

---

### Task 1: Extract `ContainerLogStream` from `LogSession` (PR1, pure refactor)

**Files:**
- Create: `apps/macos/cubelite/cubelite/Models/ContainerLogStream.swift` (add to the Xcode project — the project uses `PBXFileSystemSynchronizedRootGroup`? Verify: if files under `cubelite/` are auto-synced, dropping the file in the folder is enough; otherwise update `project.pbxproj`. Check how a recent file, e.g. `LogSearchModel.swift`, is referenced.)
- Modify: `apps/macos/cubelite/cubelite/Models/LogSessionStore.swift`
- Modify: `apps/macos/cubelite/cubelite/Models/LogLine.swift` (add `container` field)
- Test: existing `cubeliteTests/LogSessionStoreTests.swift` must stay green UNTOUCHED (it drives via `MockLogStreamer` and public API only); new `cubeliteTests/ContainerLogStreamTests.swift`

**Interfaces:**
- Consumes: `PodLogStreaming`, `PodInfo`, `LogLine`, `LogRingBuffer`.
- Produces (later tasks rely on these exact names):
  - `LogLine.container: String?` (new stored property, default `nil` via a `parse(_:id:container:)` default parameter so existing call sites compile unchanged)
  - `final class ContainerLogStream` (`@Observable @MainActor`): `let container: String?`, `private(set) var reconnectAttempt: Int`, `private(set) var nextRetrySeconds: Int`, `var isInBackoff: Bool { reconnectAttempt > 0 }`, `func start()`, `func stop()`, `func retryNow()`
  - `LogSession` keeps its full public surface; `reconnectAttempt`, `nextRetrySeconds`, `isReconnecting` become computed aggregates over `private var streams: [ContainerLogStream]` (length 1 in this task).

- [ ] **Step 1: Add the `container` field to `LogLine`**

In `apps/macos/cubelite/cubelite/Models/LogLine.swift`:

```swift
struct LogLine: Identifiable, Equatable, Sendable {
    let id: Int
    let time: String?
    let level: Level
    let message: String
    /// Source container, set in merged "all containers" mode; nil otherwise.
    let container: String?
    ...
    static func parse(_ raw: String, id: Int, container: String? = nil) -> LogLine {
        ...
        return LogLine(id: id, time: time, level: level, message: message, container: container)
    }
}
```

The memberwise initializer gains the parameter — grep for direct `LogLine(id:` constructions in tests/views and add `container: nil` where needed.

- [ ] **Step 2: Write the failing test for `ContainerLogStream`**

`cubeliteTests/ContainerLogStreamTests.swift` — reuse `MockLogStreamer` (it lives in `LogSessionStoreTests.swift`; if not visible cross-file within the test target, it is — same target, no import needed):

```swift
@MainActor
final class ContainerLogStreamTests: XCTestCase {
    func testForwardsTaggedLines() async throws {
        let mock = MockLogStreamer()
        mock.liveLines = ["2026-08-09T00:00:00Z hello"]
        var got: [(String, String?)] = []
        let stream = ContainerLogStream(
            pod: TestFixtures.pod, context: nil, container: "envoy",
            streamer: mock, backoffBase: 5,
            tailLines: { 500 },
            onLine: { raw, container in got.append((raw, container)) })
        stream.start()
        try await waitUntil { !got.isEmpty }
        XCTAssertEqual(got.first?.1, "envoy")
        stream.stop()
    }

    func testBackoffExposesRetrySeconds() async throws {
        let mock = MockLogStreamer()
        mock.failFirstNStreams = 1
        let stream = ContainerLogStream(
            pod: TestFixtures.pod, context: nil, container: "worker",
            streamer: mock, backoffBase: 5, tailLines: { 500 }, onLine: { _, _ in })
        stream.start()
        try await waitUntil { stream.reconnectAttempt == 1 }
        XCTAssertTrue(stream.isInBackoff)
        XCTAssertGreaterThanOrEqual(stream.nextRetrySeconds, 1)
        stream.stop()
    }

    func testRetryNowShortcutsBackoff() async throws {
        let mock = MockLogStreamer()
        mock.failFirstNStreams = 1
        mock.liveLines = ["2026-08-09T00:00:00Z back"]
        var got = 0
        let stream = ContainerLogStream(
            pod: TestFixtures.pod, context: nil, container: "worker",
            streamer: mock, backoffBase: 30, tailLines: { 500 },
            onLine: { _, _ in got += 1 })
        stream.start()
        try await waitUntil { stream.isInBackoff }
        stream.retryNow()
        try await waitUntil { got > 0 }
        stream.stop()
    }
}
```

Adapt `TestFixtures.pod` / `waitUntil` to the helpers actually present in `LogSessionStoreTests.swift` (it has a `waitUntil` polling helper and pod fixtures — reuse the same idioms verbatim).

- [ ] **Step 3: Run — expect FAIL** (type not found)

Build gate (expected to fail compiling the test target): run the build-for-testing command from Global Constraints.

- [ ] **Step 4: Implement `ContainerLogStream`**

`apps/macos/cubelite/cubelite/Models/ContainerLogStream.swift` — move `followWithReconnect` + `sleepInterruptibly` + `lastRawTimestamp` + `retryNowRequested` out of `LogSession` (currently `LogSessionStore.swift:161-197, 57-60`):

```swift
import Foundation
import Observation

/// Live follow loop of ONE pod container: opens the stream, forwards raw
/// lines tagged with the container name, reconnects with exponential
/// backoff (base·2ⁿ capped at 30s) resuming from the last seen timestamp.
/// Extracted from LogSession so merged "all containers" mode can run N in
/// parallel.
@Observable @MainActor
final class ContainerLogStream {

    let container: String?

    /// Consecutive failed reconnect attempts; 0 while the stream is healthy.
    private(set) var reconnectAttempt = 0
    /// Backoff of the pending retry, for the banner countdown.
    private(set) var nextRetrySeconds = 0
    var isInBackoff: Bool { reconnectAttempt > 0 }

    private let pod: PodInfo
    private let context: String?
    private let streamer: any PodLogStreaming
    private let backoffBase: Double
    private let tailLines: () -> Int
    private let onLine: (String, String?) -> Void
    private var streamTask: Task<Void, Never>?
    /// Full RFC 3339 prefix of the last received line, resent as
    /// `sinceTime` on reconnect so history isn't duplicated.
    private var lastRawTimestamp: String?
    private var retryNowRequested = false

    init(
        pod: PodInfo, context: String?, container: String?,
        streamer: any PodLogStreaming, backoffBase: Double,
        tailLines: @escaping () -> Int,
        onLine: @escaping (String, String?) -> Void
    ) {
        self.pod = pod
        self.context = context
        self.container = container
        self.streamer = streamer
        self.backoffBase = backoffBase
        self.tailLines = tailLines
        self.onLine = onLine
    }

    func start() {
        streamTask = Task { [weak self] in
            await self?.followWithReconnect()
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    /// Skips the current backoff sleep and retries immediately.
    func retryNow() {
        retryNowRequested = true
    }

    private func followWithReconnect() async {
        while !Task.isCancelled {
            do {
                let stream = try await streamer.streamPodLogs(
                    namespace: pod.namespace, pod: pod.name, container: container,
                    tailLines: tailLines(),
                    sinceTime: lastRawTimestamp, inContext: context)
                for try await raw in stream {
                    reconnectAttempt = 0
                    trackTimestamp(raw)
                    onLine(raw, container)
                }
                // Stream ended without error: server closed it — reconnect.
            } catch is CancellationError {
                return
            } catch {
                // Drop — fall through to backoff.
            }
            if Task.isCancelled { return }
            reconnectAttempt += 1
            let delay = min(30, backoffBase * pow(2, Double(reconnectAttempt - 1)))
            nextRetrySeconds = max(1, Int(delay.rounded()))
            await sleepInterruptibly(seconds: delay)
        }
    }

    private func trackTimestamp(_ raw: String) {
        if let space = raw.firstIndex(of: " "), raw.hasPrefix("2"),
            raw[raw.startIndex..<space].contains("T")
        {
            lastRawTimestamp = String(raw[raw.startIndex..<space])
        }
    }

    private func sleepInterruptibly(seconds: Double) async {
        retryNowRequested = false
        let deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
        while ContinuousClock.now < deadline {
            if Task.isCancelled || retryNowRequested { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }
}
```

- [ ] **Step 5: Rewire `LogSession` to delegate to one `ContainerLogStream`**

In `LogSessionStore.swift`, `LogSession`:

- Remove: `followWithReconnect`, `sleepInterruptibly`, `lastRawTimestamp`, `retryNowRequested`, the stored `reconnectAttempt`/`nextRetrySeconds`.
- Add `private var streams: [ContainerLogStream] = []` and computed aggregates:

```swift
    /// Consecutive failed attempts of the worst-off sub-stream (banner text).
    var reconnectAttempt: Int { streams.map(\.reconnectAttempt).max() ?? 0 }
    /// Soonest pending retry among backing-off sub-streams (banner countdown).
    var nextRetrySeconds: Int {
        streams.filter(\.isInBackoff).compactMap(\.nextRetrySeconds).min() ?? 0
    }
    /// Reconnecting = every sub-stream is down (single mode: the one stream).
    var isReconnecting: Bool { !streams.isEmpty && streams.allSatisfy(\.isInBackoff) }

    func retryNow() {
        for stream in streams { stream.retryNow() }
    }
```

- `stream(container:)`'s live branch becomes:

```swift
    private func startStreams(containers targets: [String?]) {
        streams = targets.map { name in
            ContainerLogStream(
                pod: pod, context: context, container: name,
                streamer: streamer, backoffBase: backoffBase,
                tailLines: { [weak self] in self?.tailLines ?? 500 },
                onLine: { [weak self] raw, container in self?.append(raw, from: container) })
        }
        streams.forEach { $0.start() }
    }
```

  called with `[selectedContainer]` from the existing `start()`/`restart()` flow. The previous-instance branch (static `fetchPreviousPodLogs`) stays in `LogSession` unchanged.
- `append` becomes `append(_ raw: String, from container: String?)` and passes the tag: `buffer.append(LogLine.parse(raw, id: nextLineID, container: container))`. Drop the session-level timestamp tracking (moved into the stream). Keep `simulateAppendForTesting(_ raw:)` delegating to `append(raw, from: nil)`.
- `stop()` → `streams.forEach { $0.stop() }; streams = []; streamTask?.cancel()`. `restart()` resets buffer/search as today (the per-stream `lastRawTimestamp` dies with the recreated stream instances — same semantics as before).
- ATTENZIONE ai punti delicati:
  - `restart()` no longer resets a stored `reconnectAttempt` — recreated streams start at 0, aggregate follows. Verify no other writer of the removed stored properties remains.
  - `start()`'s container-fetch error path (`streamError`) is unchanged.
  - Existing tests poll `session.reconnectAttempt`, `session.nextRetrySeconds`, `session.isReconnecting`, `session.retryNow()` — computed versions must be drop-in (they are `@Observable`-tracked since they read observable stream state).

- [ ] **Step 6: Build + full test suite — refactor must be invisible**

Run the two gate commands from Global Constraints. Expected: build X=0; tests X=0 with `LogSessionStoreTests` UNTOUCHED and green (flaky exceptions per Global Constraints).

- [ ] **Step 7: Commit**

```bash
git add apps/macos/cubelite/cubelite/Models/ContainerLogStream.swift apps/macos/cubelite/cubelite/Models/LogSessionStore.swift apps/macos/cubelite/cubelite/Models/LogLine.swift apps/macos/cubelite/cubeliteTests/ContainerLogStreamTests.swift
git commit -m "refactor(macos): extract ContainerLogStream from LogSession"
```

(Plus `project.pbxproj` if the project required manual file registration.)

---

### Task 2: Merged mode in `LogSession` (PR2)

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Models/LogSessionStore.swift`
- Test: extend `cubeliteTests/LogSessionStoreTests.swift` (append a new merged-mode section; existing tests untouched)

**Interfaces:**
- Consumes: `ContainerLogStream` (Task 1 exact API).
- Produces: `static let allContainers = "*"` on `LogSession`; `var isMerged: Bool { selectedContainer == Self.allContainers }`; merged start/switch spawns one stream per `containers` entry (init included, fetch order); `setPrevious` no-op when merged; `switchContainer(to: Self.allContainers)` clears `showingPrevious`.

- [ ] **Step 1: Write failing tests (append to `LogSessionStoreTests.swift`, reusing `MockLogStreamer` + `waitUntil` idioms; give the mock 3 containers: worker, envoy, init-migrate with `isInit: true`)**

```swift
// MARK: - Merged all-containers mode

@MainActor
func testMergedMode_opensOneStreamPerContainer_initIncluded() async throws {
    // select "*", start, waitUntil mock.streamCalls has 3 entries whose
    // container args are ["worker", "envoy", "init-migrate"] (any order of
    // arrival, set-equal; MockLogStreamer records containers).
}

@MainActor
func testMergedMode_interleavesTaggedLinesIntoOneBuffer() async throws {
    // per-container liveLines; waitUntil buffer has all lines; assert each
    // line.container matches its source container and ids are unique/increasing.
}

@MainActor
func testMergedMode_isReconnectingOnlyWhenAllStreamsDown() async throws {
    // fail one container's stream only (extend MockLogStreamer with
    // per-container failure control if failFirstNStreams is global — see
    // note below); assert isReconnecting stays false; fail all → true.
}

@MainActor
func testMergedMode_retryNowFansOut() async throws { ... }

@MainActor
func testMergedMode_setPreviousIsNoOp() async throws {
    // merged session: setPrevious(true) leaves showingPrevious == false
}

@MainActor
func testSwitchToMergedClearsPrevious() async throws { ... }

@MainActor
func testMergedSelectionPersistsInDefaults() async throws {
    // switchContainer(to: LogSession.allContainers) writes "*" to the
    // per-pod key; a new session for the same pod restores merged mode
}

@MainActor
func testMergedMode_ringBoundUnderThreeProducers() async throws {
    // use simulateAppendForTesting-equivalent path or per-container
    // liveLines of 2000 each (6000 > 5000): buffer.lines.count == 5000,
    // buffer.totalAppended == 6000
}

@MainActor
func testSearchQuerySurvivesMergedSwitch() async throws {
    // set session.search.query = "err"; switchContainer(to: "*");
    // query unchanged; recompute against fresh buffer yields 0 then >0
    // after a matching line arrives
}
```

Note su `MockLogStreamer`: se `failFirstNStreams`/`liveLines` sono globali e non per-container, estendilo (nel file di test) con dizionari opzionali per-container (`liveLinesByContainer: [String: [String]]`, `failStreamsForContainers: Set<String>`), mantenendo i default globali così i test esistenti non cambiano.

- [ ] **Step 2: Build+run — expect the new tests to FAIL** (sentinel missing)

- [ ] **Step 3: Implement**

In `LogSession`:

```swift
    /// Sentinel container selection: merged stream of every container.
    static let allContainers = "*"
    var isMerged: Bool { selectedContainer == Self.allContainers }
```

- `start()`: remembered value `"*"` must survive the fallback (the current `fetched.first { $0.name == remembered }` lookup discards it):

```swift
    let remembered = defaults.string(forKey: containerMemoryKey)
    let name: String? =
        remembered == Self.allContainers
        ? Self.allContainers
        : fetched.first { $0.name == remembered }?.name ?? fetched.first?.name
```

- Live-stream startup: `startStreams(containers: isMerged ? containers.map(\.name) : [selectedContainer])`.
- `switchContainer(to:)`: unchanged flow works for `"*"` (persists, restarts); add `if name == Self.allContainers { showingPrevious = false }` before `restart()`.
- `setPrevious(_:)`: `guard !isMerged else { return }` first line.

- [ ] **Step 4: Build + full suite green, commit**

```bash
git add apps/macos/cubelite/cubelite/Models/LogSessionStore.swift apps/macos/cubelite/cubeliteTests/LogSessionStoreTests.swift
git commit -m "feat(macos): merged all-containers session mode"
```

---

### Task 3: Identity color helper + source column in `LogLineRow`

**Files:**
- Create: `apps/macos/cubelite/cubelite/Views/LogPanel/ContainerIdentity.swift`
- Modify: `apps/macos/cubelite/cubelite/Views/LogPanel/LogBodyView.swift` (`LogLineRow` + call site)
- Test: `cubeliteTests/ContainerIdentityTests.swift`

**Interfaces:**
- Consumes: `ContainerInfo` (`name`, `isInit`), `Color.DS.clusterBlue/-Teal/-Amber` from `DesignTokens.swift`.
- Produces: `enum ContainerIdentity { static func color(for name: String, in containers: [ContainerInfo]) -> Color }`; `LogLineRow` gains an optional source parameter.

- [ ] **Step 1: Failing tests**

```swift
@MainActor
final class ContainerIdentityTests: XCTestCase {
    private let containers = [
        ContainerInfo(name: "worker", isInit: false, ...),
        ContainerInfo(name: "envoy", isInit: false, ...),
        ContainerInfo(name: "extra", isInit: false, ...),
        ContainerInfo(name: "init-migrate", isInit: true, ...),
    ]  // fill remaining ContainerInfo fields per its real initializer

    func testInitAlwaysAmber() {
        XCTAssertEqual(ContainerIdentity.color(for: "init-migrate", in: containers), Color.DS.clusterAmber)
    }
    func testRegularsCycleBlueTeal() {
        XCTAssertEqual(ContainerIdentity.color(for: "worker", in: containers), Color.DS.clusterBlue)
        XCTAssertEqual(ContainerIdentity.color(for: "envoy", in: containers), Color.DS.clusterTeal)
        XCTAssertEqual(ContainerIdentity.color(for: "extra", in: containers), Color.DS.clusterBlue)
    }
    func testUnknownFallsBackToBlue() {
        XCTAssertEqual(ContainerIdentity.color(for: "ghost", in: containers), Color.DS.clusterBlue)
    }
}
```

(Adapt `Color.DS.` prefix to how `DesignTokens.swift` actually namespaces the tokens — check `clusterBlue` usage in `IdentityHelpers.swift`.)

- [ ] **Step 2: Implement**

```swift
import SwiftUI

/// Identity palette for the merged log view source column (spec §UI):
/// init containers always amber; regular containers (sidecars included)
/// cycle blue → teal by fetch order. Identity, never status colors.
enum ContainerIdentity {
    private static let cycle: [Color] = [.DS.clusterBlue, .DS.clusterTeal]

    static func color(for name: String, in containers: [ContainerInfo]) -> Color {
        if containers.first(where: { $0.name == name })?.isInit == true {
            return .DS.clusterAmber
        }
        let regulars = containers.filter { !$0.isInit }
        let index = regulars.firstIndex { $0.name == name } ?? 0
        return cycle[index % cycle.count]
    }
}
```

- [ ] **Step 3: Source column in `LogLineRow`**

Add an optional `sourceName: String?` + `sourceColor: Color?` (or a small struct) to `LogLineRow`; render between the timestamp column and the severity column, following the file's existing fixed-width column pattern:

```swift
if let sourceName, let sourceColor {
    Text(sourceName)
        .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
        .foregroundStyle(sourceColor)
        .frame(width: 52, alignment: .leading)
        .lineLimit(1)
        .truncationMode(.tail)
}
```

Call site in `LogBodyView`: pass the source only when `session.isMerged && line.container != nil`, color via `ContainerIdentity.color(for: line.container!, in: session.containers)`.

- [ ] **Step 4: Build + suite green, commit**

```bash
git add apps/macos/cubelite/cubelite/Views/LogPanel/ContainerIdentity.swift apps/macos/cubelite/cubelite/Views/LogPanel/LogBodyView.swift apps/macos/cubelite/cubeliteTests/ContainerIdentityTests.swift
git commit -m "feat(macos): identity-colored source column in merged log view"
```

---

### Task 4: Toolbar — picker entry, previous chip, export filename

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Views/LogPanel/LogToolbar.swift`
- Test: extend `cubeliteTests/LogExporterTests.swift` (filename) — the picker/chip logic is view-only SwiftUI; cover the session-level behavior it drives via the Task 2 tests (already done) and keep view changes minimal.

**Interfaces:**
- Consumes: `LogSession.allContainers`, `session.isMerged` (Task 2), `ContainerIdentity` (Task 3, optional for the picker label dot).
- Produces: picker menu third group with an "all containers" `Button` → `session.switchContainer(to: LogSession.allContainers)`; previous chip hidden when merged; export passes `"all"`.

- [ ] **Step 1: Failing test — export filename**

Extend `LogExporterTests`:

```swift
func testMergedFilenameUsesAll() {
    XCTAssertEqual(LogExporter.filename(pod: "api-0", container: "all", full: false), "api-0_all.log")
    XCTAssertEqual(LogExporter.filename(pod: "api-0", container: "all", full: true), "api-0_all_full.log")
}
```

(Se la firma esistente già produce questo output, il test passa subito — va bene: è un lock-in, documentalo nel report.)

- [ ] **Step 2: Toolbar changes**

- `containerPicker` menu: after the "Init containers" section add a `Divider()` and:

```swift
Button {
    session.switchContainer(to: LogSession.allContainers)
} label: {
    if session.isMerged { Image(systemName: "checkmark") }
    Text("all containers")
}
```

  (macOS `Menu` non rende sottotitoli — la sub-label "merged stream, color-tagged" del design è resa dal comportamento; deviazione accettata e da annotare nel report. Segui il pattern checkmark delle voci esistenti.)
- Picker label when merged: show `all containers` (skip the state dot, or use `clusterBlue`; follow the existing label builder structure and keep it minimal).
- `previousChip`: add `!session.isMerged` to its render condition.
- Export call site (`export(full:)`): container argument becomes `session.isMerged ? "all" : session.selectedContainer`.

- [ ] **Step 3: Build + full suite green (gates from Global Constraints), commit**

```bash
git add apps/macos/cubelite/cubelite/Views/LogPanel/LogToolbar.swift apps/macos/cubelite/cubeliteTests/LogExporterTests.swift
git commit -m "feat(macos): all-containers picker entry, merged export filename"
```

---

## Delivery

- PR1: branch `feat/297-macos-merged-stream` (contiene questo piano) → Task 1. Titolo: `refactor(macos): extract ContainerLogStream from LogSession (#297)`.
- PR2: branch `feat/297-macos-merged-mode` stacked su PR1 → Task 2–4. Titolo: `feat(macos): merged "all containers" log stream (#297)`. Chiude #297.
- Push con `massilp`; merge dell'utente. Dopo il merge di PR1, ribasare PR2 su main (squash → `git rebase --onto origin/main <PR1-tip>`).
- Verifica manuale post-merge consigliata (UITests non automatizzabili): pod multi-container reale, merged view, colori, export.
