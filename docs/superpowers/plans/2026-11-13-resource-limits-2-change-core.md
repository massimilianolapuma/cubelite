# Resource limits, delivery 2: core of the change — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The core can read what a change of a Deployment's requests and limits needs to be checked, check it, and apply it (with a server-side dry run, an override mark and a restore); the desktop exposes it as Tauri commands. No UI.

**Architecture:** A new module `crates/cubelite-core/src/limits/` holds everything. Reading the cluster (`facts.rs`) and writing to it (`apply.rs`) are the only parts with I/O; the check (`evaluate.rs`), the pod arithmetic (`pod_math.rs`), the mark (`mark.rs`) and the manager detection (`manager.rs`) are pure functions over serialisable types (`types.rs`). The frontend holds the facts and sends them back with each proposal, so the check costs no cluster call while typing; the apply reads the facts again and runs the same check before it writes.

**Tech Stack:** Rust (kube 4.2, k8s-openapi 0.28 `v1_32`, serde, tokio), Tauri 2 commands, TypeScript types in `apps/desktop/src/lib/tauri.ts`. Tests: `cargo test` with the mock API server of `crates/cubelite-core/src/test_support.rs`, Vitest for the wrappers.

**Spec:** `docs/superpowers/specs/2026-11-13-resource-limits-design.md` (§4, §5, §6, §7, §9, §10.2). Issue #655, parent #650.

## Global Constraints

- Deployments only. Containers that can be changed: the template's regular containers and its native sidecars (init containers with `restartPolicy: Always`). Plain init containers count in the pod's figures and cannot be changed.
- "Blocked" is only what the cluster itself would refuse (§4.1). Everything else is a warning with numbers; a check that could not run is a finding of level `not_checked`, never silence.
- The same `evaluate` runs for the editor and inside the apply. The apply refuses on any blocked finding, whatever the caller sent.
- Every comparison of quantities is numeric, on the parsed amount (millicores, bytes), never on the text. `1024Mi` equals `1Gi`; `1G` does not equal `1Gi`.
- The app sends the text the user typed; it never rewrites a field the proposal does not change.
- Annotation key: `cubelite.app/resources-override`, on the Deployment's `metadata`, never on the pod template. Field manager: `cubelite`.
- The patch is a strategic merge patch (`application/strategic-merge-patch+json`), containers keyed by name. Never a JSON merge patch of the `containers` array.
- No `unwrap()` or `expect()` outside tests. No em dash in any message a user can read (`crates/cubelite-core/tests/copy_dashes.rs`). No non-finite number may reach a serialised payload.
- Nothing under `apps/desktop/src/lib/components/` changes. `apps/desktop/tests/e2e/` is not touched.
- Never touch `~/.kube`, never run `kubectl`, never start the real app: every test runs against the mock API server.

## Calls made in this plan (the spec left them open, or this plan refines it)

