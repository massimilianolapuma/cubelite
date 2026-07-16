# Pod Log Viewer — PR A (Service Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the macOS service layer so the upcoming log panel can stream any container's logs (incl. init/sidecar, previous instance) with a configurable tail, backed by a pure, unit-tested query builder.

**Architecture:** A pure `PodLogQuery` value type builds the `/log` API path (single source of truth — Sonar duplication gate). `KubeAPIService.streamPodLogs` gains `container`/`tailLines` params on top of it; a new `fetchPreviousPodLogs` does a static (non-follow) fetch; a new `fetchPodContainers` GETs the pod and maps spec+status to a UI-ready `ContainerInfo` list.

**Tech Stack:** Swift 6, SwiftUI app target `cubelite`, XCTest target `cubeliteTests` (pattern: plain `XCTestCase` classes, one behavior per test, names `testSubject_condition_outcome`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-pod-log-viewer-design.md`
- `timestamps=true` is ALWAYS sent on the wire; the timestamps toggle is render-only.
- Default tail = 500 (spec); existing callers must keep compiling (default params).
- Do not duplicate `openLineStream` (Sonar duplication gate).
- Build/test command (same as CI, run from `apps/macos/cubelite`):
  `xcodebuild test -project cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -configuration Debug -skip-testing:cubeliteUITests CODE_SIGN_IDENTITY="-" CODE_SIGNING_ALLOWED=NO`
- New Swift files must be added to the Xcode project (project uses explicit `project.pbxproj` entries — verify the build picks them up; if the target uses file-system-synchronized groups, no pbxproj edit is needed).

---

### Task 1: `PodLogQuery` — pure log-path builder

**Files:**
- Create: `apps/macos/cubelite/cubelite/Models/PodLogQuery.swift`
- Test: `apps/macos/cubelite/cubeliteTests/PodLogQueryTests.swift`

**Interfaces:**
- Produces: `struct PodLogQuery { init(namespace:pod:container:follow:previous:tailLines:sinceTime:); var path: String }` — consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest

@testable import cubelite

final class PodLogQueryTests: XCTestCase {

    func testPath_defaults_followsWithTimestampsAndTail500() {
        let query = PodLogQuery(namespace: "default", pod: "web-1")
        XCTAssertEqual(
            query.path,
            "/api/v1/namespaces/default/pods/web-1/log"
                + "?follow=true&timestamps=true&tailLines=500")
    }

    func testPath_container_addsEncodedContainerParam() {
        let query = PodLogQuery(namespace: "default", pod: "web-1", container: "istio proxy")
        XCTAssertTrue(query.path.contains("&container=istio%20proxy"))
    }

    func testPath_previous_disablesFollowAndAddsPrevious() {
        let query = PodLogQuery(
            namespace: "default", pod: "web-1", container: "worker", previous: true)
        XCTAssertFalse(query.path.contains("follow=true"))
        XCTAssertTrue(query.path.contains("previous=true"))
        XCTAssertTrue(query.path.contains("timestamps=true"))
    }

    func testPath_noFollow_omitsFollowParam() {
        let query = PodLogQuery(namespace: "default", pod: "web-1", follow: false)
        XCTAssertFalse(query.path.contains("follow"))
    }

    func testPath_customTail_usesGivenValue() {
        let query = PodLogQuery(namespace: "default", pod: "web-1", tailLines: 5000)
        XCTAssertTrue(query.path.contains("tailLines=5000"))
    }

    func testPath_sinceTime_addsEncodedTimestamp() {
        let query = PodLogQuery(
            namespace: "default", pod: "web-1", sinceTime: "2026-07-15T10:00:00Z")
        XCTAssertTrue(query.path.contains("sinceTime=2026-07-15T10%3A00%3A00Z"))
    }

    func testPath_namespaceAndPod_arePercentEncoded() {
        let query = PodLogQuery(namespace: "team a", pod: "web 1")
        XCTAssertTrue(query.path.hasPrefix("/api/v1/namespaces/team%20a/pods/web%201/log?"))
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `apps/macos/cubelite`): `xcodebuild test … -only-testing:cubeliteTests/PodLogQueryTests`
Expected: build FAILURE — `cannot find 'PodLogQuery' in scope`.

- [ ] **Step 3: Write minimal implementation**

```swift
import Foundation

/// Builds the Kubernetes `/log` subresource path for a pod.
///
/// Single source of truth for log-query parameters, shared by the live
/// follow stream and the static previous-instance fetch. `timestamps=true`
/// is always sent; hiding timestamps is a render-time concern.
struct PodLogQuery: Equatable, Sendable {

    let namespace: String
    let pod: String
    var container: String?
    var follow: Bool
    var previous: Bool
    var tailLines: Int
    var sinceTime: String?

    init(
        namespace: String,
        pod: String,
        container: String? = nil,
        follow: Bool = true,
        previous: Bool = false,
        tailLines: Int = 500,
        sinceTime: String? = nil
    ) {
        self.namespace = namespace
        self.pod = pod
        self.container = container
        self.follow = follow
        // Previous-instance logs are terminated output: never follow them.
        self.previous = previous
        self.follow = previous ? false : follow
        self.tailLines = tailLines
        self.sinceTime = sinceTime
    }

    /// API path with query string, percent-encoded.
    var path: String {
        var items: [String] = []
        if follow { items.append("follow=true") }
        if previous { items.append("previous=true") }
        items.append("timestamps=true")
        items.append("tailLines=\(tailLines)")
        if let container {
            items.append("container=\(Self.encode(container))")
        }
        if let sinceTime {
            items.append("sinceTime=\(Self.encode(sinceTime))")
        }
        return "/api/v1/namespaces/\(Self.encode(namespace))/pods/\(Self.encode(pod))/log"
            + "?" + items.joined(separator: "&")
    }

    private static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-._~")))
            ?? value
    }
}
```

Note the parameter order in `path`: `follow`, `previous`, `timestamps`, `tailLines`, `container`, `sinceTime` — the first test asserts the exact default string `?follow=true&timestamps=true&tailLines=500`.

- [ ] **Step 4: Run tests to verify they pass**

Run: same `-only-testing:cubeliteTests/PodLogQueryTests`
Expected: `Test Suite 'PodLogQueryTests' passed` (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/macos/cubelite/cubelite/Models/PodLogQuery.swift \
        apps/macos/cubelite/cubeliteTests/PodLogQueryTests.swift
git commit -m "feat(macos): PodLogQuery — pure builder for pod /log paths"
```

