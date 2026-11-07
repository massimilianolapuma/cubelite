# Resource kinds, phase 1: core discovery, Table lists and dynamic YAML — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cubelite-core` can discover every listable resource type a cluster serves, list any of them as the API server's Table (the `kubectl get` columns), and fetch any one object as clean YAML; the desktop backend exposes the three as Tauri commands.

**Architecture:** One new core module, `crates/cubelite-core/src/dynamic.rs`, adds methods to `KubeClient` that speak to the API server through raw `http::Request`s (`client.request::<T>()`), with our own serde types for the aggregated discovery v2 document and the `meta.k8s.io/v1` Table. Legacy discovery falls back to `kube::Discovery`. Three thin Tauri commands wrap them. No frontend changes in this phase.

**Tech Stack:** Rust, kube 4.2 (`client`, `runtime`), k8s-openapi 0.28, serde/serde_json/serde_yaml, tower-test for the mock API server, Tauri v2.

**Spec:** `docs/superpowers/specs/2026-11-07-sidebar-resources-profiles-design.md` (§5.1, §5.4, §9 phase 1).

## Global Constraints

- No `unwrap()` / `expect()` outside `#[cfg(test)]` and `tests/` (AGENTS.md).
- Errors are `KubeconfigError::ClientError { reason }`; a 403 from the API server must keep `403` or `Forbidden` in `reason` so the desktop's `isForbiddenError` matches (spec §5.1 RBAC resilience).
- Aggregated discovery request: `GET /api` and `GET /apis` with `Accept: application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList`; fall back to legacy discovery when the server answers 406, 404 or a body that is not an `APIGroupDiscoveryList` (spec §5.4).
- Table request: `Accept: application/json;as=Table;v=v1;g=meta.k8s.io`, query `includeObject=Metadata&limit=500`, following `metadata.continue` (spec §5.1).
- Columns returned to callers: only `priority == 0` (spec §5.1).
- Only types whose `verbs` include `list` and whose resource name has no `/` (subresources) are returned by discovery.
- Live checks only with `--context minikube` / `CUBELITE_LIVE_CONTEXT=minikube`; never touch AKS contexts; never `kubectl config use-context`.
- Gates before each commit: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- --deny warnings`, `cargo test --workspace`.

## Review Focus

1. A namespaced type asked with `namespace: None` must list all namespaces (`/apis/{g}/{v}/{plural}`), and a cluster-scoped type must ignore a namespace given to it — Task 3 tests both paths.
2. A list longer than one page (`metadata.continue` set) must return every row, in order — Task 3 test with two pages.
3. A Table with zero rows still returns its columns (the list shows headers, not an error) — Task 3 test.
4. The core group (`""`, served at `/api/v1`) and named groups (`/apis/{group}/{version}`) must build different URLs for the Table and the YAML — Tasks 3 and 4 test both.
5. A 403 on the Table or the YAML must surface as an error whose text contains `403` — Tasks 3 and 4 test it.

---

## File Structure

- Create `crates/cubelite-core/src/dynamic.rs` — types (`ResourceKindInfo`, `ResourceRef`, `TableColumn`, `TableRow`, `ResourceTable`), parsing of discovery and Table documents, and the three `impl KubeClient` methods.
- Modify `crates/cubelite-core/src/lib.rs` — `pub mod dynamic;` and re-export the five types.
- Modify `crates/cubelite-core/src/client.rs` — add `pub(crate) fn from_client(client: Client) -> Self`; move the test-only `mock_client` + `Seen` into `test_support.rs`.
- Modify `crates/cubelite-core/src/test_support.rs` — host `mock_client` / `Seen` as `pub(crate)` for both modules' tests.
- Create `crates/cubelite-core/tests/live_dynamic.rs` — ignored live check on minikube.
- Modify `apps/desktop/src-tauri/src/commands/kubernetes.rs` and `apps/desktop/src-tauri/src/lib.rs` — three commands, registered.

---

### Task 1: Discovery types and the aggregated-discovery parser

**Files:**
- Create: `crates/cubelite-core/src/dynamic.rs`
- Modify: `crates/cubelite-core/src/lib.rs`, `crates/cubelite-core/src/client.rs`, `crates/cubelite-core/src/test_support.rs`

**Interfaces:**
- Produces:
  ```rust
  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  pub struct ResourceKindInfo {
      pub group: String,        // "" for the core group
      pub version: String,      // the group's preferred (first listed) version
      pub kind: String,         // e.g. "HorizontalPodAutoscaler"
      pub plural: String,       // e.g. "horizontalpodautoscalers"
      pub namespaced: bool,
      pub short_names: Vec<String>,
  }
  pub(crate) fn parse_aggregated(doc: &serde_json::Value) -> Option<Vec<ResourceKindInfo>>;
  impl KubeClient { pub(crate) fn from_client(client: kube::Client) -> Self; }
  // test_support.rs
  pub(crate) struct Seen { pub method: http::Method, pub uri: String, pub accept: Option<String>, pub body: serde_json::Value }
  pub(crate) fn mock_client(respond: impl Fn(&http::Method, &str) -> (http::StatusCode, serde_json::Value) + Send + 'static)
      -> (KubeClient, tokio::task::JoinHandle<Vec<Seen>>);
  ```
  `Seen` gains `accept` (the request's `Accept` header) next to the fields `client.rs` already records; keep `content_type` too if `client.rs` tests use it.

- [ ] **Step 1: Move `mock_client` / `Seen` to `test_support.rs`, add `accept`, add `from_client`; run `cargo test -p cubelite-core` — every existing test still passes.**

- [ ] **Step 2: Write the failing tests in `dynamic.rs` `mod tests`**

```rust
#[test]
fn parse_aggregated_reads_kinds_with_the_preferred_version() {
    let apis = serde_json::json!({
        "kind": "APIGroupDiscoveryList", "apiVersion": "apidiscovery.k8s.io/v2",
        "items": [{
            "metadata": {"name": "autoscaling"},
            "versions": [
                {"version": "v2", "resources": [{
                    "resource": "horizontalpodautoscalers", "scope": "Namespaced",
                    "responseKind": {"group": "autoscaling", "version": "v2", "kind": "HorizontalPodAutoscaler"},
                    "shortNames": ["hpa"], "verbs": ["get", "list", "watch"],
                    "subresources": [{"subresource": "status"}]
                }]},
                {"version": "v1", "resources": [{
                    "resource": "horizontalpodautoscalers", "scope": "Namespaced",
                    "responseKind": {"group": "autoscaling", "version": "v1", "kind": "HorizontalPodAutoscaler"},
                    "verbs": ["get", "list"]
                }]}
            ]
        }]
    });
    let kinds = parse_aggregated(&apis).expect("aggregated");
    assert_eq!(kinds, vec![ResourceKindInfo {
        group: "autoscaling".into(), version: "v2".into(), kind: "HorizontalPodAutoscaler".into(),
        plural: "horizontalpodautoscalers".into(), namespaced: true, short_names: vec!["hpa".into()],
    }]);
}

#[test]
fn parse_aggregated_skips_unlistable_and_reads_the_core_group() {
    let core = serde_json::json!({
        "kind": "APIGroupDiscoveryList", "apiVersion": "apidiscovery.k8s.io/v2",
        "items": [{"metadata": {}, "versions": [{"version": "v1", "resources": [
            {"resource": "namespaces", "scope": "Cluster",
             "responseKind": {"group": "", "version": "v1", "kind": "Namespace"}, "shortNames": ["ns"], "verbs": ["list"]},
            {"resource": "bindings", "scope": "Namespaced",
             "responseKind": {"group": "", "version": "v1", "kind": "Binding"}, "verbs": ["create"]}
        ]}]}]
    });
    let kinds = parse_aggregated(&core).expect("aggregated");
    assert_eq!(kinds.len(), 1);
    assert_eq!((kinds[0].group.as_str(), kinds[0].kind.as_str(), kinds[0].namespaced), ("", "Namespace", false));
}

#[test]
fn parse_aggregated_rejects_a_legacy_document() {
    let legacy = serde_json::json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []});
    assert_eq!(parse_aggregated(&legacy), None);
}
```

- [ ] **Step 3: Run `cargo test -p cubelite-core dynamic::` — FAIL (`parse_aggregated` not defined).**

- [ ] **Step 4: Implement the types and `parse_aggregated` in `dynamic.rs`; add `pub mod dynamic;` and re-export `ResourceKindInfo` from `lib.rs`.** `None` unless `kind == "APIGroupDiscoveryList"`; per item, only the first entry of `versions`; a group name missing from `metadata` means `""`; skip resources without `list` in `verbs`; kinds sorted by `(group, kind)`.

- [ ] **Step 5: Run `cargo test -p cubelite-core dynamic::` — PASS; then the gates.**

- [ ] **Step 6: Commit** — `feat(core): parse aggregated API discovery`

### Task 2: `discover_kinds` with the legacy fallback

**Files:** Modify `crates/cubelite-core/src/dynamic.rs`

**Interfaces:**
- Consumes: Task 1's `ResourceKindInfo`, `parse_aggregated`, `mock_client`.
- Produces: `impl KubeClient { pub async fn discover_kinds(&self) -> Result<Vec<ResourceKindInfo>, KubeconfigError>; }` — the concatenation of `/api` and `/apis`, sorted by `(group, kind)`.

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn discover_kinds_asks_for_aggregated_discovery_on_api_and_apis() {
    let (client, seen) = mock_client(|_, uri| match uri {
        "/api" => (StatusCode::OK, core_doc()),   // fixture fns returning Task 1's documents
        "/apis" => (StatusCode::OK, apis_doc()),
        other => panic!("unexpected {other}"),
    });
    let kinds = client.discover_kinds().await.expect("discover");
    assert_eq!(kinds.iter().map(|k| k.kind.as_str()).collect::<Vec<_>>(), vec!["Namespace", "HorizontalPodAutoscaler"]);
    drop(client);
    let seen = seen.await.expect("seen");
    assert!(seen.iter().all(|s| s.accept.as_deref()
        == Some("application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList")));
}

#[tokio::test]
async fn discover_kinds_falls_back_to_legacy_discovery_on_406() {
    // /api and /apis answer 406 to the aggregated Accept; the legacy documents
    // (APIVersions, APIGroupList, APIResourceList per group/version) follow.
    // Assert the same two kinds come back, HPA at the group's preferredVersion.
}

#[tokio::test]
async fn discover_kinds_reports_403() {
    let (client, _seen) = mock_client(|_, _| (StatusCode::FORBIDDEN,
        serde_json::json!({"kind": "Status", "code": 403, "reason": "Forbidden", "message": "forbidden"})));
    let err = client.discover_kinds().await.expect_err("403");
    assert!(err.to_string().contains("403") || err.to_string().contains("orbidden"));
}
```