1. A fourth command, `clear_resources_override`, for "Keep these values" (§6.2 needs a write; §7.2 counts three commands).
2. A proposal carries the **four wanted values of each container it lists**. A change is a field whose wanted amount differs from the cluster's. In an `adjust` proposal, an empty value where the cluster has one is blocked (code `cleared`): removing is only done by a restore.
3. A `restore` proposal carries no values: the core takes them from the active mark it reads from the cluster.
4. W0 has two sentences. For a request the spec's ("... The pods stay Pending unless a larger node is added."). For a limit alone, pods are not Pending, so: "No node in this cluster has 24Gi (largest: 16Gi): the container can never use this limit."
5. W2, W3 and the CPU note fire only when the change makes the figure worse (after > before; for W3, the own pods' memory limits on the node after > before). An overcommit that was there before and does not grow is not reported against this change.
6. A ResourceQuota with `scopes` or a `scopeSelector` is not evaluated: it is reported as not checked.
7. The pod overhead of the template is taken from `spec.overhead` of one of the workload's running pods (the RuntimeClass admission writes it there), zero when there is none. RuntimeClass objects are not read.
8. Memory typed with the suffix `m` (`512m` is 0.512 bytes) is a warning of its own (`milli_memory`).
9. The facts call fails as a whole only when the Deployment or its own pods cannot be read. Every other part is optional.
10. The manager's sentence (§5) is built by the UI in delivery 3; the core returns the kind and, for Helm, the release name.

## Review Focus

1. Memory typed as `512m`: a warning says it is a fraction of a byte and suggests `512Mi` (Task 3).
2. A node that reports no allocatable (`0`), or allocatable the parser cannot read: it is left out of the sums, and no percentage is NaN or infinite (Task 4).
3. A rollout already running when the editor opens: the workload's pods carry values other than the template's. "Before" figures come from the pods as they are, not from the template (Task 4).
4. The same amount typed in another unit (`1024Mi` over `1Gi`, `0.5` over `500m`): no change, nothing in the patch, and an apply with no change at all is refused with "Nothing to change." (Tasks 3 and 6).
5. An override annotation that is not what the app wrote (garbage, another `v`, a container that no longer exists): read as no mark, no panic, replaced by the next change (Task 1).

## File map

| File | Responsibility |
|---|---|
| `crates/cubelite-core/src/limits/mod.rs` | Module root, re-exports |
| `crates/cubelite-core/src/limits/types.rs` | Every serialisable type; `ResourceName::parse`, `fmt_amount` |
| `crates/cubelite-core/src/limits/manager.rs` | Who manages a workload, from labels and annotations |
| `crates/cubelite-core/src/limits/mark.rs` | The override annotation: parse, active or stale, next value |
| `crates/cubelite-core/src/limits/pod_math.rs` | Effective values, pod figures, QoS class |
| `crates/cubelite-core/src/limits/evaluate.rs` | `evaluate(facts, proposal) -> Evaluation` |
| `crates/cubelite-core/src/limits/facts.rs` | `KubeClient::resource_facts` |
| `crates/cubelite-core/src/limits/apply.rs` | Patch body, `KubeClient::apply_resources`, `KubeClient::clear_resources_override` |
| `crates/cubelite-core/src/limits/fixtures.rs` | `#[cfg(test)]`: the baseline facts and the mock cluster the tests share |
| `crates/cubelite-core/src/resources.rs`, `watcher.rs`, `lib.rs`, `client.rs` | `DeploymentInfo` gains `manager` and `resources_override`; re-exports; `raw_get` becomes `pub(crate)` |
| `apps/desktop/src-tauri/src/commands/limits.rs`, `commands/mod.rs`, `src-tauri/src/lib.rs` | Four commands, registered |
| `apps/desktop/src/lib/tauri.ts`, `tauri.test.ts` | Types and wrappers |

---

### Task 1: Shared types, the manager and the override mark

**Files:**
- Create: `crates/cubelite-core/src/limits/{mod.rs,types.rs,manager.rs,mark.rs}`
- Modify: `crates/cubelite-core/src/lib.rs`, `resources.rs` (`DeploymentInfo`), `watcher.rs` (`deployment_to_info`), `apps/desktop/src/lib/tauri.ts`

**Interfaces (produces):**

```rust
// types.rs — every type derives Debug, Clone, PartialEq, Serialize, Deserialize; enums are snake_case in JSON
pub enum ResourceName { Cpu, Memory }
pub enum ResourceField { Request, Limit }
impl ResourceName {
    /// Millicores for CPU, bytes for memory. None when unreadable or negative.
    pub fn parse(self, text: &str) -> Option<f64>;
}
/// Same output as `formatCpu` / `formatBytes` of apps/desktop/src/lib/units.ts for the same amount.
pub fn fmt_amount(resource: ResourceName, amount: f64) -> String;
/// Rounded percent of `total`; 0 when total <= 0; a value above 100 never reads 100 (it reads 101).
/// Always finite: a quotient too large for an f64 is clamped to the largest one.
pub fn percent(part: f64, total: f64) -> f64;

pub struct PairText { pub request: Option<String>, pub limit: Option<String> }
pub struct ResourceTexts { pub cpu: PairText, pub memory: PairText }
impl From<&ContainerResourcesInfo> for ResourceTexts;   // the cluster's texts

// manager.rs
pub enum ManagerKind { ArgoCd, FluxKustomization, FluxHelmRelease, Helm, PossiblyManaged, None }
pub struct ManagerInfo { pub kind: ManagerKind, pub release: Option<String> }  // release: Helm only
pub fn detect_manager(labels: &BTreeMap<String, String>, annotations: &BTreeMap<String, String>) -> ManagerInfo;

// mark.rs
pub const OVERRIDE_ANNOTATION: &str = "cubelite.app/resources-override";
pub struct OverrideContainer { pub name: String, pub original: ResourceTexts, pub applied: ResourceTexts }
pub struct OverrideInfo { pub at: String, pub containers: Vec<OverrideContainer> }   // containers in name order
/// The mark, when the annotation is one the app wrote (`v` = 1). None for anything else.
pub fn parse_mark(annotation: Option<&str>) -> Option<OverrideInfo>;
/// The mark when it is active: every container it lists exists and its four cluster values equal `applied` as amounts.
pub fn active_override(annotation: Option<&str>, containers: &[TemplateContainerInfo]) -> Option<OverrideInfo>;
/// The annotation value after a change: Some(json) to write, None to remove the annotation.
/// `changed` lists, for each container the change touches, its values before and after.
pub fn next_mark(active: Option<&OverrideInfo>, changed: &[OverrideContainer], at: &str) -> Option<String>;
```

`DeploymentInfo` gains `#[serde(default)] pub manager: ManagerInfo` (default kind `None`) and `#[serde(default)] pub resources_override: Option<OverrideInfo>` (the active mark only). TypeScript: `manager?: ManagerInfo`, `resources_override?: OverrideInfo | null`.

Rules the signatures do not carry:

- `detect_manager`: first match wins, in the order and with the keys of the table in spec §5 (the keys were checked against the Argo CD and Flux documentation when the spec was reviewed). `release` is the value of `meta.helm.sh/release-name`.
- Annotation JSON, exactly: `{"v":1,"at":"<RFC 3339, seconds, Z>","containers":{"<name>":{"original":{"cpu":{"request":…,"limit":…},"memory":{…}},"applied":{…}}}}`; a value not set is `null`.
- `next_mark`: with an active mark, a container already listed keeps its `original` and takes the new `applied`; a container not yet listed is added; a listed container the change does not touch stays as it is. Without an active mark (none, or stale) the result lists only `changed`. Then every container whose `applied` equals its `original` as amounts is dropped; with none left the result is `None`.

- [ ] **Step 1: Write the failing tests** (in each file's `mod tests`)

```rust
// manager.rs — one test per row of spec §5, plus the order
#[test] fn argo_cd_by_tracking_annotation_or_instance_label() { /* kind == ArgoCd for each key alone */ }
#[test] fn flux_kustomization_and_helm_release_by_their_labels() {}
#[test] fn flux_helm_release_wins_over_the_helm_annotation_it_also_carries() {}
#[test] fn helm_needs_the_release_annotation_and_reports_the_release() {
    // {"meta.helm.sh/release-name": "orders"} -> Helm, release Some("orders")
    // label app.kubernetes.io/managed-by=Helm alone -> PossiblyManaged
}
#[test] fn possibly_managed_by_instance_or_managed_by_label_alone() {}
#[test] fn nothing_recognised_is_none() {}

// mark.rs
#[test] fn the_spec_example_parses() { /* the JSON of spec §6.1 -> at, one container "api", original memory limit "512Mi", applied "768Mi" */ }
#[test] fn active_when_the_cluster_equals_applied_as_amounts() { /* applied "1024Mi", cluster "1Gi" -> Some */ }
#[test] fn stale_when_a_value_differs_or_the_container_is_gone() { /* -> None, both cases */ }
#[test] fn unset_matches_null_only() { /* applied limit null vs cluster limit "1" -> None */ }
#[test] fn garbage_another_version_or_empty_is_no_mark() { /* "{", "{\"v\":2,...}", "", "[]" -> parse_mark None, no panic */ }
#[test] fn second_change_keeps_the_first_original() {
    // active: api memory limit 512Mi -> 768Mi; change: 768Mi -> 1Gi  => original 512Mi, applied 1Gi, at replaced
}
#[test] fn a_stale_mark_is_replaced_not_merged() {}
#[test] fn changing_back_to_the_original_removes_the_mark() { /* next_mark(...) == None */ }

// types.rs
#[test] fn parse_and_compare_amounts() {
    assert_eq!(ResourceName::Memory.parse("1024Mi"), ResourceName::Memory.parse("1Gi"));
    assert_ne!(ResourceName::Memory.parse("1G"), ResourceName::Memory.parse("1Gi"));
    assert_eq!(ResourceName::Cpu.parse("0.5"), ResourceName::Cpu.parse("500m"));
    assert_eq!(ResourceName::Cpu.parse("-1"), None);
    assert_eq!(ResourceName::Memory.parse("abc"), None);
}
#[test] fn fmt_amount_matches_the_desktop_formatters() {
    // cpu: 412.0 -> "412m", 1500.0 -> "1.50", 2000.0 -> "2", 999.6 -> "1"
    // memory: 805306368.0 -> "768Mi", 1610612736.0 -> "1.5Gi", 17179869184.0 -> "16Gi", 25834815488.0 -> "24Gi"
}
#[test] fn percent_is_finite_and_never_rounds_an_excess_down_to_100() {
    assert_eq!(percent(1.0, 0.0), 0.0);
    assert_eq!(percent(100.29, 100.0), 101.0);
    assert_eq!(percent(80.47, 100.0), 80.0);
}

// watcher.rs
#[test] fn deployment_info_carries_the_manager_and_the_active_override() {}
#[test] fn deployment_info_drops_a_stale_override() {}
```

- [ ] **Step 2: Run** `cargo test -p cubelite-core limits::` — expected: does not compile (module missing).
- [ ] **Step 3: Implement** the three files and the `DeploymentInfo` fields; `deployment_to_info` reads `metadata.labels` and `metadata.annotations` before `d.spec` is moved. Re-export the public types from `lib.rs`. Add the TypeScript types.
- [ ] **Step 4: Run** `cargo test -p cubelite-core` and `pnpm --filter desktop exec tsc --noEmit` (or the repo's type gate) — expected: pass.
- [ ] **Step 5: Commit** `feat(core): detect who manages a deployment and read the resources override mark`

---

### Task 2: Effective values and pod figures

**Files:**
- Create: `crates/cubelite-core/src/limits/pod_math.rs`
- Modify: `limits/types.rs`, `limits/mod.rs`

**Interfaces:**
- Consumes: `ResourceName`, `ContainerResourcesInfo` (amounts already parsed).
- Produces:

```rust
// types.rs
pub struct Amounts { pub cpu_millis: f64, pub memory_bytes: f64 }                      // Default = zeros
pub struct PodFigures { pub request: Amounts, pub cpu_limit: Option<f64>, pub memory_limit: Option<f64>,  // None = no limit
    pub set_limits: Amounts }  // the limits as a node adds them up: an unset limit counts 0
pub struct PerResource { pub cpu: Option<f64>, pub memory: Option<f64> }
pub struct LimitRangeItemFacts { pub kind: String,                                       // "Container" or "Pod"
    pub min: PerResource, pub max: PerResource, pub default: PerResource,
    pub default_request: PerResource, pub max_ratio: PerResource }
pub struct LimitRangeFacts { pub name: String, pub items: Vec<LimitRangeItemFacts> }

// pod_math.rs
pub struct Effective { pub request: Option<f64>, pub limit: Option<f64> }
pub struct EffectiveContainer { pub name: String, pub cpu: Effective, pub memory: Effective }
/// What Kubernetes will run with: an unset request takes the limit, then the LimitRange
/// defaults (first LimitRange in name order that has one) fill what is still unset.
pub fn effective(name: &str, cpu: (Option<f64>, Option<f64>), memory: (Option<f64>, Option<f64>),
                 limit_ranges: &[LimitRangeFacts]) -> EffectiveContainer;
/// The pod's figures as the scheduler computes them. `init` is in spec order, with its sidecar flag.
pub fn pod_figures(regular: &[EffectiveContainer], init: &[(EffectiveContainer, bool)], overhead: &Amounts) -> PodFigures;
/// "Guaranteed", "Burstable" or "BestEffort", over every container of the pod.
pub fn qos_class(containers: &[EffectiveContainer]) -> &'static str;
```

The formula, from the Kubernetes documentation ("Init Containers" and "Sidecar Containers", section "Resource sharing within containers"; verify against the page, the spec asks for it): walking the init containers in order with `sidecars = 0` and `init_peak = 0`, a sidecar adds its value to `sidecars` and sets `init_peak = max(init_peak, sidecars)`; a plain init container sets `init_peak = max(init_peak, its value + sidecars)`. The pod's value is `max(sum of regular + sidecars, init_peak) + overhead`. An unset request counts 0. For limits the same walk, but any container with no effective limit makes the pod's limit `None` for that resource. `set_limits` is the same walk with an unset limit counting 0 (what `kubectl describe node` shows), plus the overhead when a container sets that limit, 0 when none does: every sum of limits on a node (the own pods before, the own pods after, the others) uses it; quotas and W0 keep the `Option` limits.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn unset_request_takes_the_limit() { /* (None, Some(500.0)) -> request Some(500.0) */ }
#[test] fn limit_range_defaults_fill_what_is_still_unset() {
    // default cpu 200, default_request cpu 100: (None, None) -> request 100, limit 200
    // (None, Some(500.0)) -> request 500 (the limit wins over default_request), limit 500
    // (Some(50.0), None) -> request 50, limit 200
}
#[test] fn regular_containers_add_up() { /* api 250m/256Mi + envoy 100m/64Mi -> 350m / 320Mi */ }
#[test] fn a_container_without_a_limit_makes_the_pod_limit_none() { /* envoy has no cpu limit -> cpu_limit None, memory_limit 640Mi */ }
#[test] fn a_large_init_container_sets_the_request() { /* init 1000m, regular 350m -> 1000m */ }
#[test] fn a_native_sidecar_adds_to_the_regular_containers_and_to_later_init_containers() {
    // init: [sidecar 100m, plain 300m], regular 200m -> max(200+100, 300+100) = 400m
}
#[test] fn overhead_is_added_last() {}
#[test] fn qos_classes() { /* all four values equal and set in every container -> Guaranteed; nothing set -> BestEffort; else Burstable */ }
```

- [ ] **Step 2: Run** `cargo test -p cubelite-core limits::pod_math` — expected: does not compile.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -p cubelite-core limits::` — expected: pass.
- [ ] **Step 5: Commit** `feat(core): effective requests and limits and the pod's figures`

---

### Task 3: Facts, proposal, and the blocking half of `evaluate`

**Files:**
- Create: `crates/cubelite-core/src/limits/evaluate.rs`, `limits/fixtures.rs`
- Modify: `limits/types.rs`, `limits/mod.rs`, `lib.rs`

**Interfaces:**
- Consumes: Task 1 and Task 2.
- Produces (types.rs):

```rust
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Fact<T> { Known { value: T }, Missing { reason: String } }

pub struct RolloutFacts { pub recreate: bool, pub max_surge: i32, pub max_unavailable: i32 }  // counts, already resolved
pub struct WorkloadFacts {
    pub namespace: String, pub name: String,
    pub resource_version: Option<String>, pub generation: i64, pub replicas: i32,
    pub rollout: RolloutFacts,
    pub containers: Vec<TemplateContainerInfo>,        // regular, spec order
    pub init_containers: Vec<TemplateContainerInfo>,   // every init container, spec order; `sidecar` set
    pub overhead: Amounts, pub manager: ManagerInfo, pub override_annotation: Option<String> }
/// What the editor saw, sent back with the apply (spec §6.1).
pub struct SeenState { pub generation: i64,
    pub resources: BTreeMap<String, ContainerResourcesInfo>,   // every container of the template, init included
    pub override_annotation: Option<String> }
pub struct OwnPodFacts { pub name: String, pub node: Option<String>, pub figures: PodFigures,
    pub usage: Vec<ContainerUsageInfo> }                        // empty: no sample
pub struct NodeFacts { pub name: String, pub schedulable: bool, pub allocatable: Amounts,
    pub others_requests: Amounts, pub others_cpu_limits: f64, pub others_memory_limits: f64,   // pods not of this workload
    pub memory_used: Option<f64> }                              // metrics-server; None: no sample
pub struct QuotaFacts { pub name: String, pub scoped: bool,
    pub hard: BTreeMap<String, f64>, pub used: BTreeMap<String, f64> }   // only the six keys of spec B5, as amounts
pub struct HpaFacts { pub name: String, pub cpu_utilization: bool, pub memory_utilization: bool }
pub struct VpaFacts { pub name: String, pub update_mode: String }
pub struct ResourceFacts {
    pub workload: WorkloadFacts, pub seen: SeenState, pub pods: Vec<OwnPodFacts>,
    pub usage: Fact<()>,                                        // Known: metrics-server answered
    pub nodes: Fact<Vec<NodeFacts>>, pub limit_ranges: Fact<Vec<LimitRangeFacts>>,
    pub quotas: Fact<Vec<QuotaFacts>>, pub hpas: Fact<Vec<HpaFacts>>, pub vpas: Fact<Vec<VpaFacts>> }

pub enum ProposalKind { Adjust, Restore }
pub struct ContainerProposal { pub name: String, pub resources: ResourceTexts }   // the four values wanted
pub struct Proposal { pub kind: ProposalKind, pub containers: Vec<ContainerProposal> }   // containers ignored for Restore

pub enum Level { Blocked, Warning, NotChecked, Note }
pub enum FindingCode { B1, B2, B3, B4, B5, Cleared, UnknownContainer, NoOverride,
    W0, W1, W1r, W2, W3, W4, W5, W6, W7, W8, MilliMemory, W9,
    NoteFits, NoteCpuLimits, NoteQos, NoteNoPods }
pub struct Finding { pub code: FindingCode, pub level: Level, pub message: String,
    pub container: Option<String>, pub resource: Option<ResourceName>,
    pub field: Option<ResourceField>, pub node: Option<String> }
pub struct Change { pub container: String, pub sidecar: bool, pub resource: ResourceName,
    pub field: ResourceField, pub before: Option<String>, pub after: Option<String> }
pub struct BeforeAfter { pub before: f64, pub after: f64 }      // percent of the node's allocatable
pub struct NodeProjection { pub name: String, pub schedulable: bool, pub own_pods: i32,
    pub cpu_requests: BeforeAfter, pub memory_requests: BeforeAfter,
    pub cpu_limits: BeforeAfter, pub memory_limits: BeforeAfter,
    pub memory_if_full: Option<BeforeAfter> }                   // None without usage
pub struct Evaluation { pub findings: Vec<Finding>, pub changes: Vec<Change>, pub nodes: Vec<NodeProjection> }

// evaluate.rs
pub fn evaluate(facts: &ResourceFacts, proposal: &Proposal) -> Evaluation;
```

`fixtures.rs` (`#[cfg(test)]`, `pub(crate)`): `facts()` returns the baseline every table test starts from, and `set(container, resource, field, text) -> Proposal` builds an adjust proposal that lists that one container with the cluster's values and that one field replaced (`None` clears it).

Baseline: deployment `default/api`, generation 7, 3 replicas, rolling update with surge 1 and unavailable 0, no manager, no annotation; containers `api` (CPU 250m / 500m, memory 256Mi / 512Mi) and `envoy` (CPU 100m / none, memory 64Mi / 128Mi); pods `api-1`, `api-2`, `api-3` on `aks-pool-1`, each with figures request 350m / 320Mi, CPU limit none, memory limit 640Mi and usage `api` 412m / 498Mi, `envoy` 38m / 41Mi; nodes `aks-pool-1` (schedulable, allocatable 4000m / 16Gi, others' requests 1000m / 8Gi, others' CPU limits 2000m, others' memory limits 11Gi, memory used 13Gi) and `aks-pool-2` (schedulable, 4000m / 16Gi, others' requests 2000m / 8Gi, CPU limits 2000m, memory limits 8Gi, used 8Gi); usage known; no LimitRange, quota, HPA or VPA.

Rules of this task:

- **Resolve.** `Restore`: the wanted values are the `original` of the active mark (`active_override` over the facts); no active mark is one finding `NoOverride`, blocked, "There is no active override to restore.", and nothing else runs. `Adjust`: a container the template does not have among its regular containers and native sidecars is `UnknownContainer`, blocked, "Container `x` is not in this deployment."; a plain init container of the template, the same code and level, "`migrate` is an init container: it cannot be changed here."
- **Changes.** For each listed container and each of the four fields: unchanged when both are unset, or both parse to the same amount (or neither parses and the texts are equal). Everything else is a `Change` (`before` and `after` are the texts). Order: template order of the container, CPU before memory, request before limit.
- **Blocked**, on the values after the change (effective values by `effective`, with the LimitRanges when known):

| Code | Condition | Message | Carries |
|---|---|---|---|
| `Cleared` | `Adjust`, a change whose `after` is unset | "A request or a limit cannot be removed here." | container, resource, field |
| `B1` | a changed value does not parse | "`{text}` is not a valid quantity." | container, resource, field |
| `B2` | a limit (set) parses to 0 | "A limit of zero: the container could not run." | container, resource, limit |
| `B3` | effective limit < effective request | "The limit ({limit}) is under the request ({request})." | container, resource, limit |
| `B4` | a LimitRange is violated, for any container of the template (rules below); a warning when it was already so before (below) | "LimitRange `{name}`: {what}." | container (when one), resource |
| `B5` | a quota is exceeded with every replica on the new values, or a container lacks a value a quota key needs (rule below); a warning when it was already so before (below) | "Quota `{name}`: {replicas} replicas need {need} of {key}; {free} is free of {hard}." | resource |

  B4, per LimitRange item (the admission plugin's rules; check them against "Limit Ranges" in the Kubernetes documentation): type `Container`, per resource and per container: `min` set and the effective request unset ("needs a {resource} request on every container; `{c}` has none") or under it ("{resource} request {v} of `{c}` is under the minimum {min}"); `max` set and the effective limit unset or above it ("... is above the maximum {max}"); `max_ratio` set and limit / request above it ("{resource} limit of `{c}` is {n} times its request; the maximum ratio is {ratio}"). Type `Pod`, per resource, on `pod_figures` without overhead: limit above `max` ("the pod's {resource} limits ({v}) are above the pod maximum {max}"), request under `min`.

  B5, per unscoped quota and per key (`requests.cpu` and `cpu` use the pod's CPU request; `requests.memory` and `memory` the memory request; `limits.cpu`, `limits.memory` the pod's limits): `own_now` = sum of that figure over `facts.pods`; `free = hard - (used - own_now)`; blocked when `replicas * new > free`. A limits key with a pod limit of `None`: blocked, "Quota `{name}` needs a {resource} limit on every container." A requests key (`requests.cpu`, `requests.memory`, `cpu`, `memory`) and a container of the template (init included) with no effective request of that resource: blocked, "Quota `{name}` needs a {resource} request on every container." (once per quota and resource).

  **Already so before.** B4 and B5 are evaluated on the template before the change too. A condition with a figure (a container or pod minimum, maximum or ratio; a quota exceeded) that also holds before, on the same rule and the same container, and whose figure the change does not move further past the bound (a maximum, a ratio, a quota need not higher; a minimum not lower), keeps its code and gets level `Warning`, its sentence followed by " It was already so before this change." The apply lets it through and returns it. A missing value (no request, no limit) has no figure and stays blocked; everything else stays blocked. W0 stays the first warning.
- **`MilliMemory`** (warning): a changed memory value whose text ends in `m`: "`512m` is 0.512 bytes: the suffix m means thousandths. Did you mean `512Mi`?"
- Amounts in messages go through `fmt_amount`. Findings are sorted: blocked, warning, not checked, note; inside a level by the order of `FindingCode` as declared, except `W0` first among warnings; then by node, then by container.

- [ ] **Step 1: Write the failing tests** (`evaluate.rs`, `mod tests`): one test per row, each asserting the code, the level, the exact message and what the finding carries.

```rust
#[test] fn raising_a_limit_is_one_change_and_no_blocked_finding() {
    let e = evaluate(&facts(), &set("api", Memory, Limit, Some("768Mi")));
    assert_eq!(e.changes, [Change { container: "api".into(), sidecar: false, resource: Memory,
        field: Limit, before: Some("512Mi".into()), after: Some("768Mi".into()) }]);
    assert!(e.findings.iter().all(|f| f.level != Level::Blocked));
}
#[test] fn the_same_amount_in_another_unit_is_no_change() {
    // api memory limit "0.5Gi" over 512Mi, api cpu limit "0.5" over 500m -> changes empty
}
#[test] fn b1_an_unreadable_or_negative_quantity() { /* "abc", "-1" -> "`abc` is not a valid quantity." on api / memory / limit */ }
#[test] fn b2_a_limit_of_zero() {}
#[test] fn b3_a_limit_under_its_request() { /* api memory limit "200Mi" -> "The limit (200Mi) is under the request (256Mi)." */ }
#[test] fn b3_uses_the_effective_values() {
    // LimitRange with a Container default cpu limit of 200m; envoy (cpu request 100m, no limit): cpu request "300m"
    // -> effective limit 200m is under the request -> B3 "The limit (200m) is under the request (300m)."
}
#[test] fn cleared_blocks_an_adjust_and_not_a_restore() {}
#[test] fn unknown_container_and_plain_init_container_are_refused() {}
#[test] fn b4_container_max_min_and_ratio() { /* LimitRange `limits`, Container max memory 1Gi; api memory limit "2Gi" ->
    "LimitRange `limits`: memory limit 2Gi of `api` is above the maximum 1Gi." ; one case each for min and ratio */ }
#[test] fn b4_pod_max() {}
#[test] fn b4_not_run_without_limit_ranges_is_left_to_w9() { /* limit_ranges Missing -> no B4 */ }
#[test] fn b5_all_replicas_on_the_new_values_exceed_the_quota() {
    // quota `team`: hard requests.memory 2Gi, used 1Gi; api memory request and limit "1Gi"
    // -> "Quota `team`: 3 replicas need 3.2Gi of requests.memory; 1.9Gi is free of 2Gi."
}
#[test] fn b5_bare_cpu_and_memory_keys_count_requests() {}
#[test] fn b5_a_limits_quota_needs_a_limit_on_every_container() { /* hard limits.cpu: envoy has no cpu limit -> blocked */ }
#[test] fn restore_without_an_active_mark_is_refused() {}
#[test] fn restore_proposes_the_original_values_and_may_clear() {
    // annotation: api memory limit original null, applied "512Mi" -> change before Some("512Mi"), after None, not blocked
}
#[test] fn memory_typed_with_m_is_called_out() { /* api memory limit "512m" -> MilliMemory, warning, the sentence above */ }
#[test] fn blocked_findings_come_first() {}
```

- [ ] **Step 2: Run** `cargo test -p cubelite-core limits::evaluate` — expected: does not compile.
- [ ] **Step 3: Implement** the types, the fixtures and this half of `evaluate` (`nodes` may stay empty until Task 4).
- [ ] **Step 4: Run** `cargo test -p cubelite-core limits::` — expected: pass.
- [ ] **Step 5: Commit** `feat(core): check a change of requests and limits against what the cluster refuses`

---

### Task 4: Warnings, notes, "not checked" and the node projection

**Files:**
- Modify: `crates/cubelite-core/src/limits/evaluate.rs`, `limits/fixtures.rs`

**Interfaces:** consumes Task 3; `evaluate` keeps its signature and now fills every finding and `Evaluation.nodes`.

Terms: `new` = `pod_figures` of the template after the change (with the workload's overhead); own pods on a node = `facts.pods` with that `node`; a node is used in the sums only when both its allocatable amounts are above 0. "Before" figures of a node use the own pods' figures as the facts carry them; "after" figures replace each own pod on the node with `new`.

| Code | Condition | Message |
|---|---|---|
| `W0` | nodes known and not empty; `new` request of a resource above the allocatable of every node (schedulable or not) | "No node in this cluster can hold {value} (largest: {largest}). The pods stay Pending unless a larger node is added." |
| `W0` | else, a container's effective limit that the change touches (a change of that container's limit of that resource) above every node's allocatable | "No node in this cluster has {value} (largest: {largest}): the container can never use this limit." (container, resource, limit) |
| `W1` | no W0, replicas > 0; `fit` = sum over schedulable nodes of how many `new` pods fit in `allocatable - others_requests` (CPU and memory; a request of 0 never limits); `fit < replicas` | "Only {fit} of {replicas} replicas have room by their requests; the rest stay Pending unless nodes are added." |
| `NoteFits` | W1 ran and is clear | "Fits: {replicas} of {replicas} replicas have room by their requests." |
| `W1r` | W1 clear, replicas > 0, rolling update: on no schedulable node does `new` fit in `allocatable - others_requests - own pods' requests + the requests of up to max_unavailable own pods on that node` | "The rollout may stall: no node has room for a new pod while the old ones still run." |
| `W2` | on a node with own pods: memory limits after > allocatable and after > before (limits summed by `set_limits`: a container without a limit counts 0, it does not switch the check off) | "Memory limits on {node} add up to {after}% of what the node has (was {before}%). Under memory pressure the node evicts pods." |
| `W3` | same nodes, usage known, the own pods' `set_limits` memory after the change above their sum before it, the node has `memory_used`: `memory_used - own pods' memory usage + own pods * new.set_limits.memory` > allocatable and > `memory_used`. Without `memory_used`: `W9` (below) | "If these pods use their full limit, {node} runs out of memory ({before}% → {after}%)." |
| `W4` | a changed memory limit under the highest usage of that container over the pods | "The container would be OOMKilled as soon as it starts using what it uses now ({usage})." |
| `W5` | a changed CPU limit under the highest CPU usage of that container | "The container would be throttled: it uses {usage} now and the new CPU limit is {limit}." |
| `W6` | an unscoped quota key that B5 passes, own pods exist: for some k in 0..replicas, `max(0, replicas - max_unavailable - k) * old + (k + 1) * new > free` (`old` = the highest of the own pods' figure for that key; with `recreate`, never) | "The rollout may stall until old pods are gone: quota `{name}` has no room for old and new pods together." |
| `W7` | an HPA with utilisation on a resource whose running containers' requests change: the sum of the effective requests (unset 0) of the regular containers and the native sidecars, after against before (the HPA divides by these, not by the scheduler's pod request, which a large plain init container can hold still) | "HorizontalPodAutoscaler `{name}` scales on {cpu or memory} utilisation, which is a share of the request: the replica count may move." |
| `W8` | a VPA whose `update_mode` is not `Off` | "VerticalPodAutoscaler `{name}` (mode {mode}) will rewrite these values." |
| `W9` | a `Missing` fact: nodes "Not checked: room on the nodes ({reason})."; usage "Not checked: current usage against the new limits ({reason})."; limit ranges "Not checked: namespace limit ranges ({reason})."; quotas "Not checked: namespace quota ({reason})."; HPAs "Not checked: autoscalers ({reason})."; VPAs "Not checked: vertical autoscalers ({reason})." A scoped quota: "Not checked: quota `{name}` (it has scopes)." Usage known, pods exist, a changed limit of a container no pod has a sample for: "Not checked: usage of `{container}` (no sample from metrics-server)." Where W3 would run but the hosting node has no `memory_used`: "Not checked: memory in use on {node} (no sample from metrics-server)." (node, memory). Pods exist and a container of the template after the change has no effective memory limit, one per container: "Not checked: how much memory `{container}` can take on the nodes (it has no memory limit)." (container, memory, limit) | level `NotChecked` |
| `NoteCpuLimits` | on a node with own pods: CPU limits after > allocatable and after > before (summed by `set_limits`) | "CPU limits on {node} add up to {after}% of its CPU (was {before}%). CPU is shared: the pods slow down, they are not killed." |
| `NoteQos` | `qos_class` of the template differs before and after | "The pod's QoS class changes from {before} to {after}." |
| `NoteNoPods` | `facts.pods` is empty | "No pod is running: the checks on current usage do not apply." (W2 to W5 and the usage `W9` are then not emitted) |

`Evaluation.nodes`: when nodes are known, one `NodeProjection` per node, the nodes with own pods first (by name), then the others (by name); percentages by `percent` of the node's allocatable; limits are summed by `set_limits` (a container without a limit adds 0, the rest of its pod still counts); `memory_if_full` is `Some` only for a node with own pods, usage known and `memory_used` present, and projects `new.set_limits.memory`. When nodes are missing, `nodes` is empty.

- [ ] **Step 1: Write the failing tests**: one per row of the table (the condition met and, for W1r, W2, W3, W6 and the CPU note, the neighbouring case that must stay silent), each asserting code, level, exact message and node or container. Pinned rows:

```rust
#[test] fn w0_request_above_every_node() {
    // api memory request and limit "24Gi" ->
    // "No node in this cluster can hold 24Gi (largest: 16Gi). The pods stay Pending unless a larger node is added."
    // first of the warnings; no W1, no W1r
}
#[test] fn w0_limit_alone_has_its_own_sentence() { /* api memory limit "24Gi", request untouched */ }
#[test] fn w0_counts_cordoned_nodes() { /* a 32Gi node with schedulable false -> no W0 for 24Gi */ }
#[test] fn w1_fewer_replicas_fit_than_wanted() {
    // api cpu request and limit "1500m" -> "Only 2 of 3 replicas have room by their requests; the rest stay Pending unless nodes are added."
}
#[test] fn note_fits_when_every_replica_has_room() { /* baseline + memory limit 768Mi -> "Fits: 3 of 3 replicas have room by their requests." */ }
#[test] fn w1r_the_end_state_fits_and_the_rollout_does_not() {
    // one node 4000m, others 0, three own pods of 1000m, new pod 1300m, surge 1 / unavailable 0 -> W1r
    // the same with unavailable 1 -> no W1r; the same with recreate -> no W1r
}
#[test] fn w2_memory_limits_above_the_node() {
    // aks-pool-1 others' memory limits 15Gi; api memory limit "768Mi" ->
    // "Memory limits on aks-pool-1 add up to 110% of what the node has (was 105%). Under memory pressure the node evicts pods."
}
#[test] fn w2_silent_when_the_change_does_not_make_it_worse() { /* same node, a CPU-only change -> no W2 */ }
#[test] fn w3_full_limits_run_the_node_out_of_memory() {
    // aks-pool-1 memory used 15Gi; api memory limit "1Gi" ->
    // "If these pods use their full limit, aks-pool-1 runs out of memory (94% → 105%)."
}
#[test] fn w4_memory_limit_under_current_usage() { /* api memory limit "400Mi" -> "... what it uses now (498Mi)." */ }
#[test] fn w5_cpu_limit_under_current_usage() { /* api cpu limit "300m" -> "... it uses 412m now and the new CPU limit is 300m." */ }
#[test] fn w6_quota_fits_at_the_end_and_not_during_the_rollout() {
    // quota `team` hard requests.memory 1300Mi, used 960Mi; api memory request "336Mi" -> W6, no B5
}
#[test] fn w7_hpa_on_cpu_and_a_cpu_request_change() { /* and silent for a memory-only change */ }
#[test] fn w7_an_unset_request_that_follows_its_limit_counts() {
    // facts where api has no cpu request (effective 500m, its limit); api cpu limit "600m" -> W7: the request moved with the limit
}
#[test] fn w8_vpa_unless_off() {}
#[test] fn w9_one_finding_per_missing_fact_with_its_reason() {
    // quotas Missing { reason: "not allowed to read ResourceQuota" } ->
    // "Not checked: namespace quota (not allowed to read ResourceQuota)." level NotChecked; and no B5, no W6
}
#[test] fn w9_nodes_missing_stops_w0_to_w3() {}
#[test] fn w9_usage_missing_stops_w3_w4_w5() {}
#[test] fn w9_scoped_quota() {}
#[test] fn w9_a_container_without_a_sample() {}
#[test] fn no_pods_says_so_once_and_skips_the_usage_checks() { /* pods empty, replicas 3: NoteNoPods; W1 still runs */ }
#[test] fn zero_replicas_runs_no_room_check() {}
#[test] fn note_cpu_limits_and_note_qos() {}
#[test] fn a_node_without_allocatable_is_left_out_and_nothing_is_nan() {
    // add a node with allocatable 0 / 0 hosting nothing, and make it host a pod: every percentage is finite,
    // serde_json::to_string(&evaluation) succeeds and round-trips
}
#[test] fn before_figures_come_from_the_pods_not_the_template() {
    // api-1 carries figures of an older template (memory limit 320Mi): the W2 "was" percent uses 320Mi for that pod
}
#[test] fn node_projection_lists_hosting_nodes_first_with_before_and_after() {}
#[test] fn warnings_are_sorted_w0_first_then_by_code() {}
```

- [ ] **Step 2: Run** `cargo test -p cubelite-core limits::evaluate` — expected: the new tests fail (findings missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `scripts/gates.sh --rust --no-e2e` — expected: exit 0.
- [ ] **Step 5: Commit** `feat(core): warn with numbers when a change of requests and limits is risky`

---

### Task 5: Read the facts

**Files:**
- Create: `crates/cubelite-core/src/limits/facts.rs`
- Modify: `limits/fixtures.rs`, `limits/mod.rs`, `client.rs` (`raw_get` becomes `pub(crate)`)

**Interfaces:**
- Consumes: Task 3 types, `pod_figures`, `effective`, `detect_manager`, `pod_metrics_from_item`.
- Produces: `impl KubeClient { pub async fn resource_facts(&self, namespace: &str, name: &str) -> Result<ResourceFacts, KubeconfigError>; }`

Calls, the optional ones concurrently:

| Call | Failure |
|---|---|
| GET the Deployment | the call fails: `ClientError` with the API's message |
| LIST pods of the namespace with the Deployment's label selector (`Selector::try_from(LabelSelector)`, `ListParams::labels_from`) | the call fails |
| LIST nodes; LIST pods of all namespaces with field selector `status.phase!=Succeeded,status.phase!=Failed` | `nodes` Missing: 403 on nodes "not allowed to list nodes"; 403 on pods "not allowed to list pods in other namespaces" |
| GET `/apis/metrics.k8s.io/v1beta1/nodes` and `/apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods` | `usage` Missing "metrics-server is not installed or did not answer" (either call) |
| LIST LimitRanges, ResourceQuotas (namespace) | Missing: 403 "not allowed to read LimitRange" / "not allowed to read ResourceQuota" |
| LIST HorizontalPodAutoscalers `autoscaling/v2` (namespace) | Missing: 403 "not allowed to read HorizontalPodAutoscaler" |
| GET `/apis/autoscaling.k8s.io/v1/namespaces/{ns}/verticalpodautoscalers` | 404: Known, empty. 403: Missing "not allowed to read VerticalPodAutoscaler" |

Any other failure of an optional call: Missing with "could not be read: {the API's message, or the error}".

Mapping rules:

- Own pods: those of the selector list that are not `Succeeded` or `Failed` and whose controller owner reference is the ReplicaSet named `{deployment name}-{the pod's pod-template-hash label}` (no extra call); a pod of the selector list owned otherwise (a canary Deployment, a Job, a bare pod) is not an own pod, and counts with the other pods of its node; figures by `pod_figures` over the pod's own spec (no LimitRange: the API already applied the defaults), with the pod's `spec.overhead`; usage from the pod metrics by pod name. The workload's `overhead` is the first own pod's, zero without one.
- Node: schedulable = condition `Ready` is `True` and `spec.unschedulable` is not true. `others_*` sum the figures of the pods of the all-namespaces list on that node that are not own pods (matched by namespace and name); the limits are their `set_limits` (a container without a limit adds 0). `memory_used` from the node metrics when usage is known.
- Rollout: `recreate` when the strategy type is `Recreate`; else `max_surge` and `max_unavailable` resolved against the replicas as Kubernetes does (defaults 25% and 25%; a percentage of surge rounds up, of unavailable rounds down; when both resolve to 0, unavailable is 1; a percentage too large to multiply saturates).
- LimitRange item: `kind` is its `type`; the five maps parsed per resource (`max_ratio` is a plain number: parse as CPU and divide by 1000). Quota: `scoped` when `spec.scopes` is not empty or `spec.scopeSelector` is set; `hard` and `used` from the status (hard falls back to the spec), only the keys `requests.cpu`, `requests.memory`, `limits.cpu`, `limits.memory`, `cpu`, `memory`.
- HPA: kept when `scaleTargetRef` is kind `Deployment` with this name; `cpu_utilization` / `memory_utilization` when a metric of type `Resource` or `ContainerResource` on that resource has target type `Utilization`. VPA: kept when `spec.targetRef` is kind `Deployment` with this name; `update_mode` is `spec.updatePolicy.updateMode`, `"Auto"` when absent.
- `seen`: the generation, the resources of every template container (init included) by name, the annotation.

`fixtures.rs` gains `cluster()`: a builder of the mock API server's answers by URI prefix (the baseline cluster of Task 3 as API objects), with a way to replace one route's answer (`with(prefix, status, json)`), used by this task and the next.

- [ ] **Step 1: Write the failing tests** (mock API server, as `client.rs` does)

```rust
#[tokio::test] async fn facts_of_the_baseline_cluster_equal_the_baseline_facts() {
    // cluster() -> resource_facts("default", "api") == fixtures::facts()
}
#[tokio::test] async fn the_deployment_missing_is_an_error_with_the_api_message() {}
#[tokio::test] async fn without_metrics_server_nodes_still_carry_allocatable() {
    // both metrics routes 404 -> usage Missing("metrics-server is not installed or did not answer"),
    // nodes Known with allocatable and memory_used None, pods with empty usage
}
#[tokio::test] async fn a_namespace_scoped_user_gets_nodes_missing_and_the_namespace_rules() {
    // /api/v1/nodes 403 -> nodes Missing("not allowed to list nodes"); limit_ranges and quotas Known
}
#[tokio::test] async fn each_forbidden_part_is_missing_with_its_reason() { /* limitranges, resourcequotas, hpa, all-namespaces pods */ }
#[tokio::test] async fn no_vpa_api_is_known_and_empty() {}
#[tokio::test] async fn terminal_pods_are_not_counted() {}
#[tokio::test] async fn a_cordoned_or_not_ready_node_is_not_schedulable() {}
#[tokio::test] async fn rollout_counts_are_resolved() { /* 25% / 25% of 3 -> surge 1, unavailable 0; 0 / 0 -> unavailable 1; Recreate */ }
#[tokio::test] async fn hpa_and_vpa_of_other_workloads_are_left_out() {}
#[tokio::test] async fn scoped_quota_is_flagged() {}
#[tokio::test] async fn native_sidecars_and_plain_init_containers_are_told_apart() {}
#[tokio::test] async fn only_reads_are_sent() { /* every request seen is a GET */ }
```

- [ ] **Step 2: Run** `cargo test -p cubelite-core limits::facts` — expected: does not compile.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -p cubelite-core limits::` — expected: pass.
- [ ] **Step 5: Commit** `feat(core): read what a change of a deployment's resources must be checked against`

---

### Task 6: Apply, restore, and removing the mark

**Files:**
- Create: `crates/cubelite-core/src/limits/apply.rs`
- Modify: `limits/mod.rs`

**Interfaces:**
- Consumes: `resource_facts`, `evaluate`, `next_mark`, `active_override`.
- Produces:

```rust
/// The patch of a checked change. Pure. `mark`: the annotation value to write, None to remove it.
pub fn patch_body(resource_version: Option<&str>, changes: &[Change], mark: Option<&str>) -> serde_json::Value;
impl KubeClient {
    /// Reads the facts, refuses a change underneath `seen` and any blocked finding, then sends the patch.
    /// Returns the evaluation the change was applied with.
    pub async fn apply_resources(&self, namespace: &str, name: &str, proposal: &Proposal,
        seen: &SeenState, dry_run: bool) -> Result<Evaluation, KubeconfigError>;
    /// Removes the override annotation and nothing else ("Keep these values").
    pub async fn clear_resources_override(&self, namespace: &str, name: &str) -> Result<(), KubeconfigError>;
}
```

Patch body, exactly (a key appears only when it has content):

```json
{ "metadata": { "resourceVersion": "812", "annotations": { "cubelite.app/resources-override": "<json>" } },
  "spec": { "template": { "spec": {
    "containers":     [ { "name": "api",   "resources": { "limits": { "memory": "768Mi" } } } ],
    "initContainers": [ { "name": "envoy", "resources": { "requests": { "cpu": "200m" } } } ] } } } }
```

Only changed fields are written; a change whose `after` is unset writes `null` for that key; a native sidecar goes under `initContainers`; removing the mark writes `null` for the annotation.

Order of `apply_resources`, every refusal a `ClientError` whose reason is the sentence:

1. `resource_facts`.
2. Underneath: when the generation differs from `seen`, compare the resources of every container as amounts; compare the annotation always. A difference: "The deployment's resources changed since you opened this. Reopen and try again."
3. `evaluate`. A blocked finding: its message (the first one). No change: "Nothing to change."
4. The mark: `Adjust` uses `next_mark` (active mark of the facts, the changed containers' values before and after, now as RFC 3339 seconds); `Restore` removes it.
5. PATCH with `Patch::Strategic`, `PatchParams { field_manager: Some("cubelite"), dry_run, .. }`.
6. A 409 runs steps 1 to 5 once more. A second 409: "The deployment is changing too fast to update. Try again." A 403: "You are not allowed to change this deployment." Any other API error: its `message`.

`clear_resources_override`: a merge patch `{"metadata":{"annotations":{"cubelite.app/resources-override":null}}}`, field manager `cubelite`; errors mapped as in step 6.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn patch_body_writes_only_changed_fields_by_container_name() { /* the JSON above, field for field */ }
#[test] fn patch_body_puts_a_native_sidecar_under_init_containers() {}
#[test] fn patch_body_clears_with_null_and_removes_the_mark_with_null() {}

#[tokio::test] async fn apply_sends_one_strategic_patch_with_the_version_just_read() {
    // cluster(); api memory limit "768Mi" -> the last request is PATCH /apis/apps/v1/namespaces/default/deployments/api?...
    // content type application/strategic-merge-patch+json; uri has fieldManager=cubelite and no dryRun;
    // body.metadata.resourceVersion == the Deployment's; body.spec.template.spec.containers ==
    //   [{"name":"api","resources":{"limits":{"memory":"768Mi"}}}];
    // the annotation parses to original memory limit "512Mi", applied "768Mi", for `api` only
}
#[tokio::test] async fn dry_run_sends_the_same_patch_with_dry_run_all() { /* uri contains dryRun=All; body equal but for `at` */ }
#[tokio::test] async fn a_blocked_change_is_refused_and_nothing_is_patched() { /* limit under request: Err with the B3 sentence; no PATCH seen */ }
#[tokio::test] async fn a_warning_does_not_stop_the_apply_and_is_returned() {}
#[tokio::test] async fn nothing_to_change_is_refused() { /* "1024Mi" over... the same amount -> "Nothing to change." */ }
#[tokio::test] async fn resources_changed_underneath_are_refused() { /* seen.resources differ from the cluster, generation differs */ }
#[tokio::test] async fn the_mark_changed_underneath_is_refused() {}
#[tokio::test] async fn a_generation_moved_by_a_scale_is_not_refused() { /* seen.generation 6, cluster 7, same resources -> applied */ }
#[tokio::test] async fn one_conflict_is_retried_from_the_read() { /* first PATCH 409, second 200 -> Ok; two PATCHes, the Deployment read twice */ }
#[tokio::test] async fn a_second_conflict_gives_up_with_its_sentence() {}
#[tokio::test] async fn forbidden_reads_as_not_allowed() { /* PATCH 403 -> "You are not allowed to change this deployment." */ }
#[tokio::test] async fn an_admission_rejection_shows_the_api_message() { /* PATCH 400 with message "denied by policy" -> that text, no prefix inside reason */ }
#[tokio::test] async fn a_second_change_keeps_the_first_original_in_the_mark() {}
#[tokio::test] async fn restore_puts_the_original_back_and_removes_the_mark() {
    // cluster with an active mark (memory limit original "512Mi", applied "768Mi", cluster at 768Mi), Proposal { kind: Restore, containers: [] }
    // -> containers [{"name":"api","resources":{"limits":{"memory":"512Mi"}}}], annotation null
}
#[tokio::test] async fn restore_to_a_value_that_was_not_set_clears_it() {}
#[tokio::test] async fn clear_override_patches_the_annotation_only() { /* merge patch, the body above */ }
```

- [ ] **Step 2: Run** `cargo test -p cubelite-core limits::apply` — expected: does not compile.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `scripts/gates.sh --rust --no-e2e` — expected: exit 0.
- [ ] **Step 5: Commit** `feat(core): apply a checked change of requests and limits, with dry run, override mark and restore`

---

### Task 7: Tauri commands and TypeScript wrappers

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/limits.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`, `apps/desktop/src-tauri/src/lib.rs` (import and `generate_handler!`), `apps/desktop/src/lib/tauri.ts`, `apps/desktop/src/lib/tauri.test.ts`, `crates/cubelite-core/src/lib.rs` (re-exports the commands need)

