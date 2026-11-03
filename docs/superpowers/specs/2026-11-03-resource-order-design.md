# Resource order and default list sort (desktop + macOS) — design

Date: 2026-11-03 · Issue: #485 · Owner: desktop-agent, macos-agent · Status: approved 2026-11-03 (A: within sections + section order, B: one global default sort, C: clickable headers too, D: global)

## 1. Intent

Different users live in different corners of a cluster: one opens Pods,
Deployments and Logs all day and never Helm or PVCs; another starts from
Ingresses. Both apps show every resource type in a fixed order and every
list in API order (namespace/name as the API server returns it — neither app
sorts tables today; only Events are newest-first). Scope decided 2026-11-02:
**both** —
1. the user chooses the **order and visibility of the resource types** in
   the navigation (desktop sidebar, macOS resource-type column), and
2. the user chooses the **default sort of the resource lists**,

from Preferences, on both apps.

## 2. Goals, non-goals, anti-goals

Goals
- Preferences section **Navigation**: reorder resource types, hide/show them,
  reset to default.
- Preferences section **Lists**: default sort (field + direction) applied
  when a list opens.
- Settings remembered across launches; same behaviour and defaults on both
  apps.

Non-goals
- No per-cluster / per-context settings (one global preference, §6 D).
- No sync of preferences between the two apps or across machines.
- No column show/hide or column reordering.
- No change to what a view shows, only where it sits and how it is sorted.

Anti-goals
- Hiding a type never makes it unreachable: command palette, Overview stat
  cards, links from other views and the keyboard shortcuts still open it.
- Overview cannot be hidden or moved (it is the landing page); at least one
  other type stays visible.
- A list that has never been configured looks exactly as today (API order is
  the effective default only if the user picks it; see §4.2 default).
- No new colours or font sizes outside the tokens (design-lint at 0).

## 3. Navigation order and visibility

### 3.1 Model

- Ordered list of resource-type ids + a set of hidden ids, persisted
  (`navigation.order`, `navigation.hidden`). Ids are the existing view ids
  (desktop `View`, macOS `ResourceType` mapped to the same strings:
  `nodes, pods, deployments, statefulsets, jobs, cronjobs, helm, services,
  ingresses, configmaps, secrets, pvcs, events, logs`).
- Robust to change: ids in storage that no longer exist are dropped; types
  added in a future release that are missing from storage are inserted at
  their default position (after their default predecessor). Unit-tested.
- Desktop keeps its **sections** (Cluster, Workloads, Network, Config,
  Observe) with their colour dots; see decision A for how order interacts
  with sections. macOS's resource-type column has no sections today and keeps
  a flat list in the same order.

### 3.2 Preferences UI

```
Navigation                                     [Reset to default]
  ⠿ Pods            ▲ ▼   ◉ shown
  ⠿ Deployments     ▲ ▼   ◉ shown
  ⠿ StatefulSets    ▲ ▼   ○ hidden
  …
```
- Desktop (`PreferencesModal.svelte`, new section after the kubeconfig
  list): one row per type, `▲`/`▼` icon buttons (lucide `ChevronUp/Down`,
  `aria-label="Move Pods up"`), a visibility switch, keyboard operable; drag
  and drop is a builder's option on top, never the only way.
- macOS (`PreferencesView`, new **Navigation** tab with `sidebar.left`
  icon): `List` with `.onMove` (native drag) plus a `Toggle` per row and a
  "Reset to Default" button; VoiceOver gets move up/down accessibility
  actions.
- Hidden types render dimmed in the Preferences list; the navigation updates
  live.

## 4. Default list sort

### 4.1 Fields

| field | applies to | order |
|---|---|---|
| Name | every list | A→Z (natural: `pod-2` before `pod-10`) |
| Namespace | namespaced lists | A→Z, then name |
| Age | every list with an age | newest first |
| Status | pods, deployments, statefulsets, nodes, PVCs, Helm | problems first (failing/pending/not ready), then name |
| Restarts | pods | most first |

Direction toggle (ascending/descending) applies to the chosen field.
Lists where the chosen field does not exist fall back to Name.
Events keep their own newest-first order (not affected). Logs is not a list.

### 4.2 Default

`API order` stays available as the first option and is the default, so
nothing changes until the user picks something (anti-goal above).

### 4.3 Where it applies

Every resource table on both apps (desktop `PodTable`, `DeploymentTable`
and the kind views; macOS `*ListView` tables), after the existing filters,
stable (ties keep API order). Live updates (watch/refresh) re-sort without
moving the selection.

## 5. Structure

- Desktop: `lib/stores/navigation.svelte.ts` (order/hidden, normalisation),
  `lib/list-sort.ts` (pure comparators per field), `Sidebar.svelte` reads the
  store, the tables sort via `list-sort`.
- macOS: `Models/NavigationPreferences.swift`, `Models/ListSort.swift` (pure,
  same rules), `MainView+ContentColumn` reads the order, the `Table`s use the
  sorted array.
- Same test vectors on both: normalisation (unknown id dropped, new id
  inserted after its predecessor), Overview pinned, last visible type cannot
  be hidden, each comparator incl. natural name order, status ranking,
  stability, fallback to Name.

## 6. Decisions for the user

A. **Order granularity (desktop sidebar).** Reorder types *within* their
   section and reorder the sections themselves (recommended: keeps the
   coloured groups that make the sidebar scannable) **or** a free flat order
   with no sections on desktop either (maximum freedom, loses the groups).

B. **Sort scope.** One global default sort applied to every list
   (recommended: one setting, falls back to Name where the field is missing)
   **or** a default per resource type (14 settings, more control).

C. **Clickable column headers.** Also let the user click a table header to
   sort that list for the session (recommended: what every table does; the
   Preferences value stays the default) **or** Preferences only.

D. **Scope of the preference.** Global for all clusters (recommended)
   **or** per context.

## 6b. Decided (2026-11-03)

- A: types reorder **within their section**, and sections reorder among
  themselves (Cluster stays first: it holds Overview). Persisted as
  `navigation.sections` (section order) + `navigation.order` (type order,
  read per section) + `navigation.hidden`. A section whose types are all
  hidden is not rendered. macOS shows the resulting flat sequence.
- B: one global default sort (`lists.sort` = field + direction).
- C: clicking a column header sorts that list for the session (click again
  flips the direction, a third click returns to the default); the header
  shows `▲`/`▼` and `aria-sort`. Switching cluster or relaunching returns to
  the Preferences default. Sortable headers = the §4.1 fields present as
  columns.
- D: global for all clusters.

## 7. Delivery

Two issues/PRs from #485 (desktop, then macOS), as for #486. Each closes its
half; #485 closes with the second.
