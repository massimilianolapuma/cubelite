# Resource kinds — phase 5: Custom Resources — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every custom kind the cluster serves is reachable: a "Custom Resources" section in All resources (filter, one row per API group in a capped 8-row area, a group opens to its kinds), the generic list and YAML drawer for each kind, pins like any other type, and ⌘K results.

**Architecture:** Custom kinds get dynamic view ids `crd:<group>/<plural>` that join the `View` type next to the fixed ids. The phase 2 `dynamic` store, keyed until now by the 18 ★ ids, is widened to any Table-listed view (`KindView`) and derives the active context's custom groups from its discovery cache. The view registry becomes a lookup function so every custom id renders `GenericKindView`. The sidebar and the palette read the custom groups from the store.

**Tech Stack:** Svelte 5, TypeScript, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-07-sidebar-resources-profiles-design.md` §5.3 (and §3, §6, §8).

## Global Constraints

- Custom kinds come from discovery (phase 1 `discover_resource_kinds`, cached per context), never from a separate CRD list (spec §5.3). Only list-able, top-level resources (phase 1 already filters subresources and kinds without `list`).
- A kind is "custom" when its API group is not a built-in Kubernetes group (Ruling 1). Built-in groups: `""`, `apps`, `batch`, `autoscaling`, `policy`, `networking.k8s.io`, `rbac.authorization.k8s.io`, `storage.k8s.io`, `scheduling.k8s.io`, `discovery.k8s.io`, `coordination.k8s.io`, `node.k8s.io`, `events.k8s.io`, `admissionregistration.k8s.io`, `apiextensions.k8s.io`, `apiregistration.k8s.io`, `authentication.k8s.io`, `authorization.k8s.io`, `certificates.k8s.io`, `flowcontrol.apiserver.k8s.io`, `internal.apiserver.k8s.io`, `resource.k8s.io`, `storagemigration.k8s.io`, `metrics.k8s.io`. CRD groups such as `gateway.networking.k8s.io` or `snapshot.storage.k8s.io` therefore count as custom, which they are.
- View id: `crd:<group>/<plural>` (e.g. `crd:monitoring.coreos.com/servicemonitors`). It is valid whatever the cluster serves, so a pin survives a cluster that lacks the kind.
- Sidebar section "Custom Resources", dot `var(--color-text-tertiary)` (mockup grey), placed right before Observe, not in Preferences' section order or hiding (Ruling 2). Section row count = number of API groups. Open: a filter box (`aria-label="Filter custom resources"`, matches group and kind names, case-insensitive), then the group rows in an area at most 8 rows tall (8 × 26 px) that scrolls on its own; each group row shows its number of kinds and opens inline to its kinds (compact `NavRow`s); one group open at a time (Ruling 3). No groups: caption "No custom resources on this cluster". Discovery unknown: caption "Loading…".
- Custom kind label = its `kind` (e.g. `ServiceMonitor`); list title = kind with the group as caption next to it; row nouns = lower-case kind / lower-case plural (`servicemonitor` / `servicemonitors`).
- A pinned custom kind that discovery does not report for the active context shows greyed with title "Not available on this cluster" (the same text as the ★ kinds; spec §5.3 says "Not on this cluster" — Ruling 4), label = its plural from the id.
- ⌘K: custom kinds of the active context in the "Go to resource" group, section "Custom Resources", label = kind, the group as caption; keywords: kind, plural, short names, group; `value` = `Go to <Kind> · <group>` (unique when two groups share a kind name).
- No release in this plan. CHANGELOG under `## [Unreleased]`.
- Commits: Conventional Commits, no Claude attribution. Branch `feat/586-custom-resources`. Gates before each commit (with `set -o pipefail`): `pnpm --filter desktop lint`, `pnpm --filter desktop test`, `pnpm --filter desktop exec svelte-check --threshold error`; before the PR `cd apps/desktop && npx playwright test --workers 1` (#584).

**Rulings (confirmed by the user):** 1 custom = outside the built-in group list above; 2 the section is fixed before Observe and not reorderable or hideable in Preferences for now; 3 one API group open at a time; 4 one "Not available on this cluster" text for every unserved kind.

## Review Focus

1. **A cluster with 60 CRD groups** (cert-manager, Istio, Crossplane…): the sidebar itself never scrolls; the group area caps at 8 rows and scrolls inside (Task 3 e2e `60 groups stay in an 8-row area`).
2. **Switching to a cluster without a pinned custom kind, or before its discovery answers**: the pin stays, greyed once discovery says so, never crashes on missing metadata (Task 3 test `a pinned custom kind on a cluster that lacks it`).
3. **Two groups that both define a kind with the same name** (e.g. `Certificate`): distinct rows, distinct lists, distinct palette entries (Task 2 and Task 4 tests `same kind name in two groups`).
4. **A stored pin or navigation to a malformed custom id** (`crd:`, `crd:x`, `crd:a/b/c`, upper case): rejected by `isView`, so profile repair drops it and nothing renders a broken view (Task 1 test `rejects malformed custom ids`).
5. **Opening a custom kind from ⌘K or a pin while the section is closed**: the Custom Resources section and the kind's group open so the active row is visible (Task 3 test `navigating to a custom kind opens its section and group`).

---

### Task 1: Custom view ids and the widened dynamic store

**Files:**
- Modify: `apps/desktop/src/lib/resource-kinds.ts` (+ test), `apps/desktop/src/lib/stores/app.svelte.ts` (`View`, `isView`), `apps/desktop/src/lib/stores/dynamic.svelte.ts` (+ test), `apps/desktop/src/lib/stores/nav-counts.svelte.ts`, `apps/desktop/src/lib/stores/resources.svelte.ts:202`

**Interfaces:**
- Produces:
  ```ts
  // resource-kinds.ts
  export type CustomView = `crd:${string}`;
  export const BUILTIN_GROUPS: ReadonlySet<string>;
  export function customView(group: string, plural: string): CustomView;
  export function parseCustomView(v: string): { group: string; plural: string } | null; // /^crd:([a-z0-9]([a-z0-9.-]*[a-z0-9])?)\/([a-z0-9]+)$/
  export function isCustomView(v: unknown): v is CustomView;
  export type KindView = GenericView | CustomView;
  export function isKindView(v: unknown): v is KindView;
  export function isCustomKind(k: { group: string }): boolean; // !BUILTIN_GROUPS.has(group)
  // app.svelte.ts
  export type View = (typeof VIEWS)[number] | CustomView;   // isView accepts both
  // dynamic.svelte.ts — every GenericView parameter becomes KindView, plus:
  export interface KindMeta { label: string; nouns: readonly [string, string]; namespaced: boolean; group: string }
  meta(view: KindView): KindMeta;            // registry for ★, discovery for custom, fallback from the id (label = plural)
  get customGroups(): { group: string; kinds: { view: CustomView; kind: string; plural: string; shortNames: string[] }[] }[]; // active context; groups and kinds sorted by name; [] when unknown
  get customKnown(): boolean;                // discovery known for the active context
  ```
  For a custom view `isUnavailable` is true when discovery is known and lacks it; `refFor` uses the discovered version and scope, and for an unknown custom kind falls back to `{ group, version: "v1", plural, namespaced: true }` (never listed while unavailable).

- [ ] **Step 1: Write the failing tests**: `builds and parses custom ids`, `rejects malformed custom ids` (`crd:`, `crd:x`, `crd:a/b/c`, `crd:Monitoring.coreos.com/x`, `pods` is not custom), `isView accepts custom ids`, `built-in groups are not custom` (apps, metrics.k8s.io not custom; gateway.networking.k8s.io custom); dynamic: `custom groups of the active context, sorted`, `same kind name in two groups gives two views`, `meta of a custom kind comes from discovery, else from the id`, `a custom kind loads and counts like a ★ kind`, `an undiscovered custom kind is unavailable once discovery is known`.
- [ ] **Step 2: Run** `pnpm --filter desktop exec vitest run src/lib/resource-kinds.test.ts src/lib/stores/dynamic.svelte.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; `resources.load()` refreshes any `isKindView(app.view)`; `countFor` handles any `KindView`.
- [ ] **Step 4: Run** the full gates — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): custom kind view ids and their discovery data`.

---

### Task 2: Custom kinds render as generic lists

**Files:**
- Modify: `apps/desktop/src/lib/components/views/index.ts` (`viewEntry(view: View): ViewEntry` replaces the `viewRegistry` record lookup; keep the record for fixed ids), `apps/desktop/src/routes/+page.svelte:34`
- Modify: `GenericKindView.svelte`, `ObjectYamlDrawer.svelte` (`view: KindView`, metadata through `dynamic.meta`)
- Test: `apps/desktop/src/lib/components/views/generic-kind-view.test.ts`, `views.test.ts`

- [ ] **Step 1: Write the failing tests**: `viewEntry renders GenericKindView for a custom id`, `a custom kind lists with its kind as title and its group as caption` (discovery reports `monitoring.coreos.com/v1 ServiceMonitor` → title "ServiceMonitor", caption "monitoring.coreos.com", empty state "No servicemonitors found."), `same kind name in two groups` (two `Certificate` kinds → each list requests its own group), `an unserved custom kind says Not available on this cluster`.
- [ ] **Step 2: Run** `pnpm --filter desktop exec vitest run src/lib/components/views` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full gates — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): list any custom kind with kubectl's columns`.