---

### Task 2: Container models — `ContainerInfo` + K8s raw-struct extensions

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Models/ResourceModels.swift` (structs `K8sPodSpec`, `K8sContainer`, `K8sContainerStatus`, around lines 434–443)
- Create: `apps/macos/cubelite/cubelite/Models/ContainerInfo.swift`
- Test: `apps/macos/cubelite/cubeliteTests/ContainerInfoTests.swift`

**Interfaces:**
- Produces: `struct ContainerInfo { let name: String; let isInit: Bool; let isSidecar: Bool; let restarts: Int; let ready: Bool; let state: State; let lastTerminatedReason: String?; let lastTerminatedAt: String?; enum State: Equatable { case running, waiting(reason: String?), terminated(reason: String?) } }` and `K8sPod.toContainerInfos() -> [ContainerInfo]` — consumed by Task 3's `fetchPodContainers` and by PR B's picker UI.

- [ ] **Step 1: Extend the raw K8s structs (decode-only, additive)**

In `ResourceModels.swift`, replace the three structs:

```swift
/// Container status within a pod.
struct K8sContainerStatus: Codable, Sendable {
    let name: String?
    let ready: Bool?
    let restartCount: Int?
    let state: K8sContainerState?
    let lastState: K8sContainerState?

    init(
        name: String? = nil,
        ready: Bool? = nil,
        restartCount: Int? = nil,
        state: K8sContainerState? = nil,
        lastState: K8sContainerState? = nil
    ) {
        self.name = name
        self.ready = ready
        self.restartCount = restartCount
        self.state = state
        self.lastState = lastState
    }
}

/// One of the three mutually exclusive container-state branches.
struct K8sContainerState: Codable, Sendable {
    let running: K8sContainerStateRunning?
    let waiting: K8sContainerStateWaiting?
    let terminated: K8sContainerStateTerminated?

    init(
        running: K8sContainerStateRunning? = nil,
        waiting: K8sContainerStateWaiting? = nil,
        terminated: K8sContainerStateTerminated? = nil
    ) {
        self.running = running
        self.waiting = waiting
        self.terminated = terminated
    }
}

/// `state.running` details.
struct K8sContainerStateRunning: Codable, Sendable {
    let startedAt: String?
    init(startedAt: String? = nil) { self.startedAt = startedAt }
}

/// `state.waiting` details (e.g. `CrashLoopBackOff`).
struct K8sContainerStateWaiting: Codable, Sendable {
    let reason: String?
    init(reason: String? = nil) { self.reason = reason }
}