- [ ] **Step 2: Run them — FAIL.**

- [ ] **Step 3: Implement `discover_kinds`.** Aggregated: `http::Request::get(path).header(ACCEPT, …)` via `self.client().request::<serde_json::Value>()`, `parse_aggregated` on both. Fallback (406, 404, or `parse_aggregated` → `None`): `kube::Discovery::new(self.client()).run().await`, then for each group its `preferred_version_or_latest()` resources whose `capabilities.operations` include list, mapped to `ResourceKindInfo` (`short_names` empty when kube does not expose them). Map errors with the existing `KubeconfigError::ClientError { reason: e.to_string() }`, keeping kube's status text.

- [ ] **Step 4: Run — PASS; gates.**

- [ ] **Step 5: Commit** — `feat(core): discover the cluster's resource kinds`

### Task 3: `list_table` — any type as the API server's Table

**Files:** Modify `crates/cubelite-core/src/dynamic.rs`, `crates/cubelite-core/src/lib.rs`

**Interfaces:**
- Produces:
  ```rust
  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  pub struct ResourceRef { pub group: String, pub version: String, pub plural: String, pub namespaced: bool }
  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  pub struct TableColumn { pub name: String, pub column_type: String, pub format: String, pub description: String }
  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  pub struct TableRow { pub name: String, pub namespace: Option<String>, pub creation_timestamp: Option<String>, pub cells: Vec<serde_json::Value> }
  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  pub struct ResourceTable { pub columns: Vec<TableColumn>, pub rows: Vec<TableRow> }
  pub(crate) fn resource_path(r: &ResourceRef, namespace: Option<&str>) -> String;
  impl KubeClient {
      pub async fn list_table(&self, resource: &ResourceRef, namespace: Option<&str>) -> Result<ResourceTable, KubeconfigError>;
  }
  ```
  `cells` keep only the `priority == 0` columns, in the same order as `columns`. Re-export the four types from `lib.rs`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn resource_path_covers_core_named_namespaced_and_cluster_scope() {
    let pods = ResourceRef { group: "".into(), version: "v1".into(), plural: "pods".into(), namespaced: true };
    let hpa = ResourceRef { group: "autoscaling".into(), version: "v2".into(), plural: "horizontalpodautoscalers".into(), namespaced: true };
    let pv = ResourceRef { group: "".into(), version: "v1".into(), plural: "persistentvolumes".into(), namespaced: false };
    assert_eq!(resource_path(&pods, Some("shop")), "/api/v1/namespaces/shop/pods");
    assert_eq!(resource_path(&pods, None), "/api/v1/pods");
    assert_eq!(resource_path(&hpa, Some("shop")), "/apis/autoscaling/v2/namespaces/shop/horizontalpodautoscalers");
    assert_eq!(resource_path(&pv, Some("shop")), "/api/v1/persistentvolumes");
}

