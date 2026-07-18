# macOS Quick-Fix Batch Implementation Plan (#314)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four native macOS defects: empty screen when no namespace is resolved, un-closeable pod detail panel, Describe action tearing down the panel, and locale-formatted port numbers with unvalidated input.

**Architecture:** All changes are in the SwiftUI macOS app (`apps/macos/cubelite`). Namespace memory becomes a persisted `AppSettings` dictionary consulted during context selection in `MainView`. Panel close is a callback threaded from `MainView+DetailArea`. Describe bypasses the mutation-notification path in `ResourceDetailView.runAction`. Port parsing moves into a pure `PortForwardInput` helper that the view consumes.

**Tech Stack:** Swift 5 / SwiftUI, `@Observable` + UserDefaults persistence, XCTest.

## Global Constraints

- Working tree has **pre-existing uncommitted changes** in `apps/macos/cubelite/cubelite/Info.plist` and `apps/macos/cubelite/cubelite/Services/KubeAPIService.swift` (unrelated #309 debugging). NEVER stage or commit these files. Always `git add` explicit paths.
- Branch: `fix/macos-quickfix-batch-314`. Reference issue #314 in commits.
- Build: `xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build`
- Test: `xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -skip-testing cubeliteUITests` (append `-only-testing cubeliteTests/<ClassName>` for a single class; run build-for-testing first whenever sources changed)
- Test style: XCTest classes, `@MainActor`, `tearDown` cleans every UserDefaults key the test touched (see `cubeliteTests/AppSettingsAppearanceTests.swift` for the house pattern).
- Commit messages: Conventional Commits, end body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: AppSettings namespace memory

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Models/AppSettings.swift`
- Test: `apps/macos/cubelite/cubeliteTests/AppSettingsNamespaceMemoryTests.swift` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 2):
  - `enum AppSettings.RecalledNamespace: Equatable { case none; case all; case named(String) }`
  - `func rememberNamespace(_ namespace: String?, for context: String)` — `nil` means "All Namespaces".
  - `func recallNamespace(for context: String) -> RecalledNamespace`

- [ ] **Step 1: Write the failing tests**

Create `apps/macos/cubelite/cubeliteTests/AppSettingsNamespaceMemoryTests.swift`:

```swift
import XCTest

@testable import cubelite

// MARK: - AppSettingsNamespaceMemoryTests

/// Tests that the last-selected namespace per context is remembered,
/// recalled, and persisted through `UserDefaults`.
@MainActor
final class AppSettingsNamespaceMemoryTests: XCTestCase {

    private let lastNamespacesKey = "lastNamespaces"

    override func tearDown() {
        super.tearDown()
        UserDefaults.standard.removeObject(forKey: lastNamespacesKey)
    }

    func testRecall_withoutRecord_returnsNone() {
        let sut = AppSettings()

        XCTAssertEqual(sut.recallNamespace(for: "prod"), .none)
    }

    func testRemember_namedNamespace_isRecalled() {
        let sut = AppSettings()
        sut.rememberNamespace("monitoring", for: "prod")

        XCTAssertEqual(sut.recallNamespace(for: "prod"), .named("monitoring"))
    }

    func testRemember_nil_isRecalledAsAllNamespaces() {
        let sut = AppSettings()
        sut.rememberNamespace(nil, for: "prod")

        XCTAssertEqual(sut.recallNamespace(for: "prod"), .all)
    }

    func testRemember_isScopedPerContext() {
        let sut = AppSettings()
        sut.rememberNamespace("monitoring", for: "prod")

        XCTAssertEqual(sut.recallNamespace(for: "staging"), .none)
    }

    func testRemember_persists_throughUserDefaults() {
        let sut = AppSettings()
        sut.rememberNamespace("kube-system", for: "dev")
        sut.rememberNamespace(nil, for: "prod")

        // Re-create to simulate app restart reading saved values.
        let sut2 = AppSettings()
        XCTAssertEqual(sut2.recallNamespace(for: "dev"), .named("kube-system"))
        XCTAssertEqual(sut2.recallNamespace(for: "prod"), .all)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
```

Expected: **build FAILS** — `AppSettings` has no member `recallNamespace` / `rememberNamespace`. (Compile failure is the XCTest equivalent of a failing test here.)

Note: the new test file must be part of the `cubeliteTests` target. The project uses Xcode 16 file-system-synchronized groups, so files added on disk are picked up automatically; if the build fails with "file not found in target", add it via the project file.

- [ ] **Step 3: Implement namespace memory in AppSettings**

In `apps/macos/cubelite/cubelite/Models/AppSettings.swift`:

Add to the `// MARK: - Advanced` section, after `contextNamespaces` (line 81):

```swift
    /// Last namespace the user selected per context, restored on cluster
    /// switch. The empty-string marker records an explicit "All Namespaces"
    /// choice, distinct from having no record at all.
    var lastNamespaces: [String: String] = [:] {
        didSet {
            if let data = try? JSONEncoder().encode(lastNamespaces) {
                UserDefaults.standard.set(data, forKey: Keys.lastNamespaces)
            }
        }
    }

    /// Marker stored in `lastNamespaces` for an "All Namespaces" selection.
    private static let allNamespacesMarker = ""

    /// Outcome of looking up the remembered namespace for a context.
    enum RecalledNamespace: Equatable {
        /// No selection has been recorded for this context.
        case none
        /// The user last selected "All Namespaces".
        case all
        /// The user last selected this specific namespace.
        case named(String)
    }

    /// Records the namespace selected for `context`. `nil` records
    /// an explicit "All Namespaces" choice.
    func rememberNamespace(_ namespace: String?, for context: String) {
        lastNamespaces[context] = namespace ?? Self.allNamespacesMarker
    }

    /// Returns the remembered namespace selection for `context`.
    func recallNamespace(for context: String) -> RecalledNamespace {
        guard let stored = lastNamespaces[context] else { return .none }
        return stored == Self.allNamespacesMarker ? .all : .named(stored)
    }
```

In `init()`, after the `contextNamespaces` decode block (line 122), add:

```swift
        if let data = d.data(forKey: Keys.lastNamespaces),
            let decoded = try? JSONDecoder().decode([String: String].self, from: data)
        {
            lastNamespaces = decoded
        }
```

In `enum Keys` (line 159), add:

```swift
        static let lastNamespaces = "lastNamespaces"
```

- [ ] **Step 4: Build and run the new tests**

```
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -only-testing cubeliteTests/AppSettingsNamespaceMemoryTests
```

Expected: `** TEST SUCCEEDED **`, 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/macos/cubelite/cubelite/Models/AppSettings.swift apps/macos/cubelite/cubeliteTests/AppSettingsNamespaceMemoryTests.swift
git commit -m "feat(macos): remember last-selected namespace per context (#314)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Restore remembered namespace on context selection

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Views/MainView.swift:188-192` (namespace pick callback) and `:286-295` (context-change handler)

**Interfaces:**
- Consumes (from Task 1): `appSettings.rememberNamespace(_:for:)`, `appSettings.recallNamespace(for:) -> RecalledNamespace`.
- Produces: no new API — behavior change only. `sidebarSelection` is now set synchronously when a remembered namespace exists.

- [ ] **Step 1: Record explicit namespace picks**

In `apps/macos/cubelite/cubelite/Views/MainView.swift`, replace the `onSelectNamespace` closure (lines 188-192):

```swift
                onSelectNamespace: { namespace in
                    if let context = selectedContext {
                        appSettings.rememberNamespace(namespace, for: context)
                        sidebarSelection = SidebarSelection(context: context, namespace: namespace)
                    }
                },
```

- [ ] **Step 2: Restore the remembered namespace on context change**

In the same file, replace the `if let context = newValue { ... }` block inside `.onChange(of: selectedContext)` (lines 286-295):

```swift
            if let context = newValue {
                // Restore the last namespace the user picked for this context
                // immediately so the dashboard never sits on an empty
                // selection; fall back to the kubeconfig default namespace.
                let recalled = appSettings.recallNamespace(for: context)
                switch recalled {
                case .all:
                    sidebarSelection = SidebarSelection(context: context, namespace: nil)
                case .named(let ns):
                    sidebarSelection = SidebarSelection(context: context, namespace: ns)
                case .none:
                    break
                }
                Task {
                    await loadNamespaces(for: context)
                    if recalled == .none {
                        // Use the kubeconfig default namespace for this context, if set.
                        // This avoids cluster-scope requests that fail with 403 when RBAC
                        // only grants namespace-scoped access.
                        let defaultNS = await resolveDefaultNamespace(for: context)
                        sidebarSelection = SidebarSelection(context: context, namespace: defaultNS)
                    }
                }
            }
```

(The `sidebarSelection = nil` reset earlier in the handler stays: it still covers the `newValue == nil` case, and for non-nil contexts the selection is re-established immediately by the code above.)

- [ ] **Step 3: Build**

```
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
```

Expected: `** TEST BUILD SUCCEEDED **`.

- [ ] **Step 4: Run the existing state tests (regression gate)**

```
xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -only-testing cubeliteTests/MainViewStateTests -only-testing cubeliteTests/AppSettingsNamespaceMemoryTests
```

Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 5: Commit**

```bash
git add apps/macos/cubelite/cubelite/Views/MainView.swift
git commit -m "fix(macos): restore last namespace on cluster switch — no more empty dashboard (#314)

Resources were only fetched via onChange(of: sidebarSelection); until the
async default-namespace resolution landed, the selection stayed nil and
the detail area showed the welcome placeholder. Restore the remembered
namespace synchronously and only fall back to kubeconfig resolution when
no record exists.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Close button for detail panels + Describe no longer tears down the panel

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Views/ResourceDetailView.swift` (close button in header, `runAction` notify flag)
- Modify: `apps/macos/cubelite/cubelite/Views/DeploymentDetailView.swift` (close button)
- Modify: `apps/macos/cubelite/cubelite/Views/MainView+DetailArea.swift:146-170` (wire `onClose`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ResourceDetailView.onClose: (() -> Void)?` — new optional property, after `onPodMutated`.
  - `DeploymentDetailView.onClose: (() -> Void)?` — new optional property, after `context`.
  - `ResourceDetailView.runAction(notifyMutation: Bool = true, _:)` — existing private helper gains a leading flag.

- [ ] **Step 1: Add `onClose` and the close button to ResourceDetailView**

In `apps/macos/cubelite/cubelite/Views/ResourceDetailView.swift`, after the `onPodMutated` property (line 27), add:

```swift
    /// Invoked when the user dismisses the panel with the close button.
    var onClose: (() -> Void)?
```

In `header` (line 253), after `Spacer()` (line 267), add:

```swift
            if let onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(DesignTokens.textTertiary)
                }
                .buttonStyle(.plain)
                .help("Close details")
                .accessibilityLabel("Close details")
            }
```

- [ ] **Step 2: Stop Describe from notifying a mutation**

In the same file, change `runAction` (line 235) to:

```swift
    /// Runs an operation with the shared spinner/error handling.
    /// `notifyMutation` reloads the parent on success — read-only actions
    /// (Describe) must pass `false` or the reload deselects the pod and
    /// tears down this panel before its sheet can present.
    private func runAction(
        notifyMutation: Bool = true,
        _ operation: @escaping (KubeAPIService, String?) async throws -> Void
    ) {
        guard let service = kubeAPIService else { return }
        isActing = true
        Task {
            defer { isActing = false }
            do {
                try await operation(service, context)
                if notifyMutation { onPodMutated?() }
            } catch {
                actionError = error.localizedDescription
            }
        }
    }
```

And change the Describe button's action (line 128) to pass the flag:

```swift
                Button {
                    runAction(notifyMutation: false) { service, ctx in
                        let text = try await service.podManifestJSON(
                            namespace: pod.namespace, name: pod.name, inContext: ctx)
                        manifestItem = ManifestItem(text: text)
                    }
                } label: {
                    Label("Describe", systemImage: "doc.text.magnifyingglass")
                }
```

Restart (line 138), Delete (line 63), and the manifest-apply path keep the default `notifyMutation: true`.

- [ ] **Step 3: Add `onClose` to DeploymentDetailView**

In `apps/macos/cubelite/cubelite/Views/DeploymentDetailView.swift`, after the `context` property (line 16), add:

```swift
    /// Invoked when the user dismisses the panel with the close button.
    var onClose: (() -> Void)?
```

Wrap the header (line 29) with a top-trailing overlay:

```swift
                DeploymentDetailHeader(deployment: deployment)
                    .overlay(alignment: .topTrailing) {
                        if let onClose {
                            Button(action: onClose) {
                                Image(systemName: "xmark")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(DesignTokens.textTertiary)
                            }
                            .buttonStyle(.plain)
                            .help("Close details")
                            .accessibilityLabel("Close details")
                        }
                    }
```

- [ ] **Step 4: Wire onClose in MainView+DetailArea**

In `apps/macos/cubelite/cubelite/Views/MainView+DetailArea.swift`, `detailPanel(for:)` (line 146):

Deployment branch — add the argument after `context`:

```swift
            DeploymentDetailView(
                deployment: dep,
                kubeAPIService: kubeAPIService,
                context: sidebarSelection?.context ?? selectedContext,
                onClose: { selectedDeploymentID = nil }
            )
            .frame(minWidth: 320, idealWidth: 460, maxWidth: 600)
```

Pod branch — add the argument after `onPodMutated`:

```swift
            ResourceDetailView(
                resource: resource,
                kubeAPIService: kubeAPIService,
                portForwardService: portForwardService,
                context: sidebarSelection?.context ?? selectedContext,
                onPodMutated: {
                    selectedPodID = nil
                    if let sel = sidebarSelection {
                        Task { await loadResources(context: sel.context, namespace: sel.namespace) }
                    }
                },
                onClose: { selectedPodID = nil }
            )
            .frame(minWidth: 260, idealWidth: 340, maxWidth: 420)
```

- [ ] **Step 5: Build and run detail-view tests**

```
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -only-testing cubeliteTests/DeploymentDetailTests
```

Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 6: Commit**

```bash
git add apps/macos/cubelite/cubelite/Views/ResourceDetailView.swift apps/macos/cubelite/cubelite/Views/DeploymentDetailView.swift apps/macos/cubelite/cubelite/Views/MainView+DetailArea.swift
git commit -m "fix(macos): closable detail panels; Describe no longer dismisses the panel (#314)

runAction unconditionally fired onPodMutated, so Describe (a read-only
fetch) deselected the pod and unmounted the panel before the manifest
sheet could present.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Port-forward input validation + verbatim port rendering

**Files:**
- Create: `apps/macos/cubelite/cubelite/Models/PortForwardInput.swift`
- Modify: `apps/macos/cubelite/cubelite/Views/ResourceDetailView.swift:174-215` (`portForwardSection`)
- Test: `apps/macos/cubelite/cubeliteTests/PortForwardInputTests.swift` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `enum PortForwardInput` with
    - `static func parsePort(_ text: String) -> Int?` — trimmed, integer, 1–65535, else nil.
    - `static func resolveLocalPort(_ text: String, remotePort: Int) -> UInt16?` — empty mirrors `remotePort`; otherwise `parsePort` then `UInt16`.

- [ ] **Step 1: Write the failing tests**

Create `apps/macos/cubelite/cubeliteTests/PortForwardInputTests.swift`:

```swift
import XCTest

@testable import cubelite

// MARK: - PortForwardInputTests

/// Tests the pure parsing/validation helpers behind the port-forward fields.
final class PortForwardInputTests: XCTestCase {

    // MARK: - parsePort

    func testParsePort_validPort_parses() {
        XCTAssertEqual(PortForwardInput.parsePort("6789"), 6789)
    }

    func testParsePort_trimsWhitespace() {
        XCTAssertEqual(PortForwardInput.parsePort(" 80 "), 80)
    }

    func testParsePort_bounds() {
        XCTAssertEqual(PortForwardInput.parsePort("1"), 1)
        XCTAssertEqual(PortForwardInput.parsePort("65535"), 65535)
        XCTAssertNil(PortForwardInput.parsePort("0"))
        XCTAssertNil(PortForwardInput.parsePort("65536"))
    }

    func testParsePort_rejectsNonNumeric() {
        XCTAssertNil(PortForwardInput.parsePort(""))
        XCTAssertNil(PortForwardInput.parsePort("http"))
        XCTAssertNil(PortForwardInput.parsePort("6.789"))
        XCTAssertNil(PortForwardInput.parsePort("-80"))
    }

    // MARK: - resolveLocalPort

    func testResolveLocalPort_empty_mirrorsRemote() {
        XCTAssertEqual(PortForwardInput.resolveLocalPort("", remotePort: 6789), 6789)
    }

    func testResolveLocalPort_explicitValue_wins() {
        XCTAssertEqual(PortForwardInput.resolveLocalPort("9000", remotePort: 80), 9000)
    }

    func testResolveLocalPort_invalidText_isNil() {
        XCTAssertNil(PortForwardInput.resolveLocalPort("abc", remotePort: 80))
        XCTAssertNil(PortForwardInput.resolveLocalPort("0", remotePort: 80))
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
```

Expected: **build FAILS** — cannot find `PortForwardInput` in scope.

- [ ] **Step 3: Implement PortForwardInput**

Create `apps/macos/cubelite/cubelite/Models/PortForwardInput.swift`:

```swift
import Foundation

/// Pure parsing/validation for the port-forward input fields.
///
/// Kept UI-free so the rules are unit-testable: ports are integers in
/// 1–65535; the local field may be left empty to mirror the remote port.
enum PortForwardInput {

    /// Parses a user-entered port. Returns nil unless the trimmed text is
    /// an integer in 1...65535.
    static func parsePort(_ text: String) -> Int? {
        guard let value = Int(text.trimmingCharacters(in: .whitespaces)),
            (1...65535).contains(value)
        else { return nil }
        return value
    }

    /// Resolves the local port field: empty mirrors `remotePort`, anything
    /// else must itself be a valid port.
    static func resolveLocalPort(_ text: String, remotePort: Int) -> UInt16? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return UInt16(exactly: remotePort) }
        guard let value = parsePort(trimmed) else { return nil }
        return UInt16(exactly: value)
    }
}
```

- [ ] **Step 4: Build and run the new tests**

```
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -only-testing cubeliteTests/PortForwardInputTests
```

Expected: `** TEST SUCCEEDED **`, 7 tests pass.

- [ ] **Step 5: Use the helper in portForwardSection and render ports verbatim**

In `apps/macos/cubelite/cubelite/Views/ResourceDetailView.swift`, replace the `HStack(spacing: 6) { ... }` input row and session `ForEach` inside `portForwardSection(_:)` (lines 174-215) with:

```swift
                let remotePort = PortForwardInput.parsePort(forwardRemotePort)
                let localPort = remotePort.flatMap {
                    PortForwardInput.resolveLocalPort(forwardLocalPort, remotePort: $0)
                }
                HStack(spacing: 6) {
                    TextField("remote", text: $forwardRemotePort)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 60)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 9))
                        .foregroundStyle(DesignTokens.textTertiary)
                    TextField("local", text: $forwardLocalPort)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 60)
                    Button("Forward") {
                        guard let remote = remotePort, let local = localPort else { return }
                        do {
                            try service.start(
                                context: context, namespace: pod.namespace, pod: pod.name,
                                localPort: local, remotePort: remote)
                        } catch {
                            actionError = error.localizedDescription
                        }
                    }
                    .controlSize(.small)
                    .disabled(remotePort == nil || localPort == nil)
                }
                if remotePort == nil || localPort == nil {
                    Text("Ports must be numbers between 1 and 65535")
                        .font(.system(size: 10))
                        .foregroundStyle(DesignTokens.statusErr)
                }
                ForEach(service.sessions(namespace: pod.namespace, pod: pod.name)) { session in
                    HStack(spacing: 6) {
                        Circle()
                            .fill(sessionColor(session.state))
                            .frame(width: 6, height: 6)
                        Text(verbatim: "localhost:\(session.localPort) → \(session.remotePort)")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(DesignTokens.textSecondary)
                        if case .failed(let reason) = session.state {
                            Text(reason)
                                .font(.system(size: 10))
                                .foregroundStyle(DesignTokens.statusErr)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        Button("Stop") { service.stop(session) }
                            .controlSize(.mini)
                    }
                }
```

Key changes: `Text(verbatim:)` stops `LocalizedStringKey` locale grouping ("6.789"); the Forward button is disabled with an inline error while either port is invalid instead of silently defaulting to 80. Listener bind failures (port in use) already surface through `session.state == .failed` in the session row.

- [ ] **Step 6: Build and run the full macOS unit suite**

```
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -skip-testing cubeliteUITests
```

Expected: `** TEST SUCCEEDED **`, no regressions.

- [ ] **Step 7: Commit**

```bash
git add apps/macos/cubelite/cubelite/Models/PortForwardInput.swift apps/macos/cubelite/cubeliteTests/PortForwardInputTests.swift apps/macos/cubelite/cubelite/Views/ResourceDetailView.swift
git commit -m "fix(macos): validate port-forward input; render ports verbatim (#314)

Interpolating Int into LocalizedStringKey applied locale digit grouping,
showing port 6789 as \"6.789\" in an Italian locale. Invalid ports now
disable Forward with an inline error instead of silently defaulting.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Verification and PR

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Full suite once more on the final tree**

```
xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build
xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -skip-testing cubeliteUITests
```

Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 2: Confirm pre-existing files stayed untouched**

```bash
git status --short
```

Expected: only ` M apps/macos/cubelite/cubelite/Info.plist`, ` M .../Services/KubeAPIService.swift`, and `?? default.profraw` remain — none of them staged or committed on this branch (`git log --stat main..HEAD` must not mention them).

- [ ] **Step 3: Push and open PR (gh account `massilp`)**

```bash
git push -u origin fix/macos-quickfix-batch-314
gh pr create --title "fix(macos): quick-fix batch — namespace memory, closable panels, Describe, port formatting (#314)" --body "$(cat <<'EOF'
Closes #314.

## Changes
- **Namespace memory**: last-selected namespace persisted per context (`AppSettings.lastNamespaces`) and restored synchronously on cluster switch — the dashboard no longer sits empty until a namespace is picked. Falls back to the kubeconfig default namespace when no record exists.
- **Closable detail panels**: pod and deployment detail panels gain an xmark close button.
- **Describe fix**: `runAction` no longer fires `onPodMutated` for read-only actions, so Describe presents its manifest sheet instead of tearing down the panel.
- **Port-forward input**: ports render with `Text(verbatim:)` (no more "6.789" locale grouping); input validated to 1–65535 with inline error and disabled Forward button.

## Tests
- New: `AppSettingsNamespaceMemoryTests` (5), `PortForwardInputTests` (7).
- Full macOS unit suite green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.