/// `state.terminated` details (e.g. `OOMKilled`, `Completed`).
struct K8sContainerStateTerminated: Codable, Sendable {
    let reason: String?
    let finishedAt: String?
    init(reason: String? = nil, finishedAt: String? = nil) {
        self.reason = reason
        self.finishedAt = finishedAt
    }
}

/// Pod spec from the Kubernetes API.
struct K8sPodSpec: Codable, Sendable {
    let nodeName: String?
    let containers: [K8sContainer]?
    let initContainers: [K8sContainer]?

    init(
        nodeName: String? = nil,
        containers: [K8sContainer]? = nil,
        initContainers: [K8sContainer]? = nil
    ) {
        self.nodeName = nodeName
        self.containers = containers
        self.initContainers = initContainers
    }
}

/// Container definition within a pod spec.
struct K8sContainer: Codable, Sendable {
    let name: String?
    /// `Always` on an init container marks a native sidecar (K8s ≥ 1.28).
    let restartPolicy: String?
    let resources: K8sResourceRequirements?

    init(
        name: String? = nil,
        restartPolicy: String? = nil,
        resources: K8sResourceRequirements? = nil
    ) {
        self.name = name
        self.restartPolicy = restartPolicy
        self.resources = resources
    }
}
```

If the existing structs have no explicit `init` today, add them as shown — other tests construct these values. Check existing call sites of `K8sPodSpec(...)`/`K8sContainer(...)` initializers still compile (labels unchanged, new params defaulted).

- [ ] **Step 2: Write the failing tests**

```swift
import XCTest

@testable import cubelite

final class ContainerInfoTests: XCTestCase {

    /// Pod with an app container, a native sidecar init container, and a
    /// plain init container — mirroring the design-handoff example pod.
    private func makePod() -> K8sPod {
        K8sPod(
            metadata: K8sObjectMeta(name: "web-1", namespace: "default"),
            spec: K8sPodSpec(
                containers: [K8sContainer(name: "worker")],
                initContainers: [
                    K8sContainer(name: "envoy", restartPolicy: "Always"),
                    K8sContainer(name: "init-migrate"),
                ]
            ),
            status: K8sPodStatus(
                containerStatuses: [
                    K8sContainerStatus(
                        name: "worker",
                        ready: false,
                        restartCount: 7,
                        state: K8sContainerState(
                            waiting: K8sContainerStateWaiting(reason: "CrashLoopBackOff")),
                        lastState: K8sContainerState(
                            terminated: K8sContainerStateTerminated(
                                reason: "OOMKilled", finishedAt: "2026-07-15T10:00:00Z"))
                    )
                ],
                initContainerStatuses: [
                    K8sContainerStatus(
                        name: "envoy", ready: true, restartCount: 0,
                        state: K8sContainerState(
                            running: K8sContainerStateRunning(startedAt: "2026-07-15T09:00:00Z"))),
                    K8sContainerStatus(
                        name: "init-migrate", ready: false, restartCount: 0,
                        state: K8sContainerState(
                            terminated: K8sContainerStateTerminated(reason: "Completed"))),
                ]
            )
        )
    }

    func testToContainerInfos_ordersAppThenSidecarThenInit() {
        let infos = makePod().toContainerInfos()
        XCTAssertEqual(infos.map(\.name), ["worker", "envoy", "init-migrate"])
    }

    func testToContainerInfos_sidecarDetection_initWithRestartPolicyAlways() {
        let infos = makePod().toContainerInfos()
        let envoy = infos.first { $0.name == "envoy" }
        XCTAssertEqual(envoy?.isSidecar, true)
        XCTAssertEqual(envoy?.isInit, false)
        let initMigrate = infos.first { $0.name == "init-migrate" }
        XCTAssertEqual(initMigrate?.isSidecar, false)
        XCTAssertEqual(initMigrate?.isInit, true)
    }

    func testToContainerInfos_mapsStatusRestartsAndState() {
        let worker = makePod().toContainerInfos().first { $0.name == "worker" }
        XCTAssertEqual(worker?.restarts, 7)
        XCTAssertEqual(worker?.state, .waiting(reason: "CrashLoopBackOff"))
        XCTAssertEqual(worker?.lastTerminatedReason, "OOMKilled")
        XCTAssertEqual(worker?.lastTerminatedAt, "2026-07-15T10:00:00Z")
    }