---

### Task 3: The Custom Resources section and custom pins

**Files:**
- Create: `apps/desktop/src/lib/components/shell/CustomResources.svelte`
- Modify: `AllResources.svelte` (render it before Observe), `Sidebar.svelte` (pin metadata for custom views; the auto-open effect opens "custom" and the kind's group), `apps/desktop/src/lib/stores/sidebar.svelte.ts` (`openSection: SectionId | "custom" | null`, `openGroup: string | null`, `customFilter: string`; opening a section resets `openGroup`)
- Modify: `apps/desktop/tests/e2e/tauri-mock.ts` (discovery fixtures gain `monitoring.coreos.com` ServiceMonitor/PodMonitor/PrometheusRule, `elasticsearch.k8s.elastic.co` Elasticsearch, and an option to add N generated groups)
- Test: `apps/desktop/src/lib/components/shell/custom-resources.test.ts`; Create: `apps/desktop/tests/e2e/custom-resources.spec.ts`

- [ ] **Step 1: Write the failing tests**:
  - unit: `shows one row per group with its number of kinds`, `a group opens to its kinds and closes the other group`, `the filter matches group and kind names`, `says when the cluster has no custom resources`, `a pinned custom kind shows its kind name and section dot`, `a pinned custom kind on a cluster that lacks it` (greyed, title "Not available on this cluster", label = plural), `navigating to a custom kind opens its section and group`, `keyboard: the section toggles like the others` (↑/↓ include it).
  - e2e: `open a custom kind from its group, pin it, see it in Pinned`; `60 groups stay in an 8-row area` (fixture with 60 groups → aside does not scroll; the group area's `clientHeight` ≤ 8 × 26 px and it scrolls).
- [ ] **Step 2: Run** `pnpm --filter desktop exec vitest run src/lib/components/shell` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full gates and `npx playwright test --workers 1` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): Custom Resources section with API groups and custom pins`.

---

### Task 4: Custom kinds in ⌘K, CHANGELOG

**Files:**
- Modify: `apps/desktop/src/lib/components/CommandPalette.svelte` (+ test), `apps/desktop/src/lib/resource-kinds.ts` (`searchKeywords` for custom views: kind, plural, short names, group), `CHANGELOG.md`

- [ ] **Step 1: Write the failing tests**: `custom kinds of the active cluster are in Go to resource` (row "ServiceMonitor" with section "Custom Resources" and caption "monitoring.coreos.com"), `finds a custom kind by short name and by group` (`smon`, `coreos`), `same kind name in two groups` (two rows, each opens its own view), `⌘↵ pins a custom kind`.
- [ ] **Step 2: Run** `pnpm --filter desktop exec vitest run src/lib/components/CommandPalette.test.ts src/lib/resource-kinds.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; CHANGELOG `- **Custom Resources** (#586): …`.
- [ ] **Step 4: Run** every gate incl. e2e — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): custom kinds in the palette; changelog`.
