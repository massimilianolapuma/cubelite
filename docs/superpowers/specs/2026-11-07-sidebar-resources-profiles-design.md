# Sidebar for every resource type, with pinned resources and profiles — design

Status: for approval · 2026-11-07 · desktop (`apps/desktop`) + core (`crates/cubelite-core`)
Mockups: canvas https://claude.ai/artifact/MMYQd8WeLe28GLhmf8hJuH — variant **C** is the chosen
direction; variant **B** (section rail) is the fallback if C does not hold up once used.

## 1. Intent

CubeLite shows 15 resource types; a cluster exposes about 40 that a DevOps / platform / SRE
engineer looks at (DaemonSets, ReplicaSets, HPAs, NetworkPolicies, PVs, StorageClasses, RBAC,
quotas, PDBs, custom resources…). The user wants all of them reachable, presented well, **without
awkward scrolling** in the sidebar, on a 13–14" laptop.

The user also proposed **profiles**: viewing presets per scenario (on-call, developer, security…),
because different jobs look at different resources.

Primary user (confirmed): a DevOps engineer / platform engineer / SRE with many clusters open all
day. Product commitments to keep (confirmed): local-first, light and fast, multi-cluster at a
glance, integrated observability. Design constraints (confirmed): dense UI on a laptop screen,
keyboard first, accessible (contrast, focus, screen reader), read-only by default (destructive
actions explicit and confirmed).

## 2. Goals, non-goals, anti-goals

Goals
- Every resource type in §4 reachable from the sidebar and from ⌘K.
- The sidebar never scrolls at 800 px of window height with the default profile (C's rule: one
  section open at a time, pinned list capped).
- Profiles: switch the pinned set in one click; ship four built-in profiles; let the user edit the
  pins of any profile and create their own profiles.
- New types get a list with the same columns `kubectl get` shows, and a read-only YAML view.