    func testToContainerInfos_missingStatus_defaultsToWaitingZeroRestarts() {
        let pod = K8sPod(
            metadata: K8sObjectMeta(name: "p", namespace: "ns"),
            spec: K8sPodSpec(containers: [K8sContainer(name: "app")]))
        let infos = pod.toContainerInfos()
        XCTAssertEqual(infos.count, 1)
        XCTAssertEqual(infos[0].restarts, 0)
        XCTAssertEqual(infos[0].state, .waiting(reason: nil))
        XCTAssertEqual(infos[0].ready, false)
    }
}
```

`K8sPodStatus` needs an `initContainerStatuses` field for the envoy/init rows — add it alongside `containerStatuses` (same optional pattern, defaulted `init` param). Check `K8sObjectMeta`'s memberwise availability; if its labels differ, adapt the fixture only (not the production mapping).

- [ ] **Step 3: Run tests to verify they fail**

Run: `xcodebuild test … -only-testing:cubeliteTests/ContainerInfoTests`
Expected: build FAILURE — `value of type 'K8sPod' has no member 'toContainerInfos'`.

- [ ] **Step 4: Write the implementation**

`apps/macos/cubelite/cubelite/Models/ContainerInfo.swift`:

```swift
import Foundation

/// UI-ready summary of one container in a pod, for the log-panel picker.
///
/// Ordering contract: app containers first (spec order), then native
/// sidecars (init containers with `restartPolicy: Always`), then plain
/// init containers.
struct ContainerInfo: Equatable, Sendable, Identifiable {
    var id: String { name }

    let name: String
    /// Plain init container (runs to completion before the pod starts).
    let isInit: Bool
    /// Native sidecar: declared under `initContainers` with `restartPolicy: Always`.
    let isSidecar: Bool
    let restarts: Int
    let ready: Bool
    let state: State
    /// Reason of the last terminated instance (e.g. `OOMKilled`), for the
    /// previous-logs affordance.
    let lastTerminatedReason: String?
    let lastTerminatedAt: String?

    enum State: Equatable, Sendable {
        case running
        case waiting(reason: String?)
        case terminated(reason: String?)
    }
}

extension K8sPod {

    /// Maps spec + status to picker-ready ``ContainerInfo`` rows.
    func toContainerInfos() -> [ContainerInfo] {
        let statuses = (status?.containerStatuses ?? []) + (status?.initContainerStatuses ?? [])
        let statusByName = Dictionary(
            statuses.compactMap { s in s.name.map { ($0, s) } },
            uniquingKeysWith: { first, _ in first })

        func info(for container: K8sContainer, isInit: Bool) -> ContainerInfo? {
            guard let name = container.name else { return nil }
            let isSidecar = isInit && container.restartPolicy == "Always"
            let status = statusByName[name]
            return ContainerInfo(
                name: name,
                isInit: isInit && !isSidecar,
                isSidecar: isSidecar,
                restarts: status?.restartCount ?? 0,
                ready: status?.ready ?? false,
                state: Self.state(from: status?.state),
                lastTerminatedReason: status?.lastState?.terminated?.reason,
                lastTerminatedAt: status?.lastState?.terminated?.finishedAt)
        }

        let app = (spec?.containers ?? []).compactMap { info(for: $0, isInit: false) }
        let fromInit = (spec?.initContainers ?? []).compactMap { info(for: $0, isInit: true) }
        let sidecars = fromInit.filter(\.isSidecar)
        let plainInit = fromInit.filter { !$0.isSidecar }
        return app + sidecars + plainInit
    }

    private static func state(from raw: K8sContainerState?) -> ContainerInfo.State {
        if raw?.running != nil { return .running }
        if let terminated = raw?.terminated { return .terminated(reason: terminated.reason) }
        return .waiting(reason: raw?.waiting?.reason)
    }
}
```

- [ ] **Step 5: Run the full unit suite (not only the new class)**

Run: `xcodebuild test … -skip-testing:cubeliteUITests`
Expected: PASS — proves the `ResourceModels.swift` edits didn't break existing decode tests.

- [ ] **Step 6: Commit**

```bash
git add apps/macos/cubelite/cubelite/Models/ResourceModels.swift \
        apps/macos/cubelite/cubelite/Models/ContainerInfo.swift \
        apps/macos/cubelite/cubeliteTests/ContainerInfoTests.swift
