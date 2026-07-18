# macOS Overview Parity Implementation Plan (#315)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the native macOS Overview (ex Dashboard) and All Clusters screens to parity with cubelite-desktop: capacity CPU/MEM meters, warning events, cluster version/node info.

**Architecture:** New pure helpers (`K8sQuantity`, `ClusterCapacity`) feed data fetched by three new `KubeAPIService` endpoints (metrics.k8s.io nodes, /version, Warning events). `ClusterState` carries the new per-cluster telemetry; `ClusterHealthSnapshot` carries the cross-cluster variant. A new `MeterBarView` renders fractions. All new fetches are best-effort (`try?`) — failures degrade to "unavailable" UI.

**Tech Stack:** Swift 5 / SwiftUI, XCTest.

## Global Constraints

- Branch `feat/macos-overview-parity-315`, stacked on `fix/macos-quickfix-batch-314`. Reference #315 in commits.
- NEVER stage `apps/macos/cubelite/cubelite/Info.plist` or `.../Services/KubeAPIService.swift`'s pre-existing #309 wiretap hunks... **correction:** Task 2 must edit `KubeAPIService.swift`, which contains pre-existing uncommitted #309 debug changes (a `tlsDebugLog` wiretap marked "TEMPORARY — remove before commit" and log lines). Commit ONLY the hunks belonging to this plan using `git add -p`-equivalent care: stage the file, then `git restore --staged` is NOT enough — instead, before Task 2, `git stash push -- apps/macos/cubelite/cubelite/Services/KubeAPIService.swift apps/macos/cubelite/cubelite/Info.plist` and `git stash pop` after the final commit of the branch. Document the stash in the task log.
- Build: `xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build`
- Test: `xcodebuild test-without-building ... -only-testing cubeliteTests/<Class>` (same flags as build; full suite adds `-skip-testing cubeliteUITests`).
- Test style: XCTest, house naming `test<Method>_<condition>_<expected>`.
- Commits: Conventional Commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: K8sQuantity parser

**Files:**
- Create: `apps/macos/cubelite/cubelite/Models/K8sQuantity.swift`
- Test: `apps/macos/cubelite/cubeliteTests/K8sQuantityTests.swift`

**Interfaces:**
- Produces: `enum K8sQuantity` — `static func cpuCores(_ text: String) -> Double?`, `static func bytes(_ text: String) -> Double?`.

- [ ] Step 1: failing tests — matrix: cpu `"250m"`→0.25, `"2"`→2, `"156340607n"`→~0.1563 (accuracy 1e-6), `"1500u"`→0.0015, garbage/nil; bytes `"1129164Ki"`, `"3Gi"`, `"512Mi"`, `"1500k"`, `"2G"`, `"12345"`, `"123e6"`, garbage/nil.
- [ ] Step 2: build fails (missing type).
- [ ] Step 3: implement:

```swift
import Foundation

/// Parses Kubernetes resource quantity strings (CPU cores and byte sizes).
///
/// Covers the forms the API actually emits: CPU as bare cores ("2"),
/// millicores ("250m"), microcores ("1500u"), nanocores from
/// metrics-server ("156340607n"); memory with binary (Ki/Mi/Gi/Ti/Pi/Ei)
/// or decimal (k/M/G/T/P/E) suffixes, bare bytes, and exponent notation.
enum K8sQuantity {

    static func cpuCores(_ text: String) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return nil }
        let scales: [Character: Double] = ["n": 1e-9, "u": 1e-6, "m": 1e-3]
        if let last = t.last, let scale = scales[last] {
            guard let value = Double(t.dropLast()) else { return nil }
            return value * scale
        }
        return Double(t)
    }

    static func bytes(_ text: String) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return nil }
        let binary: [String: Double] = [
            "Ki": 1024, "Mi": 1_048_576, "Gi": 1_073_741_824,
            "Ti": pow(1024, 4), "Pi": pow(1024, 5), "Ei": pow(1024, 6),
        ]
        for (suffix, multiplier) in binary where t.hasSuffix(suffix) {
            guard let value = Double(t.dropLast(2)) else { return nil }
            return value * multiplier
        }
        let decimal: [Character: Double] = [
            "k": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15, "E": 1e18,
        ]
        if let last = t.last, let multiplier = decimal[last] {
            guard let value = Double(t.dropLast()) else { return nil }
            return value * multiplier
        }
        return Double(t)
    }
}
```

