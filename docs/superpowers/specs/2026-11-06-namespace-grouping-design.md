# Group resource lists by namespace — design (#547)

Status: approved 2026-11-06. Desktop and macOS. Builds on #546 (Namespace column).

## 1. Why

With "All namespaces" selected, a busy cluster mixes dozens of namespaces in one list. The Namespace column (#546) and sorting by it already put each namespace's rows together, but nothing marks where one namespace ends, nothing tells how many rows each has or whether one of them has a problem, and nothing lets the user fold away the namespaces they don't care about (`kube-system`, `monitoring`, …).

## 2. Goals, non-goals, anti-goals

- Goal: an optional grouped mode — one header per namespace, with a row count and a problem marker, collapsible.
- Goal: same behaviour and wording on desktop and macOS.
- Non-goal: grouping by anything else (label, owner, node). The model may allow it later; v1 is namespace only.
- Non-goal: a per-namespace summary dashboard, namespace actions (delete, describe) on the header.
- Anti-goal: making the default flat list slower, longer or different. Off by default; with grouping off nothing changes.
- Anti-goal: hiding rows the user is looking for — a filter match must never sit inside a collapsed group.

## 3. Where it applies

Every list with a Namespace column: Pods, Deployments, StatefulSets, Jobs, CronJobs, Services, Ingresses, ConfigMaps, Secrets, PVCs, Helm Releases. Not Nodes (cluster-scoped), Events, Logs, Overview.

Only when "All namespaces" is selected. With a single namespace selected the list is flat and the toggle is hidden (one group would add nothing).

## 4. Behaviour

**Toggle.** One global preference, "Group by namespace", off by default, persisted:
- a small toggle button in each list's title bar, next to the filter field (icon: stacked rows, tooltip "Group by namespace"), pressed state shown;
- the same switch in Preferences → Navigation, under the default sort.
Global, not per list: the choice follows "I am looking at all namespaces", which is the same whichever list is open.

**Group header row.** Full width, in place of a data row:

```
▾ team-a                                   12   ● 2
```

- chevron (▸ collapsed, ▾ expanded), namespace name (data type, bright), row count (secondary);
- problem marker only on lists that have a status (Pods, Deployments, StatefulSets, PVCs, Helm): a dot in the worst tone among the group's rows plus the count of rows not `ok`; nothing when all are ok;
- the header is one button: click, Enter or Space toggles; Option/Alt-click toggles every group to the clicked group's new state (collapse all / expand all);
- accessible name "team-a, 12 pods, 2 with problems, expanded".

**Columns.** In grouped mode the Namespace column is hidden (it repeats the header). Its header click (sort by namespace) is therefore not available; see ordering.

**Ordering.** Groups are ordered by namespace name, A→Z. If the current sort is Namespace descending (Preferences default), groups go Z→A. Rows inside each group follow the current sort; when the current sort is Namespace, rows inside a group sort by name. API order keeps API order inside each group.

**Collapse state.** Per namespace name, shared by all lists (collapsing `kube-system` in Pods also collapses it in Services), for the session; reset on cluster switch and relaunch, like the header-click sort overrides (#496). New namespaces appear expanded.

**Filter.** The filter applies to rows. Groups with no matching row are hidden. While the filter is not empty every group with a match is shown expanded, without changing the stored collapse state; clearing the filter restores it.

**Selection.** Collapsing the group of the selected row keeps the selection and the open drawer; the row is just not visible.

**Empty.** Namespaces with no rows are not shown. "No pods found." stays as today.

## 5. Layout

Desktop, Pods, grouped, `team-a` expanded and `kube-system` collapsed:

```
Pods                                   [≡ group]  [Filter pods…      ]
┌────────────────────────────────────────────────────────────────────┐
│ Name ▲            Status     Ready  Age   CPU    Memory  Restarts  │
├────────────────────────────────────────────────────────────────────┤
│ ▸ kube-system                                          9           │
│ ▾ team-a                                               3   ● 1     │
│   api-7d9f…       Running    1/1    2d    ▁▂▃    ▂▂▂     0         │
│   worker-5c…      CrashLoop  0/1    1h    ▁▁▁    ▁▁▁     14        │
│   web-66b…        Running    1/1    2d    ▂▃▂    ▃▃▃     0         │
│ ▾ team-b                                               1           │
│   batch-1…        Running    1/1    5m    ▁▁▁    ▁▁▁     0         │
└────────────────────────────────────────────────────────────────────┘
```

Header rows use `surface-surface` (the column-header background), `type-data` for the name, `type-data-sm` secondary for the count, the existing status tone dots. Data rows keep their style; their first cell is indented by the chevron width so names line up under the namespace name. Headers are not sticky in v1.

macOS: the native `Table` with one parent row per namespace (`DisclosureTableRow`, available on the macOS 14.6 target) or table `Section`s — builder's call, as long as the header shows count and problem marker as above and the Namespace column is hidden in grouped mode. Toggle in the list toolbar and in Settings → Navigation.

## 6. Implementation notes (builder's call unless stated)

- Desktop: pure helper in `src/lib/` (e.g. `list-group.ts`: `groupByNamespace(rows, spec, accessors) → { namespace, rows, count, worst, problems }[]`) reusing `sortRows` and `SortAccessors.status`; preference in a store next to `lists`; collapse state session-only and cleared by `app.resetForClusterSwitch()`. A shared header-row component used by all 11 lists — no per-list copies (Sonar duplication ≤ 3%).
- macOS: same helper in Swift beside `ResourcePreferences`; preference in `ResourcePreferences` (own `UserDefaults`), collapse state in a session model reset on cluster switch.
- Tests: grouping/ordering/filter/collapse rules on the pure helpers (both stacks), rendering of header rows and toggle on two representative lists, Playwright: toggle, collapse, Option-click all, filter auto-expand.

## 7. Calls made in this draft (to check)

1. Global toggle, not per list; off by default.
2. Only with "All namespaces"; hidden otherwise.
3. Namespace column hidden while grouped.
4. Collapse state per namespace name, shared across lists, session-only.
5. Filter auto-expands matching groups.
6. Problem marker = worst tone dot + count of non-ok rows, only on lists with a status.
7. Headers not sticky in v1.