git commit -m "feat(macos): ContainerInfo model — containers incl. init/sidecar with state"
```

---

### Task 3: `KubeAPIService` — container-aware streaming, previous fetch, `fetchPodContainers`

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Services/KubeAPIService.swift` (`streamPodLogs`, lines ~574–587)
- Modify: `apps/macos/cubelite/cubelite/Views/PodLogsView.swift:147-148` (call site keeps compiling — verify only)
- Test: `apps/macos/cubelite/cubeliteTests/PodLogQueryTests.swift` (extend with the service-facing default checks if pure; the service methods themselves are network-bound and covered by E2E)

**Interfaces:**
- Consumes: `PodLogQuery` (Task 1), `K8sPod.toContainerInfos()` (Task 2).
- Produces (for PR B):
  - `func streamPodLogs(namespace:pod:container:tailLines:sinceTime:inContext:) async throws -> AsyncThrowingStream<String, Error>` (all new params defaulted)
  - `func fetchPreviousPodLogs(namespace:pod:container:tailLines:inContext:) async throws -> [String]`
  - `func fetchPodContainers(namespace:pod:inContext:) async throws -> [ContainerInfo]`

- [ ] **Step 1: Rewrite the log-streaming section**

Replace the current `streamPodLogs` with:

```swift
    /// Follows a pod's log as an async stream of raw lines
    /// (`tailLines` history first, then live lines until cancelled).
    func streamPodLogs(
        namespace: String,
        pod: String,
        container: String? = nil,
        tailLines: Int = 500,
        sinceTime: String? = nil,
        inContext contextName: String? = nil
    ) async throws -> AsyncThrowingStream<String, Error> {
        let query = PodLogQuery(
            namespace: namespace, pod: pod, container: container,
            tailLines: tailLines, sinceTime: sinceTime)
        return try await openLineStream(
            path: query.path, failurePrefix: "Log stream failed", contextName: contextName)
    }

    /// Fetches the previous instance's logs (crash-looped container) as a
    /// bounded, non-following line array.
    func fetchPreviousPodLogs(
        namespace: String,
        pod: String,
        container: String? = nil,
        tailLines: Int = 500,
        inContext contextName: String? = nil
    ) async throws -> [String] {
        let query = PodLogQuery(
            namespace: namespace, pod: pod, container: container,
            previous: true, tailLines: tailLines)
        let stream = try await openLineStream(
            path: query.path, failurePrefix: "Previous logs fetch failed",
            contextName: contextName)
        var lines: [String] = []
        for try await line in stream { lines.append(line) }
        return lines
    }

    /// Lists a pod's containers (app, sidecar, init) with live status.
    func fetchPodContainers(
        namespace: String,
        pod: String,
        inContext contextName: String? = nil
    ) async throws -> [ContainerInfo] {
        let encodedNS =
            namespace.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? namespace
        let encodedPod = pod.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? pod
        let raw: K8sPod = try await fetch(
            path: "/api/v1/namespaces/\(encodedNS)/pods/\(encodedPod)", contextName: contextName)
        return raw.toContainerInfos()
    }
```

Note the previous default `tailLines: Int = 100` becomes `500` (spec default). The only current caller (`PodLogsView.startStream`) passes no tail value.

- [ ] **Step 2: Build + full unit suite**

Run: `xcodebuild test … -skip-testing:cubeliteUITests`
Expected: PASS. `PodLogsView` compiles unchanged (labels `namespace:pod:inContext:` still valid).

- [ ] **Step 3: Commit**

```bash
git add apps/macos/cubelite/cubelite/Services/KubeAPIService.swift
git commit -m "feat(macos): container-aware log streaming, previous fetch, fetchPodContainers"
```

---

### Task 4: PR

- [ ] **Step 1: Push and open the stacked-base PR**

```bash
git push -u origin feat/294-pod-log-viewer
gh pr create --title "feat(macos): log service layer — container-aware streams, previous logs (#294 PR A)" \
  --body "First of the stacked PRs for #294 (spec: docs/superpowers/specs/2026-07-15-pod-log-viewer-design.md).

- \`PodLogQuery\`: pure builder for pod \`/log\` paths (follow/previous/tail/container/sinceTime), unit-tested
- \`ContainerInfo\` + \`K8sPod.toContainerInfos()\`: containers incl. native sidecars and init containers, state + restarts + last termination
- \`KubeAPIService\`: \`streamPodLogs\` gains \`container\`/\`tailLines\`/\`sinceTime\`; new \`fetchPreviousPodLogs\`, \`fetchPodContainers\`
- No UI changes; the existing sheet keeps working

Part of #294.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: PR URL. CI (`ci-macos`) must go green before stacking PR B on this branch.
