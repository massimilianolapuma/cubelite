# Resource limits, delivery 1: read-only Resources — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each container's CPU and memory requests, limits and current usage in the Deployment and Pod detail panels. Nothing is written to the cluster.

**Architecture:** The core adds requests and limits (the cluster's text plus a numeric amount) to the pod and deployment payloads it already sends, and keeps the per-container usage that it sums away today. A pure TypeScript module turns containers and pod metrics into display rows; one small component renders the rows in both panels with the existing `ui/MeterBar`.

**Tech Stack:** Rust (`crates/cubelite-core`, `k8s-openapi` types, serde), Svelte 5 + TypeScript (`apps/desktop`), Vitest, Playwright against the Tauri mock.

**Spec:** `docs/superpowers/specs/2026-11-13-resource-limits-design.md` (§3.1, §7.1 first bullet, §8, §10.1). Issue #652, part of #650.

## Global Constraints

- Read-only delivery: no Adjust button, no editor, no override banner, no manager detection, no new Tauri command.
- `ui/MeterBar.svelte` is used as it is: thresholds high from 60%, critical from 75%. Do not change the component.
- Quantities are compared and computed as numbers, never as text. What is shown for a request or a limit is the cluster's own text.
- Every new field of a payload struct carries `#[serde(default)]`; the frontend must not break on a payload without it.
- No `unwrap()` or `expect()` outside tests in Rust.
- An unknown value is `EMPTY` from `lib/empty.ts`; no em dash in anything a user reads; colours and type from the Tonal tokens only; a state is never shown by colour alone.
- Copy, exact: `no request`, `no limit`, `Usage unavailable: metrics-server did not answer.`, section title `Resources`, word `sidecar`.
- Commits: Conventional Commits, body ends with `Refs #652`, no attribution lines. `scripts/gates.sh --rust` must exit 0 before the last commit.

## Review Focus

1. A quantity the parser cannot read (amount `null`): the text still shows, no meter, nothing throws. Test in Task 3 and Task 4.
2. Metrics name a container the spec does not have (an injected sidecar), or the spec has a container with no sample: no row for the first, `used` null for the second. Test in Task 3.
3. A payload without `resources` / `containers` (an older core, a test fixture): the Deployment section is not rendered, a pod container card shows no resource rows, nothing throws. Test in Task 3 and Task 4.
4. A limit whose amount is 0, and usage above the limit: percent is `null` for the first (never `Infinity` or `NaN`), 100 for the second. Test in Task 3.
5. A deployment with no pods while metrics-server answers: requests and limits show, no meter value, and the "Usage unavailable" sentence does **not** show (usage is not unavailable, there is nothing to measure). Test in Task 4.

---

### Task 1: Core — requests and limits in the pod and deployment payloads

**Files:**
- Modify: `crates/cubelite-core/src/metrics.rs` (`parse_memory_bytes`, tests)
- Modify: `crates/cubelite-core/src/resources.rs` (new structs, `ContainerInfo`, `DeploymentInfo`)
- Modify: `crates/cubelite-core/src/watcher.rs` (`pod_to_info`, `deployment_to_info`, tests)

**Interfaces:**
- Produces (Rust, all `#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]`, in `resources.rs`):

```rust
/// A Kubernetes quantity as the cluster writes it, with its amount:
/// millicores for CPU, bytes for memory. `amount` is None when `text` cannot be parsed.
pub struct QuantityInfo { pub text: String, pub amount: Option<f64> }
pub struct ResourcePairInfo { pub request: Option<QuantityInfo>, pub limit: Option<QuantityInfo> }
pub struct ContainerResourcesInfo { pub cpu: ResourcePairInfo, pub memory: ResourcePairInfo }
/// A container of a workload's pod template.
pub struct TemplateContainerInfo {
    pub name: String,
    pub image: Option<String>,
    /// Native sidecar: an init container with `restartPolicy: Always`.
    pub sidecar: bool,
    pub resources: ContainerResourcesInfo,
}
```

- `ContainerInfo` gains `#[serde(default)] pub resources: ContainerResourcesInfo`.
- `DeploymentInfo` gains `#[serde(default)] pub containers: Vec<TemplateContainerInfo>`: the template's regular containers in spec order, then its native sidecars. `images` stays as it is.
- In `watcher.rs`: `pub(crate) fn container_resources(c: &k8s_openapi::api::core::v1::Container) -> ContainerResourcesInfo`.

- [ ] **Step 1: Write the failing parser tests** in `metrics.rs` `mod tests`:

```rust
#[test]
fn parse_memory_bytes_full_grammar() {
    assert_eq!(parse_memory_bytes("1Pi"), Some(1_125_899_906_842_624));
    assert_eq!(parse_memory_bytes("1Ei"), Some(1_152_921_504_606_846_976));
    assert_eq!(parse_memory_bytes("1P"), Some(1_000_000_000_000_000));
    assert_eq!(parse_memory_bytes("1E"), Some(1_000_000_000_000_000_000));
    assert_eq!(parse_memory_bytes("1e3"), Some(1_000));
    assert_eq!(parse_memory_bytes("12E6"), Some(12_000_000));
    assert_eq!(parse_memory_bytes("128974848000m"), Some(128_974_848));
    assert_eq!(parse_memory_bytes("1.5Gi"), Some(1_610_612_736));
}

#[test]
fn parse_quantities_reject_what_is_not_a_quantity() {
    for bad in ["", " ", "abc", "-1Gi", "-5", "1Xi", "Gi"] {
        assert_eq!(parse_memory_bytes(bad), None, "{bad:?}");
    }
    for bad in ["", "abc", "-100m", "m"] {
        assert_eq!(parse_cpu_millis(bad), None, "{bad:?}");
    }
}
```

- [ ] **Step 2: Run** `cargo test -p cubelite-core parse_` — expected: both new tests FAIL (`1Pi` is `None`; `-1Gi` is `Some(0)`).

- [ ] **Step 3: Complete `parse_memory_bytes` and tighten `parse_cpu_millis`.** Signatures unchanged. Add `Pi`, `Ei`, `P`, `E` and the milli suffix `m` (amount / 1000); a trailing `E` is exa, an `e`/`E` followed by digits is an exponent; a negative or non-finite number is `None` in both parsers.

- [ ] **Step 4: Run** `cargo test -p cubelite-core parse_` — expected: PASS, including the tests that were already there.

- [ ] **Step 5: Write the failing mapping tests** in `watcher.rs` `mod tests`, next to `pod_to_info_full` and `deployment_to_info_enriched_fields`, building the objects with `serde_json::from_value` as the existing tests do:

```rust
#[test]
fn pod_to_info_carries_container_resources() {
    // container "api": requests cpu 250m, memory 256Mi; limits cpu 500m, memory 512Mi
    // container "envoy": requests cpu 100m only
    let info = pod_to_info(pod).unwrap();
    let api = &info.containers[0].resources;
    assert_eq!(api.cpu.request, Some(QuantityInfo { text: "250m".into(), amount: Some(250.0) }));
    assert_eq!(api.cpu.limit, Some(QuantityInfo { text: "500m".into(), amount: Some(500.0) }));
    assert_eq!(api.memory.limit, Some(QuantityInfo { text: "512Mi".into(), amount: Some(536_870_912.0) }));
    let envoy = &info.containers[1].resources;
    assert_eq!(envoy.cpu.request.as_ref().map(|q| q.amount), Some(Some(100.0)));
    assert_eq!(envoy.cpu.limit, None);
    assert_eq!(envoy.memory, ResourcePairInfo::default());
}

#[test]
fn deployment_to_info_lists_template_containers_and_native_sidecars() {
    // template: containers [api (limits memory 1Gi), worker (no resources)];
    // initContainers [migrate (no restartPolicy), mesh (restartPolicy Always, requests cpu 50m)]
    let info = deployment_to_info(deployment).unwrap();
    let names: Vec<_> = info.containers.iter().map(|c| (c.name.as_str(), c.sidecar)).collect();
    assert_eq!(names, vec![("api", false), ("worker", false), ("mesh", true)]);
    assert_eq!(info.containers[0].resources.memory.limit.as_ref().map(|q| q.amount), Some(Some(1_073_741_824.0)));
    assert_eq!(info.containers[1].resources, ContainerResourcesInfo::default());
    assert_eq!(info.images.len(), 2); // unchanged: regular containers only
}

#[test]
fn container_resources_keeps_the_text_of_a_quantity_it_cannot_parse() {
    // limits memory "1Xi"
    assert_eq!(r.memory.limit, Some(QuantityInfo { text: "1Xi".into(), amount: None }));
}
```

- [ ] **Step 6: Run** `cargo test -p cubelite-core watcher::` — expected: FAIL to compile (types and function missing).

- [ ] **Step 7: Add the structs, the two fields and `container_resources`; fill them in `pod_to_info` and `deployment_to_info`.** `container_resources` reads `c.resources.requests` / `.limits` keys `cpu` and `memory`; `text` is the quantity's string (`Quantity.0`), `amount` is `parse_cpu_millis` or `parse_memory_bytes(..) as f64`. Update every struct literal the compiler now reports (tests and fixtures build `ContainerInfo` and `DeploymentInfo` by hand).

- [ ] **Step 8: Run** `cargo test --workspace` — expected: PASS. An old payload still deserialises: add one assertion to an existing serde test (or a new one) that JSON without `resources` / `containers` yields the defaults.

- [ ] **Step 9: Commit** `feat(core): requests and limits of containers in the pod and deployment payloads`.

### Task 2: Core — per-container usage from metrics-server

**Files:**
- Modify: `crates/cubelite-core/src/metrics.rs` (`PodMetricsInfo`, `pod_metrics_from_item`, tests)

**Interfaces:**
- Produces:

```rust
/// CPU/memory usage of one container of a pod.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ContainerUsageInfo { pub name: String, pub cpu_millis: f64, pub memory_bytes: u64 }
```

- `PodMetricsInfo` gains `#[serde(default)] pub containers: Vec<ContainerUsageInfo>`, in the order metrics-server returns them. `cpu_millis` and `memory_bytes` of the pod stay the sums they are today.

- [ ] **Step 1: Write the failing test** in `metrics.rs` `mod tests`:

```rust
#[test]
fn pod_metrics_keep_each_container() {
    let item = serde_json::json!({
        "metadata": { "name": "api-0", "namespace": "default" },
        "containers": [
            { "name": "api", "usage": { "cpu": "412m", "memory": "498Mi" } },
            { "name": "envoy", "usage": { "cpu": "38000000n", "memory": "41Mi" } },
            { "name": "broken", "usage": {} }
        ]
    });
    let m = pod_metrics_from_item(&item).unwrap();
    assert_eq!(m.cpu_millis, 450.0);
    assert_eq!(m.memory_bytes, (498 + 41) * 1024 * 1024);
    assert_eq!(m.containers, vec![
        ContainerUsageInfo { name: "api".into(), cpu_millis: 412.0, memory_bytes: 498 * 1024 * 1024 },
        ContainerUsageInfo { name: "envoy".into(), cpu_millis: 38.0, memory_bytes: 41 * 1024 * 1024 },
        ContainerUsageInfo { name: "broken".into(), cpu_millis: 0.0, memory_bytes: 0 },
    ]);
}
```

- [ ] **Step 2: Run** `cargo test -p cubelite-core pod_metrics_keep` — expected: FAIL to compile.
- [ ] **Step 3: Add `ContainerUsageInfo` and the field; fill it in `pod_metrics_from_item`.** A container entry without a `name` is skipped.
- [ ] **Step 4: Run** `scripts/gates.sh --rust --no-e2e` — expected: exit 0.
- [ ] **Step 5: Commit** `feat(core): per-container usage in the pod metrics`.

### Task 3: Desktop — types and the rows model

**Files:**
- Modify: `apps/desktop/src/lib/tauri.ts` (types only)
- Create: `apps/desktop/src/lib/container-usage.ts`
- Test: `apps/desktop/src/lib/container-usage.test.ts`

**Interfaces:**
- Consumes: the payload shapes of Tasks 1 and 2.
- Produces, in `tauri.ts`:

```ts
export type QuantityInfo = { text: string; amount: number | null };
export type ResourcePairInfo = { request: QuantityInfo | null; limit: QuantityInfo | null };
export type ContainerResourcesInfo = { cpu: ResourcePairInfo; memory: ResourcePairInfo };
export type TemplateContainerInfo = { name: string; image: string | null; sidecar: boolean; resources: ContainerResourcesInfo };
export type ContainerUsageInfo = { name: string; cpu_millis: number; memory_bytes: number };
// ContainerInfo: + resources?: ContainerResourcesInfo
// DeploymentInfo: + containers?: TemplateContainerInfo[]
// PodMetricsInfo: + containers?: ContainerUsageInfo[]
```

- Produces, in `container-usage.ts`:

```ts
export type ResourceRow = {
  resource: "cpu" | "memory";
  /** "CPU" | "MEM", as the pod panel's meters are labelled today. */
  label: "CPU" | "MEM";
  /** 0–100 when a limit with an amount above 0 and a usage sample exist, else null. */
  percent: number | null;
  /** True when the container has a limit: the row is a meter (possibly empty). */
  meter: boolean;
  /** The sentence beside or under the meter, see the table below. */
  detail: string;
};
export type ContainerRows = { name: string; sidecar: boolean; rows: readonly [ResourceRow, ResourceRow] };

/** One pod: what its containers run with, and its metrics. */
export type PodUsage = {
  containers?: readonly { name: string; resources?: ContainerResourcesInfo }[];
  metrics: PodMetricsInfo | null;
};
/** Rows for each container that has a `resources` field; usage is the highest of the counted pods. */
export function containerRows(
  containers: readonly { name: string; sidecar?: boolean; resources?: ContainerResourcesInfo }[],
  pods: readonly PodUsage[],
): ContainerRows[];
```

A pod's sample counts for a container and a resource only when that pod's own container has the same limit for that resource as the template (compared by `amount`; both without a limit is the same). A pod without such a container, or whose container has no `resources`, does not count: a pod of the previous ReplicaSet, or of another workload the selector also matches, is measured against another limit (review of #652).

`detail`, exact (used values through `formatCpu` / `formatBytes` of `lib/units.ts`, request and limit as the cluster's `text`):

| limit | usage sample | detail |
|---|---|---|
| set | yes | `412m of 500m · request 250m` |
| set | no | `limit 500m · request 250m` |
| not set | yes | `38m used · request 100m · no limit` |
| not set | no | `request 100m · no limit` |

A request that is not set reads `no request` in place of `request …`.

- [ ] **Step 1: Write the failing tests** in `container-usage.test.ts` (helper `q(text, amount)` builds a `QuantityInfo`; `Mi = 1024 * 1024`):

```ts
it("gives a meter row with used of limit when a limit and a sample exist", () => {
  const [api] = containerRows(
    [{ name: "api", resources: { cpu: { request: q("250m", 250), limit: q("500m", 500) }, memory: { request: q("256Mi", 256 * Mi), limit: q("512Mi", 512 * Mi) } } }],
    [{ name: "api-0", namespace: "default", cpu_millis: 260, memory_bytes: 498 * Mi, containers: [{ name: "api", cpu_millis: 260, memory_bytes: 498 * Mi }] }],
  );
  expect(api.rows[0]).toEqual({ resource: "cpu", label: "CPU", percent: 52, meter: true, detail: "260m of 500m · request 250m" });
  expect(api.rows[1].percent).toBeCloseTo(97.27, 1);
  expect(api.rows[1].detail).toBe("498Mi of 512Mi · request 256Mi");
});
it("takes the highest pod per container and per resource", () => {
  // pod a: api cpu 100, mem 300Mi; pod b: api cpu 400, mem 200Mi → cpu 400, mem 300Mi
});
it("words a missing request, a missing limit and a missing sample", () => {
  // no limit + sample → meter false, percent null, "38m used · request 100m · no limit"
  // no limit, no request, no sample → "no request · no limit"
  // limit, no sample → meter true, percent null, "limit 500m · request 250m"
  // limit, no request, sample → "260m of 500m · no request"
});
it("has no percent for a limit of 0 or a limit it cannot read, and 100 above the limit", () => {
  // limit q("0", 0) + sample → percent null; limit q("1Xi", null) + sample → meter true, percent null, detail "498Mi of 1Xi · request 256Mi"
  // limit 500 + used 650 → percent 100
});
it("ignores metrics of a container the spec does not have, and null pods", () => {
  // podMetrics [null, { containers: [{ name: "istio-proxy", … }] }] → api rows have no sample; no row named istio-proxy
});
it("skips containers without a resources field and pod metrics without containers", () => {
  expect(containerRows([{ name: "old" }], [])).toEqual([]);
  // a PodMetricsInfo with no `containers` → treated as no sample
});
it("keeps the sidecar flag", () => { /* sidecar: true → ContainerRows.sidecar true; absent → false */ });
```

- [ ] **Step 2: Run** `pnpm --filter desktop test -- container-usage` — expected: FAIL, module not found.
- [ ] **Step 3: Add the types to `tauri.ts` and implement `containerRows`.** `percent` comes from `percentOf(used, limit.amount)` (it already returns `null` for a total of 0 and caps at 100).
- [ ] **Step 4: Run** `pnpm --filter desktop test -- container-usage` — expected: PASS; then `pnpm --filter desktop check` — expected: 0 errors.
- [ ] **Step 5: Commit** `feat(desktop): rows model for container requests, limits and usage`.

### Task 4: Desktop — the rows in both panels

**Files:**
- Create: `apps/desktop/src/lib/components/resources/ContainerResourceRows.svelte`
- Modify: `apps/desktop/src/lib/components/deployments/DeploymentDrawer.svelte` (new section between Replicas and `<FactRows>`)
- Modify: `apps/desktop/src/lib/components/pods/PodDrawer.svelte` (inside each container card, after the image line)
- Test: `apps/desktop/src/lib/components/panels.test.ts`

**Interfaces:**
- Consumes: `containerRows`, `ContainerRows`, `ResourceRow` (Task 3); `ui/MeterBar.svelte` (`label`, `percent`, `detail`); `resources.metricsFor(namespace, name)`, `resources.metricsAvailable`; `childPods` and `podsKnown` already derived in `DeploymentDrawer.svelte`.
- Produces: `ContainerResourceRows.svelte` with props `{ rows: readonly ResourceRow[] }`. A row with `meter` is `<MeterBar label percent detail />`; a row without is one line, the label in the same `type-label w-9` column and `detail` in `type-data-sm text-text-muted`, marked `data-resource-row={row.resource}` (the meter row carries the same attribute on a wrapper).

Layout decisions:
- **Deployment panel:** `<div data-section="resources">` with the `PANEL_SECTION` heading `Resources`, then one `PANEL_CARD` per container: the name (`type-data-sm text-text`, the word `sidecar` after it in `type-body-sm text-text-muted` for a native sidecar), then `ContainerResourceRows`. Rendered only when `containerRows(...)` is not empty. Usage: `childPods.map((p) => ({ containers: p.containers, metrics: resources.metricsFor(p.namespace, p.name) }))`.
- Under the cards, when `!resources.metricsAvailable`: `<p class="type-body-sm text-text-muted">Usage unavailable: metrics-server did not answer.</p>`, once. Not shown when metrics are available and there is simply no sample.
- **Pod panel:** `ContainerResourceRows` inside each existing container card, under the image, for containers that have rows. Usage is that pod's `resources.metricsFor`. No extra sentence: the card below already says when metrics are unavailable.

- [ ] **Step 1: Write the failing component tests** in `panels.test.ts`, in the existing Pod and Deployment blocks and with their helpers:
  - Deployment with containers `api` (cpu 250m/500m, memory 256Mi/512Mi) and `mesh` (sidecar, cpu request 50m only), one child pod with metrics (`api` 260m, 498Mi), metrics available: a heading `Resources`; `[data-section="resources"]` has two cards; the `api` card contains `260m of 500m · request 250m` and `498Mi of 512Mi · request 256Mi`, its memory row has `[data-level="critical"]` and its CPU row `[data-level="normal"]`; the `mesh` card contains `sidecar` and `request 50m · no limit` and no `[data-meter-track]` in its CPU row.
  - Same deployment, `resources.metricsAvailable = false`: `Usage unavailable: metrics-server did not answer.` appears exactly once; the rows read `limit 500m · request 250m`.
  - Same deployment, metrics available, no child pods: no `Usage unavailable` text; rows read `limit 500m · request 250m`. (Review Focus 5)
  - Deployment without `containers` (field absent): no `Resources` heading. (Review Focus 3)
  - A memory limit `{ text: "1Xi", amount: null }` with a sample: the text `498Mi of 1Xi` shows and the meter value reads the en dash. (Review Focus 1)
  - Pod with container `api` carrying resources and metrics for the pod: the card `[data-container="api"]` contains `260m of 500m · request 250m`; a container without `resources` has no `[data-resource-row]`.
- [ ] **Step 2: Run** `pnpm --filter desktop test -- panels` — expected: the new tests FAIL (no heading, no rows).
- [ ] **Step 3: Build the component and place it in both panels.**
- [ ] **Step 4: Run** `pnpm --filter desktop test -- panels` — expected: PASS.
- [ ] **Step 5: Run** `scripts/gates.sh --no-e2e` — expected: exit 0.
- [ ] **Step 6: Commit** `feat(desktop): Resources section in the deployment panel and resource rows in the pod panel`.

### Task 5: E2E, fixtures, changelog

**Files:**
- Modify: `apps/desktop/tests/e2e/tauri-mock.ts` (`FIXTURES`: resources on the `api-0` containers and `containers` on its deployment; `list_pod_metrics` stays `[]` by default)
- Modify: `apps/desktop/tests/e2e/detail-panel.spec.ts`
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)

**Interfaces:**
- Consumes: `tauriMockScript(overrides)` and `FIXTURES` as the existing specs use them.

- [ ] **Step 1: Write the e2e tests** in `detail-panel.spec.ts`, docked panel at 1440 × 900:
  - Deployment panel with `list_pod_metrics` overridden to give `api` 260m / 498Mi: the `Resources` section is visible; the `api` memory row shows `498Mi of 512Mi · request 256Mi`; the section and every card in it have `scrollWidth <= clientWidth` (nothing is cut in the 360 px panel).
  - Deployment panel with the default mock (no metrics): `Usage unavailable: metrics-server did not answer.` is visible once.
  - Pod panel: the `api` container card shows its two resource rows inside the panel's width.
- [ ] **Step 2: Run** `pnpm --filter desktop exec playwright test detail-panel` after a build — expected: the new tests FAIL until the fixtures carry the data, then PASS. If a test passes at once, mutate the component (drop the detail text) and see it fail.
- [ ] **Step 3: Add the changelog line** under `### Added`: "Deployment and pod panels show each container's CPU and memory requests, limits and current usage (#652)."
- [ ] **Step 4: Look at it.** Temporary spec `tests/e2e/zz-resources-shots.spec.ts`: Deployment and Pod panels, dark and light, with metrics and without; screenshots to the scratch directory; delete the spec.
- [ ] **Step 5: Run** `scripts/gates.sh --rust` — expected: exit 0, every gate `ok`.
- [ ] **Step 6: Commit** `test(desktop): e2e for the Resources section` (fixtures, e2e, changelog).