#[tokio::test]
async fn list_table_keeps_priority_zero_columns_and_reads_row_metadata() {
    // One page: columnDefinitions Name(p0), Reference(p0), Targets(p0), Age(p0), Selector(p1);
    // one row with cells for all five and object.metadata {name:"web", namespace:"shop",
    // creationTimestamp:"2026-11-01T10:00:00Z"}.
    // Assert columns names == ["Name","Reference","Targets","Age"], row.cells.len() == 4,
    // row.name == "web", row.namespace == Some("shop"), creation_timestamp set,
    // and the request carried Accept "application/json;as=Table;v=v1;g=meta.k8s.io"
    // and a query with includeObject=Metadata and limit=500.
}

#[tokio::test]
async fn list_table_follows_continue_tokens() {
    // Page 1 metadata.continue = "abc", rows ["a"]; page 2 (uri contains "continue=abc") rows ["b"].
    // Assert row names == ["a", "b"] and exactly two requests.
}

#[tokio::test]
async fn list_table_with_no_rows_still_returns_columns() {
    // rows: [] → columns.len() > 0, rows empty, Ok.
}

#[tokio::test]
async fn list_table_reports_403() { /* as Task 2's 403 test, on list_table */ }
```

- [ ] **Step 2: Run them — FAIL.**

- [ ] **Step 3: Implement `resource_path` and `list_table`.** Deserialize pages into private serde mirrors of `meta.k8s.io/v1` `Table` (`columnDefinitions[].{name,type,format,description,priority}`, `rows[].{cells, object.metadata.{name,namespace,creationTimestamp}}`, `metadata.continue`); columns from the first page; concatenate rows; percent-encode the continue token in the query.

- [ ] **Step 4: Run — PASS; gates.**

- [ ] **Step 5: Commit** — `feat(core): list any resource type as a Table`

### Task 4: `get_dynamic_yaml`

**Files:** Modify `crates/cubelite-core/src/dynamic.rs`

**Interfaces:**
- Consumes: Task 3's `ResourceRef`, `resource_path`; `client.rs`'s `to_clean_yaml` (make it `pub(crate)`).
- Produces: `impl KubeClient { pub async fn get_dynamic_yaml(&self, resource: &ResourceRef, namespace: Option<&str>, name: &str) -> Result<String, KubeconfigError>; }`

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn get_dynamic_yaml_fetches_the_object_and_strips_managed_fields() {
    // GET /apis/policy/v1/namespaces/shop/poddisruptionbudgets/web → object with metadata.managedFields.
    // Assert the YAML contains "name: web" and not "managedFields", and the request URI was exactly that path.
}

#[tokio::test]
async fn get_dynamic_yaml_of_a_cluster_scoped_core_type() {
    // GET /api/v1/persistentvolumes/pv-1 (namespace Some("shop") ignored).
}

#[tokio::test]
async fn get_dynamic_yaml_reports_403() { /* 403 text check */ }
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement**: `GET {resource_path(resource, namespace)}/{name}` as `serde_json::Value`, then `to_clean_yaml`.
- [ ] **Step 4: Run — PASS; gates.**
- [ ] **Step 5: Commit** — `feat(core): fetch any resource as YAML`

### Task 5: Tauri commands and the live check

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/kubernetes.rs`, `apps/desktop/src-tauri/src/lib.rs`
- Create: `crates/cubelite-core/tests/live_dynamic.rs`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces (Tauri, all `Result<_, String>`, same shape as `list_statefulsets`):
  ```rust
  #[tauri::command] pub async fn discover_resource_kinds(kubeconfig_path: String, context: Option<String>) -> Result<Vec<ResourceKindInfo>, String>;
  #[tauri::command] pub async fn list_resource_table(kubeconfig_path: String, resource: ResourceRef, namespace: Option<String>, context: Option<String>) -> Result<ResourceTable, String>;
  #[tauri::command] pub async fn get_dynamic_resource_yaml(kubeconfig_path: String, resource: ResourceRef, namespace: Option<String>, name: String, context: Option<String>) -> Result<String, String>;
  ```
  Registered in `lib.rs`'s `invoke_handler`. Phase 2 adds the TypeScript bindings.