Non-goals (this design)
- Editing, deleting or scaling the new types. They are read-only (YAML view only); the existing
  apply flow (#487) is not extended to them here.
- Watches (live updates) for the new types: they load on open and on the refresh interval, like
  today's on-demand kinds.
- Per-cluster profiles: one active profile for every cluster, for now (user's decision).
- Implementing variant B. It stays a mockup; the code keeps sections as data so a B renderer
  could be added later without touching stores.

Anti-goals (failure even if it works)
- A sidebar that scrolls in normal use, or a list of 40 rows always visible.
- The new generic lists showing fewer or different columns than `kubectl get` for the same kind.
- Profiles that silently hide a resource with no way to reach it (⌘K must always reach every type).
- Slower startup: no new *list* loads until it is opened (counts in the sidebar stay on-demand,
  as today). The one exception is API discovery (§5.4): one request per cluster on connect.

## 3. The sidebar (variant C)

Top to bottom, width 216 px (today 198 px; the longer labels need it):

1. **Profile switch**: a compact menu button showing the active profile's name (`Profile: On-call
   ▾`, as in mockup A), listing every profile, built-in and user-created, plus "Manage profiles…"
   (opens Preferences). A segmented control does not fit once users add their own profiles.
   Switching profile changes only the pinned list. Keyboard: ⌘1…⌘9 switch to the first nine
   profiles.
2. **Go to resource ⌘K**: a button that opens the palette (§6).
3. **Pinned · <profile name>**: the profile's pinned resource types, each row as today's rows:
   section dot, label, neutral total, and the attention badge from #574 (red pods, amber
   warnings). Cap: 9 pins; the 10th pin is refused with a toast "A profile holds up to 9 pins".
4. A divider, then **All resources**: one row per section (dot, section name, number of types,
   chevron). Opening a section closes the one that was open (exclusive accordion). Inside, the
   section's types as compact rows with their counts once loaded. The open section is remembered
   for the session, not persisted.
5. The active view's row is highlighted wherever it appears (pinned and/or inside its section).

A collapsed section shows a red dot when a type inside it has the red attention badge (only Pods
today). Keyboard: Tab order follows the visual order; in the All resources list, ↑/↓ move between
section rows and Enter/Space toggles, → opens, ← closes (disclosure pattern with `aria-expanded`).

Pinning: each list's title bar gets a pin toggle (`aria-pressed`, "Pin to <profile>"); the palette
offers ⌘↵ "open and pin". Unpinning from the sidebar: right-click / context menu "Unpin" and the
title-bar toggle. Pinned order: drag in Preferences (reusing the #496 reorder UI), else the order
they were pinned.

Existing #496 Preferences (section order, hidden types) keep working: hidden types disappear from
All resources and cannot be pinned; section order applies to All resources.

## 4. Resource types and sections

Kubernetes documentation grouping, cross-checked with `kubectl api-resources` on minikube.
★ = new in this work.

| Section | Types |
|---|---|
| Cluster | Overview, Nodes, ★Namespaces |
| Workloads | Pods, Deployments, StatefulSets, ★DaemonSets, ★ReplicaSets, Jobs, CronJobs, ★HorizontalPodAutoscalers (label "Autoscalers"), Helm Releases |
| Network | Services, Ingresses, ★IngressClasses, ★EndpointSlices, ★NetworkPolicies |
| ★Storage | PVCs (moved from Config), ★PersistentVolumes, ★StorageClasses |
| Config | ConfigMaps, Secrets, ★ResourceQuotas, ★LimitRanges, ★PodDisruptionBudgets (label "Disruption Budgets"), ★PriorityClasses |
| ★Access Control | ★ServiceAccounts, ★Roles, ★RoleBindings, ★ClusterRoles, ★ClusterRoleBindings |
| ★Custom Resources | one entry per API group of the cluster's CRDs; inside, one type per CRD kind (§5.3) |
| Observe | Events, Logs |

Left out on purpose: ReplicationController (superseded), Endpoints (superseded by EndpointSlices),
ControllerRevision, PodTemplate, Lease, admission webhooks, APIService, FlowSchema /
PriorityLevelConfiguration, CertificateSigningRequest, CSI objects, ResourceClaim and friends.
They are out of scope entirely for now, not even in ⌘K (see §8, question 3).

Cluster-scoped types (Namespaces, PVs, StorageClasses, IngressClasses, PriorityClasses,
ClusterRoles, ClusterRoleBindings, cluster-scoped CRDs) ignore the namespace selector and say so
in the list header ("cluster-scoped").

## 5. Lists for the new types

### 5.1 One generic list, kubectl's columns

New types do not get one hand-written view each. Core gains one call that lists any type through
the API server's **Table** representation (`Accept: application/json;as=Table;v=v1;g=meta.k8s.io`),
the same thing `kubectl get` prints: the server returns the column definitions and cells per row,
including a CRD's `additionalPrinterColumns`. The desktop renders it with one generic list
component.

- Row identity: `metadata.name` (+ namespace) from the Table rows' `object` (request
  `includeObject=Metadata`); `creationTimestamp` for the Age column and the Age sort.
- Columns: the server's columns with `priority: 0` (what `kubectl get` shows without `-o wide`);
  `Name` and `Age` use CubeLite's own cells (name link, `formatAge`) so they look like every other
  list. Other cells render as text, `type: date` cells with `formatAge`.
- Sort: Name, Namespace (namespaced types), Age through the existing `sortRows` / header clicks
  (#496); other columns are not sortable in this design.
- Grouping by namespace (#547) works for namespaced types.
- Filter box: by name, like Pods.
- Row click: opens a drawer with the YAML (existing `get_resource_yaml`, generalized to any type
  through a dynamic API resource) — read-only, no Edit button.
- Errors: 403 shows the existing "forbidden" state per list (RBAC resilience); a type the cluster
  does not serve (per discovery, §5.4) shows "Not available on this cluster", greyed in All
  resources and in the pinned list.
- Scope: only the ★ types use the generic list. The existing hand-written views (Pods,
  Deployments, Services, PVCs, Jobs…) stay as they are; they are not required to match
  `kubectl get` columns. *(Builder-check ruling, my call.)*

### 5.2 Counts

The sidebar count of a new type appears once its list has loaded for the current cluster +
namespace, exactly like today's on-demand kinds (`loadedKinds`). No background counting.

### 5.3 Custom resources

> **Revised 2026-11-07 (#589, user decision after trying v0.10.0):** the section no longer shows
> one row per API group to open. Opening it shows every custom kind right away, with the same rows as
> the other sections, grouped under small non-clickable vendor headers (the API group's registrable
> domain: `*.k8s.elastic.co` → elastic.co, `monitoring.coreos.com` → coreos.com). The filter narrows
> the same rows by kind, plural, group or vendor; the full API group is the row's tooltip; there is
> no fixed 8-row cap — like any open section only its list scrolls when space runs out. The text
> below describes the first version.

Custom kinds come from discovery (§5.4), not from a separate CRD list. Opening the Custom
Resources section shows a **filter box** and one row per API group (`monitoring.coreos.com`,
`elasticsearch.k8s.elastic.co`…) with its number of kinds; a group opens inline to its kinds. The
group list lives in a **capped area (at most 8 rows tall) that scrolls on its own**, so a cluster
with 60 CRD groups (cert-manager, Istio, Crossplane…) does not make the sidebar scroll; ⌘K reaches
every kind anyway. A kind opens the generic list (§5.1). Custom kinds can be pinned like any other
type; a pin whose kind discovery no longer reports shows greyed with "Not on this cluster".
*(Builder-check ruling, my call.)*

### 5.4 Discovery

On connecting to a cluster (and on the existing manual refresh), core runs **one aggregated
discovery request** (`/api` + `/apis`, `application/json;g=apidiscovery.k8s.io;v=v2`, falling back
to the legacy per-group discovery on servers older than 1.30) and caches the result per context
for the session. It gives, per type: served group/version (the registry picks the preferred
version, e.g. HPA `autoscaling/v2`, PDB `policy/v1`), plural, scope, short names, and every CRD
kind. Types the cluster does not serve are greyed (§5.1). *(Builder-check ruling, my call: this
is the only extra request at connect; it is small and lets the sidebar grey pins honestly.)*

## 6. Go to resource (⌘K)

The existing command palette (`CommandPalette.svelte`, bits-ui Command) gains a **resource types**
group: every type of §4 plus loaded custom kinds, fuzzy-matched by label, plural, short name
(`deploy`, `svc`, `pvc`, `hpa`, `netpol`, `sa`, `crb`…). Each result shows its section, its count
when loaded, and "hidden in <profile>" / "hidden in Preferences" when it is not visible in the
sidebar. Enter opens; ⌘↵ opens and pins to the active profile. The palette is the guaranteed way
to every type whatever the profile and Preferences say.

## 7. Profiles

- Built-in: **On-call** (Overview, Nodes, Pods, Deployments, Jobs, Events, Logs), **Developer**
  (Pods, Deployments, Services, Ingresses, ConfigMaps, Secrets, Logs), **Security** (Service
  Accounts, Roles, Role Bindings, Cluster Roles, Secrets, Network Policies), **All** (Overview,
  Pods, Deployments, Services, Events). Default for a new install and for existing users: On-call.
- A profile is only a name and an ordered pin list (≤9). It does not hide types or change
  sections; hiding stays a Preferences setting (#496), global.
- Editing: pin/unpin changes the active profile.
- User profiles (user's decision): Preferences › Navigation › Profiles lists all profiles. The user
  can **create** a profile (name, starting empty or as a copy of the active one), **rename** and
  **delete** their own, and **reorder** the list (order = menu order and ⌘1…⌘9). Built-in profiles
  cannot be renamed or deleted; they offer "Reset to default pins". Names: 1–24 characters,
  unique (case-insensitive), trimmed. Up to 12 profiles in all. Deleting the active profile
  switches to On-call.
- Persisted globally (all clusters) with the other navigation preferences; the active profile is
  persisted too. One active profile for every cluster (user's decision).

## 8. Decisions taken with the user

1. Profiles are global: one active profile for every cluster, for now.
2. Users can create their own profiles (§7), besides editing the built-ins' pins.
3. The left-out types of §4 stay out entirely for now, ⌘K included.

## 9. Phasing (one issue and PR each, in order)

1. **Core**: discovery (§5.4) + generic Table list + dynamic YAML, with tests (unit with fixtures of
   Table responses; live check on minikube with `--context minikube`).
2. **Desktop data + generic list**: kind registry (§4 as data: id, label, section, API
   group/version/plural, scope, short names), generic list + YAML drawer, new `View`s, counts.
3. **Sidebar C + profiles + pins**: replaces the sidebar layout, Preferences for pins.
4. **Palette resource group** (§6).
5. **Custom Resources section** (§5.3).

Each phase merges on its own, but **no release goes out between phase 2 and phase 3**: phase 2
appends the new sections to today's sidebar (about 35 rows), which is the anti-goal, so it is only
acceptable on `main`, not in an installed app. Phases 4 and 5 can be released separately after
phase 3. *(Builder-check ruling, my call.)*

## 10. Left to the builder

Component and file names, the Tauri command names, the exact short-name list, icons, the drawer
layout of the YAML view (reuse the existing drawer), how the kind registry is typed, test layout.