- [ ] Step 4: tests pass. Step 5: commit `feat(macos): K8s resource quantity parser (#315)`.

---

### Task 2: Metrics, version, and warning-event endpoints

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Models/ResourceModels.swift` (DTOs + models + mappings; add `allocatable` to `K8sNodeStatus`, allocatable fields to `NodeInfo`)
- Modify: `apps/macos/cubelite/cubelite/Services/KubeAPIService.swift` (three methods; see Global Constraints re: stash)
- Test: `apps/macos/cubelite/cubeliteTests/MetricsAndEventsMappingTests.swift`

**Interfaces:**
- Produces:
  - `struct NodeMetricsInfo: Codable, Sendable, Identifiable { name: String; cpuCores: Double?; memoryBytes: Double? }`
  - `struct EventInfo: Codable, Sendable, Identifiable { name, namespace: String; reason, message, objectKind, objectName, lastTimestamp: String?; count: Int? }`
  - `NodeInfo.allocatableCPUCores: Double?`, `NodeInfo.allocatableMemoryBytes: Double?` (post-construction `var`s)
  - `KubeAPIService.listNodeMetrics(inContext:) async throws -> [NodeMetricsInfo]` (path `/apis/metrics.k8s.io/v1beta1/nodes`)
  - `KubeAPIService.clusterVersion(inContext:) async throws -> String?` (path `/version`, `gitVersion`)
  - `KubeAPIService.listWarningEvents(namespace:inContext:) async throws -> [EventInfo]` (path `/api/v1/events?fieldSelector=type%3DWarning`, namespaced variant, sorted lastTimestamp desc)

- [ ] Step 1: failing mapping tests (`K8sNodeMetrics.toNodeMetricsInfo` parses usage; `K8sEvent.toEventInfo` maps involvedObject; `K8sNode.toNodeInfo` fills allocatable; event sort helper most-recent-first).
- [ ] Step 2: DTOs mirror house style (`K8sNodeMetrics { metadata, usage {cpu, memory} }`, `K8sEvent { metadata, reason, message, type, count, lastTimestamp, involvedObject {kind, name} }`), mappings use `K8sQuantity`.
- [ ] Step 3: service methods follow `listNodes`/`listPods` shape (namespaced percent-encoding, `K8sListResponse`, `fetch`). Version uses a local `VersionInfo: Codable` struct.
- [ ] Step 4: build + new tests green. Step 5: commit `feat(macos): metrics.k8s.io, /version and Warning-events endpoints (#315)`.

---

### Task 3: ClusterCapacity + state + loader wiring

**Files:**
- Create: `apps/macos/cubelite/cubelite/Models/ClusterCapacity.swift`
- Modify: `apps/macos/cubelite/cubelite/Models/ClusterState.swift` (new properties)
- Modify: `apps/macos/cubelite/cubelite/Views/MainView+ResourceLoader.swift` (best-effort fetches)
- Modify: `apps/macos/cubelite/cubelite/Views/MainView.swift` (reset new state on selection change)
- Test: `apps/macos/cubelite/cubeliteTests/ClusterCapacityTests.swift`

**Interfaces:**
- Produces: `struct ClusterCapacity: Sendable, Equatable { cpuUsedCores, cpuAllocatableCores, memUsedBytes, memAllocatableBytes: Double; var cpuFraction: Double?; var memFraction: Double?; static func from(nodes: [NodeInfo], metrics: [NodeMetricsInfo]) -> ClusterCapacity? }` — `from` returns nil when `metrics` empty; fractions nil on zero denominator, clamped to 1.
- `ClusterState`: `nodeMetrics: [NodeMetricsInfo] = []`, `warningEvents: [EventInfo] = []`, `capacity: ClusterCapacity?`.
- Loader: after existing resource fetches — `nodeMetrics = (try? await ...listNodeMetrics(...)) ?? []`, `capacity = ClusterCapacity.from(nodes: clusterState.nodes, metrics: nodeMetrics)`, `warningEvents = (try? await ...listWarningEvents(namespace:...)) ?? []`.
- MainView `.onChange(of: sidebarSelection)` reset block also clears the three new properties.

- [ ] Step 1: failing `ClusterCapacityTests` (aggregation sums, nil on empty metrics, nil fraction on zero allocatable, clamp > 1).
- [ ] Step 2: implement + wire. Step 3: build + tests green. Step 4: commit `feat(macos): cluster capacity + warning events in resource loader (#315)`.

---

### Task 4: MeterBarView + Overview screen

**Files:**
- Create: `apps/macos/cubelite/cubelite/Views/Shell/MeterBarView.swift`
- Rename: `apps/macos/cubelite/cubelite/Views/DashboardView.swift` → `OverviewView.swift` (`git mv`), struct `DashboardView` → `OverviewView` (update `MainView+DetailArea.swift:31` call site and `#Preview`)
- Modify: `apps/macos/cubelite/cubelite/Models/ClusterState.swift:86` — `case dashboard = "Overview"`

**Interfaces:**
- Produces: `MeterBarView(label: String, fraction: Double?, detail: String? = nil)` — nil fraction renders "—" and no fill; fill color statusOk / statusWarn (≥0.7) / statusErr (≥0.9); 6pt capsule track on `surfaceSunken`.
- Overview layout: stat row (Nodes, Pods running, Deployments healthy, Warnings), Capacity card (CPU/MEM meters or "Metrics unavailable — metrics-server not detected"), Recent warnings card (top 5, reason + object + message + count), then the existing count-card grid.
- Formatting helpers (private in OverviewView): cores with 1 decimal, bytes → GiB with 1 decimal.

- [ ] Step 1: implement MeterBarView (ZStack in GeometryReader, `.frame(height: 6)`).
- [ ] Step 2: rename + relabel + new sections.
- [ ] Step 3: build + run `MainViewStateTests` (regression). Step 4: commit `feat(macos): Overview screen — capacity meters and recent warnings (#315)`.

---

### Task 5: All Clusters parity cards

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Models/CrossClusterState.swift` (`ClusterHealthSnapshot` + optional fields)
- Modify: `apps/macos/cubelite/cubelite/Views/MainView+CrossClusterLoader.swift` (best-effort extra calls)
- Modify: `apps/macos/cubelite/cubelite/Views/CrossClusterDashboardView.swift` (card grid + meters)

**Interfaces:**
- `ClusterHealthSnapshot` gains `nodeCount: Int?`, `version: String?`, `warningCount: Int?`, `cpuFraction: Double?`, `memFraction: Double?` (default nil so existing constructions compile — use default parameter values in the memberwise init if one is hand-written, otherwise update call sites).
- Loader per cluster (only when reachable): `try? listNodes`, `try? listNodeMetrics` (+ `ClusterCapacity.from`), `try? clusterVersion`, `try? listWarningEvents(namespace: nil)` count.
- Card: status dot + name row (keep), then 4-badge grid Nodes / Pods / Version / Warnings, then CPU+MEM `MeterBarView` when fractions non-nil.

- [ ] Step 1: extend snapshot + loader. Step 2: card UI. Step 3: build + `RBACResilienceTests` + cross-cluster tests if present. Step 4: commit `feat(macos): All Clusters cards — nodes, version, warnings, CPU/MEM meters (#315)`.

---

### Task 6: Verification + PR

- [ ] Full unit suite green (`-skip-testing cubeliteUITests`).
- [ ] `git log --stat main..HEAD` free of `Info.plist` / #309 wiretap hunks; stash popped back.
- [ ] Push; `gh pr create` (base `fix/macos-quickfix-batch-314`) titled `feat(macos): Overview parity — capacity metrics, warnings, All Clusters cards (#315)`, body closes #315, notes stacked-on-#319.
