# Resource kinds — phase 2: desktop data + generic list — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The 18 ★ resource types of spec §4 open in the desktop app as one generic list with `kubectl get`'s columns and a read-only YAML drawer, with sidebar counts and greying for types the cluster does not serve.

**Architecture:** A pure kind registry (`resource-kinds.ts`) describes the ★ types as data. A new store (`dynamic.svelte.ts`) runs discovery once per context on connect, picks the served version, loads Tables on demand and exposes counts. One component (`GenericKindView.svelte`) renders any ★ type from the Table the core returns (phase 1, #577). The sidebar keeps today's layout and just gains the new sections (Storage, Access Control) and rows; phase 3 replaces the layout.

**Tech Stack:** Svelte 5 runes, TypeScript, Vitest + Testing Library, Playwright (Tauri IPC mock), Tauri commands from phase 1.

**Spec:** `docs/superpowers/specs/2026-11-07-sidebar-resources-profiles-design.md` (§4, §5.1, §5.2, §5.4, §9 phase 2).

## Global Constraints

- Phase 1 commands, unchanged: `discover_resource_kinds(kubeconfigPath, context)`, `list_resource_table(kubeconfigPath, resource, namespace, context)`, `get_dynamic_resource_yaml(kubeconfigPath, resource, namespace, name, context)`. Rust structs serialize with snake_case fields (`short_names`, `column_type`, `creation_timestamp`).
- Only the ★ types use the generic list; the existing hand-written views stay as they are (spec §5.1).
- The ★ types are read-only: YAML view only, no Edit/Apply (spec §2 non-goals).
- No watches for the ★ types: they load when opened and on the refresh interval (spec §2).
- No list loads until a list is opened; the only extra request is discovery, one per context on connect (spec §2 anti-goals, §5.4).
- Discovery is cached per context for the session; the manual retry (`clusters.retry()`) refreshes it (spec §5.4).
- Cluster-scoped types ignore the namespace selector and say "cluster-scoped" in the list header (spec §4).
- A type discovery does not report shows "Not available on this cluster" and is greyed in the sidebar (spec §5.1).
- Sort: Name, Namespace (namespaced types only), Age through `lists`/`SortHeader`/`GroupedRows`; server columns are not sortable (spec §5.1).
- Name and Age use CubeLite's own cells (`formatAge`); other `type: date` cells render with `formatAge`; other cells as text (spec §5.1).
- Section dots, from the approved mockup: Storage `var(--color-cluster-teal)`, Access Control `var(--color-cluster-pink)`. Colours only through tokens (design-lint).
- **Do not release after this phase** (spec §9): CHANGELOG entry goes under `## [Unreleased]`, no version bump.
- Commits: Conventional Commits, no Claude attribution. Branch `feat/578-resource-kinds-desktop` from `main`, issue #578.
- Quality gates before each commit: `pnpm --filter desktop lint`, `pnpm --filter desktop test`; before the PR also `pnpm --filter desktop test:e2e` (first cold run may flake 2 tests in `app.spec.ts`; rerun warm).

## Review Focus

1. **Switching between two ★ views** (DaemonSets → ReplicaSets) reuses the same component instance (only the `view` prop changes): the filter text and the open drawer of the first must not carry over (Task 3 test `filter and drawer reset when the kind changes`).
2. **Namespace changed while a Table load is in flight**: the late answer for the old namespace must not be committed as the new namespace's rows or count (Task 2 test `drops a late answer after the namespace changed`).
3. **Discovery of cluster A answering after the switch to B** is cached under A only; B's types are not greyed by A's answer (Task 2 test `caches discovery per context`).
4. **Discovery failing, or a Tauri mock that does not define the new exports** (most existing Vitest files mock `#lib/tauri.ts` with an explicit list; the e2e mock returns `null` for unknown commands): nothing greys, lists use the registry's default version, no unhandled rejection (Task 2 tests `failed discovery greys nothing` and `a null discovery answer counts as failed`).
5. **Table cells of unexpected JSON types** (null, number, boolean, array, object) render as readable text, never `[object Object]` (Task 3 test `cellText renders every JSON type`).

---

### Task 1: Tauri bindings and the kind registry

**Files:**
- Modify: `apps/desktop/src/lib/tauri.ts` (after `applyResourceYaml`)
- Create: `apps/desktop/src/lib/resource-kinds.ts`
- Test: `apps/desktop/src/lib/tauri.test.ts`, `apps/desktop/src/lib/resource-kinds.test.ts`

**Interfaces:**
- Produces (tauri.ts):
  ```ts
  export interface ResourceKindInfo { group: string; version: string; kind: string; plural: string; namespaced: boolean; short_names: string[] }
  export interface ResourceRef { group: string; version: string; plural: string; namespaced: boolean }
  export interface TableColumn { name: string; column_type: string; format: string; description: string }
  export interface TableRow { name: string; namespace: string | null; creation_timestamp: string | null; cells: unknown[] }
  export interface ResourceTable { columns: TableColumn[]; rows: TableRow[] }
  export function discoverResourceKinds(kubeconfigPath: string, context?: string): Promise<ResourceKindInfo[]>
  export function listResourceTable(kubeconfigPath: string, resource: ResourceRef, namespace?: string, context?: string): Promise<ResourceTable>
  export function getDynamicResourceYaml(kubeconfigPath: string, resource: ResourceRef, namespace: string | undefined, name: string, context?: string): Promise<string>
  ```
- Produces (resource-kinds.ts):
  ```ts
  export const GENERIC_VIEWS: readonly [...]  // the 18 ids below, in this order
  export type GenericView = (typeof GENERIC_VIEWS)[number];
  export interface GenericKind { label: string; nouns: readonly [string, string]; group: string; version: string; kind: string; plural: string; namespaced: boolean; shortNames: readonly string[] }
  export const GENERIC_KINDS: Record<GenericView, GenericKind>;
  export function isGenericView(v: unknown): v is GenericView;
  ```
  `resource-kinds.ts` must not import any store (it is imported by `app.svelte.ts`).

Registry values (id · label · nouns · group · default version · kind · plural · namespaced · shortNames). Labels follow the approved mockup:

| id | label | nouns | group | ver | kind | plural | ns | short |
|---|---|---|---|---|---|---|---|---|
| namespaces | Namespaces | namespace/namespaces | `""` | v1 | Namespace | namespaces | no | ns |
| daemonsets | DaemonSets | daemon set/daemon sets | apps | v1 | DaemonSet | daemonsets | yes | ds |
| replicasets | ReplicaSets | replica set/replica sets | apps | v1 | ReplicaSet | replicasets | yes | rs |
| hpas | Autoscalers | autoscaler/autoscalers | autoscaling | v2 | HorizontalPodAutoscaler | horizontalpodautoscalers | yes | hpa |
| ingressclasses | Ingress Classes | ingress class/ingress classes | networking.k8s.io | v1 | IngressClass | ingressclasses | no | — |
| endpointslices | EndpointSlices | endpoint slice/endpoint slices | discovery.k8s.io | v1 | EndpointSlice | endpointslices | yes | — |
| networkpolicies | Network Policies | network policy/network policies | networking.k8s.io | v1 | NetworkPolicy | networkpolicies | yes | netpol |
| pvs | Persistent Volumes | persistent volume/persistent volumes | `""` | v1 | PersistentVolume | persistentvolumes | no | pv |
| storageclasses | Storage Classes | storage class/storage classes | storage.k8s.io | v1 | StorageClass | storageclasses | no | sc |
| resourcequotas | Resource Quotas | resource quota/resource quotas | `""` | v1 | ResourceQuota | resourcequotas | yes | quota |
| limitranges | Limit Ranges | limit range/limit ranges | `""` | v1 | LimitRange | limitranges | yes | limits |
| pdbs | Disruption Budgets | disruption budget/disruption budgets | policy | v1 | PodDisruptionBudget | poddisruptionbudgets | yes | pdb |
| priorityclasses | Priority Classes | priority class/priority classes | scheduling.k8s.io | v1 | PriorityClass | priorityclasses | no | pc |
| serviceaccounts | Service Accounts | service account/service accounts | `""` | v1 | ServiceAccount | serviceaccounts | yes | sa |
| roles | Roles | role/roles | rbac.authorization.k8s.io | v1 | Role | roles | yes | — |
| rolebindings | Role Bindings | role binding/role bindings | rbac.authorization.k8s.io | v1 | RoleBinding | rolebindings | yes | — |
| clusterroles | Cluster Roles | cluster role/cluster roles | rbac.authorization.k8s.io | v1 | ClusterRole | clusterroles | no | — |
| clusterrolebindings | Cluster Role Bindings | cluster role binding/cluster role bindings | rbac.authorization.k8s.io | v1 | ClusterRoleBinding | clusterrolebindings | no | — |

- [ ] **Step 1: Write the failing tests**

`tauri.test.ts` (same style as the `listPods` tests):
```ts
it("discoverResourceKinds invokes discover_resource_kinds", async () => {
  mockedInvoke.mockResolvedValueOnce([]);
  await discoverResourceKinds("/k", "prod");
  expect(mockedInvoke).toHaveBeenCalledWith("discover_resource_kinds", { kubeconfigPath: "/k", context: "prod" });
});
it("listResourceTable passes the resource and a null namespace for all namespaces", async () => {
  const resource = { group: "apps", version: "v1", plural: "daemonsets", namespaced: true };
  mockedInvoke.mockResolvedValueOnce({ columns: [], rows: [] });
  await listResourceTable("/k", resource, undefined, "prod");
  expect(mockedInvoke).toHaveBeenCalledWith("list_resource_table", { kubeconfigPath: "/k", resource, namespace: null, context: "prod" });
});
it("getDynamicResourceYaml passes namespace and name", async () => {
  const resource = { group: "", version: "v1", plural: "serviceaccounts", namespaced: true };
  mockedInvoke.mockResolvedValueOnce("kind: ServiceAccount");
  await getDynamicResourceYaml("/k", resource, "default", "builder", "prod");
  expect(mockedInvoke).toHaveBeenCalledWith("get_dynamic_resource_yaml", { kubeconfigPath: "/k", resource, namespace: "default", name: "builder", context: "prod" });
});
```
`resource-kinds.test.ts`:
```ts
it("lists the 18 types of spec §4", () => {
  expect(GENERIC_VIEWS).toHaveLength(18);
  expect(Object.keys(GENERIC_KINDS).sort()).toEqual([...GENERIC_VIEWS].sort());
});
it("uses the preferred versions and scopes of spec §5.4", () => {
  expect(GENERIC_KINDS.hpas).toMatchObject({ group: "autoscaling", version: "v2", label: "Autoscalers" });
  expect(GENERIC_KINDS.pdbs).toMatchObject({ group: "policy", version: "v1", label: "Disruption Budgets" });
  expect(GENERIC_KINDS.clusterroles.namespaced).toBe(false);
  expect(GENERIC_KINDS.roles.namespaced).toBe(true);
});
it("does not collide with the hand-written views", () => {
  for (const v of ["pods", "deployments", "pvcs", "nodes", "overview"]) expect(isGenericView(v)).toBe(false);
  expect(isGenericView("daemonsets")).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter desktop exec vitest run src/lib/tauri.test.ts src/lib/resource-kinds.test.ts`
Expected: FAIL — the new exports and the module do not exist.

- [ ] **Step 3: Implement the bindings and the registry** (values from the table above; `invoke` arguments with `?? null` like `getResourceYaml`).

- [ ] **Step 4: Run to verify they pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/tauri.ts apps/desktop/src/lib/tauri.test.ts apps/desktop/src/lib/resource-kinds.ts apps/desktop/src/lib/resource-kinds.test.ts
git commit -m "feat(desktop): bindings for discovery and Table lists, registry of the new kinds"
```

---

### Task 2: The dynamic store (discovery cache, Table loads, counts)

**Files:**
- Create: `apps/desktop/src/lib/stores/dynamic.svelte.ts`
- Modify: `apps/desktop/src/lib/stores/clusters.svelte.ts` (`switchCluster` after `ok`, `retry`)
- Modify: `apps/desktop/src/lib/stores/resources.svelte.ts` (`load()` refresh branch, `clear()`)
- Test: `apps/desktop/src/lib/stores/dynamic.svelte.test.ts`

**Interfaces:**
- Consumes: Task 1 bindings, `GENERIC_KINDS`, `GenericView`; `app.kubeconfigPath`, `app.activeCluster`, `app.namespace`; `errorMessage`.
- Produces:
  ```ts
  class DynamicStore {
    tables: Partial<Record<GenericView, ResourceTable>>;      // $state
    errors: Partial<Record<GenericView, string>>;             // $state
    loading: Partial<Record<GenericView, boolean>>;           // $state
    discover(context: string, force?: boolean): Promise<void>; // never rejects
    isUnavailable(view: GenericView): boolean;   // true only when the active context's discovery is known and lacks the kind
    refFor(view: GenericView): ResourceRef;      // discovered version/scope, else the registry's
    load(view: GenericView): Promise<void>;      // never rejects
    count(view: GenericView): number | null;
    clear(): void;                               // tables/loaded/errors; keeps the discovery cache
  }
  export const dynamic: DynamicStore;
  ```

Behaviour the tests pin:
- Discovery cache keyed by context name. `discover` skips when cached unless `force`; it keeps the in-flight promise per context, and `load` awaits the active context's in-flight discovery (errors swallowed) before choosing the version. A rejected call or a non-array answer leaves the context uncached.
- Matching a kind: same `group` and `plural` (the core returns the preferred version first).
- `load(view)`: does nothing without kubeconfig/cluster or when `isUnavailable(view)`; cluster-scoped kinds load with `namespace` undefined; a per-view sequence number plus an epoch bumped by `clear()` drop late answers; on success records the namespace it loaded for (null = all); on failure stores `errorMessage(e)` in `errors[view]` (the view shows it, so 403 shows the existing "forbidden" text).
- `count(view)`: null when not loaded; for namespaced kinds null when loaded for another namespace than `app.namespace`; else `tables[view].rows.length`.
- Wiring: `switchCluster` calls `void dynamic.discover(name)` next to `integrations.detect`; `retry` calls `void dynamic.discover(app.activeCluster, true)`; `resources.load()` refreshes an open ★ view (`else if (isGenericView(app.view)) void dynamic.load(app.view)`); `resources.clear()` calls `dynamic.clear()`.

- [ ] **Step 1: Write the failing tests** (`vi.mock("#lib/tauri.ts", () => ({ discoverResourceKinds: vi.fn(), listResourceTable: vi.fn() }))`; set `app.kubeconfigPath`, `app.activeCluster = "prod"`, `app.namespace = null`; `dynamic.clear()` and reset the cache between tests — expose nothing extra: use distinct context names per test)

```ts
it("caches discovery per context", async () => {
  discover.mockResolvedValueOnce([{ group: "apps", version: "v1", kind: "DaemonSet", plural: "daemonsets", namespaced: true, short_names: ["ds"] }]);
  await dynamic.discover("a");
  await dynamic.discover("a");
  expect(discover).toHaveBeenCalledTimes(1);
  app.activeCluster = "b";
  expect(dynamic.isUnavailable("daemonsets")).toBe(false);   // b unknown
  app.activeCluster = "a";
  expect(dynamic.isUnavailable("daemonsets")).toBe(false);
  expect(dynamic.isUnavailable("storageclasses")).toBe(true);
});
it("force refreshes the cache", async () => { /* discover("c") twice, second with force → 2 calls */ });
it("failed discovery greys nothing and uses the registry version", async () => {
  discover.mockRejectedValueOnce(new Error("boom"));
  await dynamic.discover("d");
  app.activeCluster = "d";
  expect(dynamic.isUnavailable("hpas")).toBe(false);
  expect(dynamic.refFor("hpas")).toEqual({ group: "autoscaling", version: "v2", plural: "horizontalpodautoscalers", namespaced: true });
});
it("a null discovery answer counts as failed", async () => { /* resolves null → isUnavailable false, and a later discover("e") calls again */ });
it("picks the discovered version", async () => { /* discovery reports autoscaling/v1 horizontalpodautoscalers → refFor("hpas").version === "v1" */ });
it("loads a cluster-scoped kind without namespace and counts it in any namespace", async () => {
  app.namespace = "team-a";
  table.mockResolvedValueOnce({ columns: [], rows: [{ name: "fast", namespace: null, creation_timestamp: null, cells: [] }] });
  await dynamic.load("storageclasses");
  expect(table).toHaveBeenCalledWith("/k", expect.objectContaining({ plural: "storageclasses", namespaced: false }), undefined, "prod");
  expect(dynamic.count("storageclasses")).toBe(1);
});
it("counts a namespaced kind only for the namespace it was loaded for", async () => { /* load with ns null → count 2; app.namespace = "x" → null */ });
it("drops a late answer after the namespace changed", async () => {
  let resolve!: (t: ResourceTable) => void;
  table.mockReturnValueOnce(new Promise((r) => (resolve = r)));
  const first = dynamic.load("roles");
  app.namespace = "b";
  table.mockResolvedValueOnce({ columns: [], rows: [] });
  await dynamic.load("roles");
  resolve({ columns: [], rows: [row("stale")] });
  await first;
  expect(dynamic.tables.roles?.rows).toEqual([]);
  expect(dynamic.count("roles")).toBe(0);
});
it("records the error and skips unavailable kinds", async () => { /* rejects "403 Forbidden" → errors.roles contains "Forbidden"; unavailable kind → listResourceTable not called */ });
it("waits for the in-flight discovery before loading", async () => { /* discovery pending for "prod" reporting autoscaling/v1; load("hpas") called before it resolves uses version v1 */ });
it("clear drops tables but keeps discovery", async () => { /* after clear: tables {}, count null, isUnavailable still from cache */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter desktop exec vitest run src/lib/stores/dynamic.svelte.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dynamic.svelte.ts`, then the wiring in `clusters.svelte.ts` and `resources.svelte.ts`.** `discover` and `load` wrap the whole body in try/catch (Review Focus 4: a missing mock export throws on access).

- [ ] **Step 4: Run the new file and the store suites**

Run: `pnpm --filter desktop exec vitest run src/lib/stores`
Expected: PASS, including the existing `clusters`/`resources` tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/stores
git commit -m "feat(desktop): discover served kinds per context and load any kind's Table"
```

---

### Task 3: The generic list and the YAML drawer

**Files:**
- Create: `apps/desktop/src/lib/table-columns.ts`, `apps/desktop/src/lib/table-columns.test.ts`
- Create: `apps/desktop/src/lib/components/views/GenericKindView.svelte`
- Create: `apps/desktop/src/lib/components/dynamic/ObjectYamlDrawer.svelte`
- Create: `apps/desktop/src/lib/components/views/generic-kind-view.test.ts`
- Modify: `apps/desktop/src/lib/stores/app.svelte.ts` (`VIEWS`, `selectedObject`)
- Modify: `apps/desktop/src/lib/components/views/index.ts` (registry entries)
- Modify: `apps/desktop/src/lib/components/ui/ListTitle.svelte`, `apps/desktop/src/lib/components/ui/GroupedRows.svelte` (`groupable` prop)

**Interfaces:**
- Consumes: Task 1 types and `GENERIC_KINDS`; Task 2 `dynamic`.
- Produces:
  ```ts
  // table-columns.ts
  export type ColumnPlan =
    | { kind: "name" } | { kind: "namespace" } | { kind: "age" }
    | { kind: "cell"; index: number; label: string; date: boolean };
  export function planColumns(columns: readonly TableColumn[], showNamespace: boolean): ColumnPlan[];
  export function cellText(value: unknown, date: boolean, now?: Date): string;
  export function gridTemplate(plan: readonly ColumnPlan[]): string; // "grid-template-columns: …;"
  // app.svelte.ts
  VIEWS = [...existing, ...GENERIC_VIEWS];
  selectedObject: { name: string; namespace: string | null } | null;  // $state; cleared by navigate, resetForClusterSwitch, closeTopOverlay
  // ListTitle / GroupedRows
  groupable?: boolean  // default true; false hides the group toggle / never groups
  ```

Column rules (`planColumns`): the column with `format === "name"` (else the first column named `Name`) becomes `name`; `namespace` goes right after it when `showNamespace`; a column named `Age` with `column_type === "date"` becomes `age`; every other column is a `cell` keeping its server index, with `date = column_type === "date"`. No server name column → `name` first. No `Age` column → no `age` (same as kubectl). Widths: name `minmax(0,3fr)`, namespace and cells `minmax(0,1fr)`, age `0.55fr`.

`cellText`: null/undefined → `""`; string with `date` → `formatAge(value, now)`; string → itself; number/boolean → `String(v)`; array → items through `cellText` joined `", "`; object → `JSON.stringify`.

`GenericKindView` (prop `view: GenericView`), top to bottom:
- `ListTitle` with `title = label`, `groupable = namespaced`; for cluster-scoped kinds the children render `<span class="type-caption text-text-tertiary">cluster-scoped</span>`.
- Filter input like PodsView's (`placeholder="Filter {nouns[1]}…"`, `aria-label="Filter {label}"`), local `$state`, case-insensitive substring on name; reset to `""` whenever `view` changes (`$effect.pre` reading `view`).
- States in order: `dynamic.isUnavailable(view)` → "Not available on this cluster"; `dynamic.errors[view]` → the error text (status-err, as ConfigMapsView); no table yet → "Loading…"; no rows → "No {nouns[1]} found."
- Header: `SortHeader list={view}` for Name, Namespace, Age; `<span class="type-colhead">` for cells.
- Rows through `GroupedRows` (`list={view}`, `groupable={namespaced}`, accessors name/namespace (`?? ""`)/created), each row a `<button type="button">` with the grid; click sets `app.selectedObject`.
- Loads with `$effect(() => { void [app.namespace, app.activeCluster]; void dynamic.load(view); })`.
- When `app.selectedObject` is set: `ObjectYamlDrawer` (uses `Drawer`, title = name; Copy button as in `YamlModal`; `<pre class="type-log …">`; fetches `getDynamicResourceYaml(kc, dynamic.refFor(view), namespace ?? undefined, name, cluster)`; no Edit button).

- [ ] **Step 1: Write the failing tests**

`table-columns.test.ts`:
```ts
const col = (name: string, column_type = "string", format = "") => ({ name, column_type, format, description: "" });
it("maps kubectl's DaemonSet columns", () => {
  const plan = planColumns([col("Name", "string", "name"), col("Desired", "integer"), col("Node Selector"), col("Age", "date")], true);
  expect(plan).toEqual([{ kind: "name" }, { kind: "namespace" }, { kind: "cell", index: 1, label: "Desired", date: false }, { kind: "cell", index: 2, label: "Node Selector", date: false }, { kind: "age" }]);
});
it("adds no Age column when the server has none", () => { /* CRD-like [Name(name), Ready] → no age */ });
it("puts name first when the server has no name column", () => { /* [Status] → [name, cell 0] */ });
it("cellText renders every JSON type", () => {
  expect(cellText(null, false)).toBe("");
  expect(cellText(3, false)).toBe("3");
  expect(cellText(true, false)).toBe("true");
  expect(cellText(["a", 1], false)).toBe("a, 1");
  expect(cellText({ a: 1 }, false)).toBe('{"a":1}');
  expect(cellText("2026-11-07T10:00:00Z", true, new Date("2026-11-07T12:00:00Z"))).toBe("2h");
});
```
(adjust `"2h"` to whatever `formatAge` returns for two hours — read `age.test.ts`.)

`generic-kind-view.test.ts` (mock `#lib/tauri.ts` with `listResourceTable`, `discoverResourceKinds`, `getDynamicResourceYaml`):
```ts
it("renders kubectl's columns and the rows", async () => { /* DaemonSet table → headers Name, Namespace, Desired, Node Selector, Age; row "fluent-bit" */ });
it("says cluster-scoped and hides the group toggle for cluster-scoped kinds", async () => { /* storageclasses → "cluster-scoped"; no "Group by namespace" button */ });
it("filters by name", async () => { /* type "flu" → only fluent-bit */ });
it("shows Not available on this cluster when discovery lacks the kind", async () => { /* listResourceTable not called */ });
it("shows the load error", async () => { /* rejects "403 Forbidden" → text visible */ });
it("opens the read-only YAML drawer on row click", async () => { /* click row → drawer dialog "fluent-bit" with "kind: DaemonSet"; no "Edit" button; getDynamicResourceYaml called with namespace "logging" */ });
it("filter and drawer reset when the kind changes", async () => { /* render daemonsets, type a filter, open a row; app.navigate("replicasets") + rerender({ view: "replicasets" }) → filter input empty, no drawer */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter desktop exec vitest run src/lib/table-columns.test.ts src/lib/components/views/generic-kind-view.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `table-columns.ts`, the two components, the `groupable` props, `VIEWS`/`selectedObject`, and the registry entries (`asEntry(GenericKindView, { view })` for each of `GENERIC_VIEWS`).**

- [ ] **Step 4: Run the whole desktop suite**

Run: `pnpm --filter desktop test && pnpm --filter desktop lint`
Expected: PASS (existing view tests untouched by the `groupable` default).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): one generic list with kubectl's columns and a read-only YAML drawer"
```

---

### Task 4: Sidebar sections, counts, greying, e2e

**Files:**
- Modify: `apps/desktop/src/lib/navigation.ts` (`SectionId`, `SECTION_TABLE`)
- Modify: `apps/desktop/src/lib/components/shell/Sidebar.svelte` (`countFor`, greying)
- Modify: `apps/desktop/tests/e2e/tauri-mock.ts`, Create: `apps/desktop/tests/e2e/resource-kinds.spec.ts`
- Modify: `CHANGELOG.md` (`## [Unreleased]` › `### Added`)
- Test: `apps/desktop/src/lib/navigation.test.ts`, `apps/desktop/src/lib/components/shell/shell.test.ts`

**Interfaces:**
- Consumes: `GENERIC_KINDS` labels (navigation items for ★ views take their label from the registry), `dynamic.count`, `dynamic.isUnavailable`.
- Produces: `SectionId = "cluster" | "workloads" | "network" | "storage" | "config" | "access" | "observe"`.

Sections and order (spec §4; Custom Resources is phase 5):
- Cluster: overview, nodes, namespaces
- Workloads: pods, deployments, statefulsets, daemonsets, replicasets, jobs, cronjobs, hpas, helm
- Network: services, ingresses, ingressclasses, endpointslices, networkpolicies
- Storage (`var(--color-cluster-teal)`): pvcs, pvs, storageclasses
- Config: configmaps, secrets, resourcequotas, limitranges, pdbs, priorityclasses
- Access Control (`var(--color-cluster-pink)`): serviceaccounts, roles, rolebindings, clusterroles, clusterrolebindings
- Observe: events, logs

Sidebar: `countFor` default branch adds `if (isGenericView(view))` → `dynamic.count(view)`. A row whose view `dynamic.isUnavailable` gets `text-text-disabled` on its label and `title="Not available on this cluster"`; it stays clickable (the list explains).

- [ ] **Step 1: Write the failing tests**

`navigation.test.ts`:
```ts
it("migrates preferences stored before Storage and Access Control existed", () => {
  const prefs = normalize({
    sections: ["cluster", "workloads", "config", "network", "observe"],
    order: ["overview", "nodes", "pods", "deployments", "statefulsets", "jobs", "cronjobs", "helm", "services", "ingresses", "pvcs", "secrets", "configmaps", "events", "logs"],
    hidden: ["pvcs"],
  });
  expect(prefs.sections).toEqual(["cluster", "workloads", "config", "network", "storage", "access", "observe"]);
  const storage = arrange(prefs).find((s) => s.id === "storage")!;
  expect(storage.items.map((i) => i.view)).toEqual(["pvcs", "pvs", "storageclasses"]);
  expect(prefs.hidden).toEqual(["pvcs"]);
  expect(arrange(prefs).find((s) => s.id === "config")!.items.map((i) => i.view).slice(0, 2)).toEqual(["secrets", "configmaps"]);
});
```
(Work out the exact expected `sections` from `merge`'s rule — new ids after their default predecessor — and fix the literal if the rule places them differently; the assertion is about no loss and PVCs under Storage.)
Update the existing default-order expectations in `navigation.test.ts` and the section list in `shell.test.ts` (`"Storage"`, `"Access Control"`).

`shell.test.ts`:
```ts
it("shows a loaded count for a new kind and greys kinds the cluster does not serve", async () => { /* dynamic.tables.daemonsets = 2 rows loaded for null ns → nav-count "2" in the DaemonSets row; discovery for "prod" lacks storageclasses → its row title "Not available on this cluster" */ });
```

`resource-kinds.spec.ts` (Playwright; mock answers `discover_resource_kinds` with every registry kind except `storageclasses`, `list_resource_table` for `daemonsets` with columns Name(format name)/Desired(integer)/Node Selector/Age(date) and one row `fluent-bit` in `logging`, `get_dynamic_resource_yaml` with `"apiVersion: apps/v1\nkind: DaemonSet\n"`):
```ts
test("a new kind opens as kubectl's columns with a read-only YAML drawer", async ({ page }) => {
  await boot(page);
  const sidebar = page.locator("aside").first();
  await sidebar.getByText("DaemonSets").click();
  for (const h of ["Desired", "Node Selector"]) await expect(page.getByText(h, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /fluent-bit/ }).click();
  await expect(page.getByRole("dialog", { name: "fluent-bit" })).toContainText("kind: DaemonSet");
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
});
test("a kind the cluster does not serve says so", async ({ page }) => {
  await boot(page);
  await page.locator("aside").first().getByText("Storage Classes").click();
  await expect(page.getByText("Not available on this cluster")).toBeVisible();
});
```
(Reuse `boot` the way `app.spec.ts` does; add the mock cases next to `apply_resource_yaml`.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter desktop exec vitest run src/lib/navigation.test.ts src/lib/components/shell/shell.test.ts && pnpm --filter desktop test:e2e -- resource-kinds`
Expected: FAIL — no Storage/Access sections, no rows for the new kinds.

- [ ] **Step 3: Implement the sections, the Sidebar changes, the mock cases and the CHANGELOG line** (`- Desktop: 18 more resource types (DaemonSets, ReplicaSets, Autoscalers, Network Policies, Persistent Volumes, Storage Classes, RBAC, quotas and more) with kubectl's columns and a read-only YAML view (#578).`).

- [ ] **Step 4: Run every gate**

Run: `pnpm --filter desktop lint && pnpm --filter desktop test && pnpm --filter desktop test:e2e`
Expected: PASS (rerun once warm if only the two known cold-start tests in `app.spec.ts` fail).

- [ ] **Step 5: Live check on minikube.** The app's context switch (`set_context`) writes `current-context` into the kubeconfig, so never run it on `~/.kube`: export a minikube-only file to the scratchpad (`kubectl config view --minify --flatten --context minikube > <scratchpad>/minikube.yaml`) and start the app with `KUBECONFIG=<scratchpad>/minikube.yaml pnpm --filter desktop tauri dev`. Open DaemonSets, Autoscalers, Cluster Roles, Storage Classes; compare columns with `kubectl --context minikube get ds -A`, `get hpa -A`, `get clusterroles`, `get sc`. Delete the scratch file afterwards; note the result in the PR body.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop CHANGELOG.md
git commit -m "feat(desktop): Storage and Access Control sections and sidebar rows for the new kinds"
```