**Interfaces (produces):**

```rust
#[tauri::command] pub async fn resource_facts(kubeconfig_path: String, namespace: String, name: String, context: Option<String>) -> Result<ResourceFacts, String>;
#[tauri::command] pub fn evaluate_resources(facts: ResourceFacts, proposal: Proposal) -> Evaluation;
#[tauri::command] pub async fn apply_resources(kubeconfig_path: String, namespace: String, name: String, proposal: Proposal, seen: SeenState, dry_run: bool, context: Option<String>) -> Result<Evaluation, String>;
#[tauri::command] pub async fn clear_resources_override(kubeconfig_path: String, namespace: String, name: String, context: Option<String>) -> Result<(), String>;
```

```ts
export function resourceFacts(kubeconfigPath: string, namespace: string, name: string, context?: string): Promise<ResourceFacts>;
export function evaluateResources(facts: ResourceFacts, proposal: ResourceProposal): Promise<ResourceEvaluation>;
export function applyResources(kubeconfigPath: string, namespace: string, name: string, proposal: ResourceProposal, seen: SeenState, dryRun: boolean, context?: string): Promise<ResourceEvaluation>;
export function clearResourcesOverride(kubeconfigPath: string, namespace: string, name: string, context?: string): Promise<void>;
```

The TypeScript types mirror the Rust ones field for field (snake_case fields, `Fact<T>` as `{ state: "known"; value: T } | { state: "missing"; reason: string }`, enums as string unions).