- [ ] **Step 1: Add the commands and register them; `cargo build -p cubelite-desktop` and `cargo clippy --workspace --all-targets -- --deny warnings` pass.**

- [ ] **Step 2: Write `tests/live_dynamic.rs`** — `#[ignore]`d, gated on `CUBELITE_LIVE_CONTEXT` like `live_integrations.rs` (returns early when unset):
  - `discover_kinds` contains `("apps","Deployment")`, `("autoscaling","HorizontalPodAutoscaler")` with version `v2`, `("rbac.authorization.k8s.io","ClusterRole")` cluster-scoped, and at least one CRD kind (`monitoring.coreos.com` `ServiceMonitor` on this minikube).
  - `list_table` for `clusterroles` (cluster-scoped, `None`) returns ≥1 row and a `Name` column; for `pods` in `kube-system` every row's namespace is `kube-system`.
  - `get_dynamic_yaml` of the first ClusterRole returned contains `kind: ClusterRole`.

- [ ] **Step 3: Run it** — `CUBELITE_LIVE_CONTEXT=minikube cargo test -p cubelite-core --test live_dynamic -- --ignored --nocapture` — PASS. (Without the variable: the tests return early and pass.)

- [ ] **Step 4: Gates, then commit** — `feat(desktop): Tauri commands for discovery, Table lists and YAML`

---

Self-review: spec §5.1 (Table, priority-0 columns, name/age from metadata, 403, YAML read-only), §5.4 (aggregated discovery + legacy fallback, preferred version, short names, CRD kinds included) and §9 phase 1 are covered by Tasks 1–5. Greying, counts, the registry and every UI concern are phase 2+.
