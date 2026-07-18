# macOS Overview Parity — Design

**Date:** 2026-07-18
**Issue:** [#315](https://github.com/massimilianolapuma/cubelite/issues/315)
**Branch:** `feat/macos-overview-parity-315` (stacked on `fix/macos-quickfix-batch-314`, PR #319)

## Context

Batch B of the desktop ↔ macOS parity effort. The native "Dashboard" diverges from desktop's "Overview": counts only, no capacity metrics, no warning events, and the All Clusters cards are less informative than desktop's. Native has no metrics-server client and no Events support at all.

## Scope

### 1. Rename Dashboard → Overview
- `ResourceType.dashboard` raw value `"Dashboard"` → `"Overview"` (raw value is the sidebar label; verified unused for persistence).
- `DashboardView.swift` → `OverviewView.swift`, struct `DashboardView` → `OverviewView`. `DashboardCard`/`DashboardMetric` keep their names (shared card primitives). `CrossClusterDashboardView` keeps its name.

### 2. Kubernetes quantity parsing
New `Models/K8sQuantity.swift`: pure parser for K8s resource quantities → `Double`.
- CPU: `"250m"` → 0.25 cores, `"2"` → 2.0.
- Memory: binary suffixes `Ki/Mi/Gi/Ti`, decimal `k/M/G/T`, bare bytes, and exponent forms (`123e6`) → bytes.
- Unparseable → nil. Fully unit-tested (this is the risky arithmetic of the batch).

### 3. Metrics + version + events API (KubeAPIService extensions)
Follows the existing `fetch`/DTO/`toXInfo()` pattern; no separate service actor (all cluster API calls live in `KubeAPIService`).
- `listNodeMetrics(inContext:)` → `GET /apis/metrics.k8s.io/v1beta1/nodes` → `[NodeMetricsInfo]` (name, cpuCores, memoryBytes — parsed via K8sQuantity). Metrics-server absent ⇒ throws (404/clientError); callers treat as "metrics unavailable".
- `clusterVersion(inContext:)` → `GET /version` → `gitVersion` string.
- `listWarningEvents(namespace:inContext:)` → `GET /api/v1/events?fieldSelector=type%3DWarning` (namespaced variant when a namespace is selected) → `[EventInfo]` (reason, message, objectKind, objectName, namespace, count, lastTimestamp), sorted most-recent first.
- `NodeInfo` gains `allocatableCPU`/`allocatableMemory` (parsed cores/bytes) from `status.allocatable` — needed for capacity denominators.
- Out of scope (YAGNI, follow-ups): per-pod metrics (pod drawer meters), a full Events list view.

### 4. Cluster capacity model
`Models/ClusterCapacity.swift`: `struct ClusterCapacity` with `cpuUsedCores`, `cpuAllocatableCores`, `memUsedBytes`, `memAllocatableBytes`, computed `cpuFraction`/`memFraction` (0...1, nil-safe on zero denominators), and a static builder `ClusterCapacity.from(nodes:metrics:)` summing allocatable vs usage. Unit-tested.

`ClusterState` additions: `nodeMetrics: [NodeMetricsInfo]`, `warningEvents: [EventInfo]`, `capacity: ClusterCapacity?` (nil = metrics unavailable).

`MainView+ResourceLoader.loadResources` additions (best-effort `try?`, never fail the load): node metrics + capacity computation, warning events for the current namespace scope.

### 5. Overview screen (parity with desktop `OverviewView.svelte`)
Layout top-to-bottom:
1. **Stat row** (4 `DashboardCard`s, compact): Nodes, Pods running/total, Deployments healthy/total, Warnings count (statusWarn tint when > 0).
2. **Capacity card**: CPU + MEM `MeterBarView`s from `clusterState.capacity`; "Metrics unavailable — metrics-server not detected" fallback when nil.
3. **Recent warnings card**: top 5 `warningEvents` (reason — object — message, age); "No recent warnings" empty state.
4. Existing resource-count cards grid (Pods, Deployments, Services, Namespaces, Secrets, ConfigMaps, Ingresses, Helm, Cluster health) unchanged below.

New `Views/Shell/MeterBarView.swift`: label + value text + horizontal fill bar (DesignTokens surfaces; fill statusOk < 70% < statusWarn < 90% < statusErr), built with plain shapes (no GeometryReader dependency beyond width fraction).

### 6. All Clusters cards (parity with desktop `AllClustersView.svelte`)
`ClusterHealthSnapshot` additions: `nodeCount: Int?`, `version: String?`, `warningCount: Int?`, `cpuFraction: Double?`, `memFraction: Double?` (all optional/best-effort).
Loader (`MainView+CrossClusterLoader`): per cluster, best-effort `try?` calls for `listNodes`, `listNodeMetrics`, `clusterVersion`, `listWarningEvents` (count only). Unreachable clusters skip these.
Card UI: keep status dot + context name; add a 4-stat grid Nodes / Pods / Version / Warnings and CPU+MEM `MeterBarView`s when fractions are available. Keep aggregate summary row.

## Error handling

All new data is decorative telemetry: every call is best-effort, failures degrade to "unavailable" UI, never to an error banner. RBAC-forbidden metrics/events are treated the same as absent metrics-server.

## Testing

- Unit: `K8sQuantityTests` (parser matrix), `ClusterCapacityTests` (aggregation, zero-denominator), event DTO mapping + sorting, node allocatable mapping.
- Existing suite must stay green (rename touches `ResourceType`).
- Manual: Overview on a metrics-server cluster and on one without; All Clusters with a mixed reachable/unreachable set.

## Non-goals

Per-pod metrics meters, full Events view, desktop-side changes (#316–#318), Sparkle/telemetry.