Errors: a `KubeconfigError::ClientError { reason }` reaches the frontend as `reason` alone (as `apply_resource_yaml` does), through one helper `fn reason(e: KubeconfigError) -> String` in `limits.rs`.

- [ ] **Step 1: Write the failing tests**

```rust
// commands/limits.rs
#[test] fn a_client_error_reaches_the_user_without_its_prefix() {
    assert_eq!(reason(KubeconfigError::ClientError { reason: "Nothing to change.".into() }), "Nothing to change.");
}
#[test] fn facts_survive_the_round_trip_through_the_frontend() {
    // a ResourceFacts with one Known and one Missing part, a Proposal and a SeenState:
    // serde_json to string and back equals the original; evaluate_resources gives the same Evaluation before and after
}
#[test] fn the_payload_shape_the_frontend_types_rely_on() {
    // serde_json::to_value(Fact::<Vec<NodeFacts>>::Missing { reason: "x".into() }) == json!({"state":"missing","reason":"x"})
    // ProposalKind::Restore -> "restore"; FindingCode::W1r -> "w1r"; Level::NotChecked -> "not_checked"
}
```

```ts
// tauri.test.ts, in the file's existing style: each wrapper calls invoke with its command name and argument names
// ("resource_facts", "evaluate_resources", "apply_resources" with dryRun, "clear_resources_override"), context null when omitted
```

- [ ] **Step 2: Run** `cargo test -p cubelite-desktop limits` (the src-tauri package name as `cargo metadata` gives it) and `pnpm --filter desktop test -- tauri.test` — expected: fail.
- [ ] **Step 3: Implement** the commands, register the four in `generate_handler!`, add the types and wrappers.
- [ ] **Step 4: Run** `scripts/gates.sh --rust` (full, with e2e) — expected: exit 0, the e2e count unchanged from `main`.
- [ ] **Step 5: Commit** `feat(desktop): commands to check and apply a change of a deployment's resources`

`CHANGELOG.md` gets no line: nothing a user can see changes until the editor of delivery 3.
