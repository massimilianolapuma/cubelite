# Penpot Audit — macOS Native Screens

> **Status**: design audit (read-mostly). Refs #73.
> **Branch**: `design/macos-screens-audit`
> **Penpot file**: `cubelite` — id `30c95215-44cf-80fa-8007-dc318de1085f`
> **Workspace URL**: <https://design.penpot.app/#/workspace?file-id=30c95215-44cf-80fa-8007-dc318de1085f>
> **Date**: 2026-04-29

---

## 0. Scope and ground truth

This document audits every screen rendered by the SwiftUI views under
`apps/macos/cubelite/cubelite/Views/` against:

- the Apple HIG references in `docs/apple-hig-summary.md`,
  `docs/apple-hig-components.md`, `docs/apple-hig-patterns-inputs.md` and
  `docs/cubelite-macos-design-instructions.md`;
- the design tokens in `design/tokens.json`;
- the existing Penpot boards on the **macOS Native** page and the kit-*
  atoms on the **States & Components** page.

It also introduces two new Penpot pages:

| Page | id | Purpose |
|---|---|---|
| `Conventions` | `0088c57e-d1b4-8036-8007-f0e65e1791f9` | Naming convention, light + dark |
| `Common Elements` | `0088c57e-d1b4-8036-8007-f0e65e19c8f4` | Curated catalogue of reusable atoms / molecules, light + dark |

Direct page URLs:

- Conventions — <https://design.penpot.app/#/workspace?file-id=30c95215-44cf-80fa-8007-dc318de1085f&page-id=0088c57e-d1b4-8036-8007-f0e65e1791f9>
- Common Elements — <https://design.penpot.app/#/workspace?file-id=30c95215-44cf-80fa-8007-dc318de1085f&page-id=0088c57e-d1b4-8036-8007-f0e65e19c8f4>
- macOS Native — <https://design.penpot.app/#/workspace?file-id=30c95215-44cf-80fa-8007-dc318de1085f&page-id=1b8565c6-f550-8090-8007-de5c859bb57f>
- States & Components — <https://design.penpot.app/#/workspace?file-id=30c95215-44cf-80fa-8007-dc318de1085f&page-id=1b8565c6-f550-8090-8007-de5c859bcd4a>

---

## 1. Naming convention

Two flat namespaces, both copied onto the in-Penpot **Conventions** page so
designers can read them next to the artwork.

```
screen/<screen-slug>/<region>/<element>[/<state>]
common/<category>/<name>[/<variant>]
```

- `<screen-slug>` matches the Swift file in kebab-case minus `View`
  (e.g. `MainView` → `main`, `DeploymentDetailView` → `deployment-detail`).
- `<region>` ∈ { `titlebar`, `sidebar`, `list`, `detail`, `toolbar`,
  `footer`, `header`, `content`, `banner`, `modal`, `menu` }.
- `<state>` ∈ { `default`, `hover`, `pressed`, `focused`, `selected`,
  `disabled`, `loading`, `error`, `empty` }.
- `<category>` ∈ { `controls`, `chrome`, `data`, `feedback`, `identity` }.

**Rule**: every shape that is not pure decoration MUST carry one of the two
identifiers. Repeated shapes MUST live on the **Common Elements** page and
be referenced from each screen as a Penpot component instance — never
copy-pasted.

---

## 2. Swift view → Penpot board mapping

Coverage matrix for every `*View.swift` under `apps/macos/cubelite/cubelite/Views/`.

| Swift view | Light board | Dark board | Notes |
|---|---|---|---|
| `MainView.swift` (Empty) | `MainView – Empty – Light` (`…df75bb683727`) | `MainView – Empty – Dark` (`…df75bbc23445`) | Sidebar + empty detail |
| `MainView.swift` (Select NS) | `MainView – Select NS – Light` (`…df75bc727dec`) | `MainView – Select NS – Dark` (`…df75bcd0b44a`) | Sidebar with selection prompt |
| `MainView.swift` (Error) | `MainView – Error – Light` (`…df75bd92887f`) | `MainView – Error – Dark` (`…df75bdfde6ff`) | Inline error banner |
| `MainView.swift` (No Config) | `MainView – No Config – Light` (`…df7608974b50`) | `MainView – No Config – Dark` (`…df7608f36699`) | First run before kubeconfig |
| `FirstLaunchView.swift` | `macOS - First Launch – Light` (`…de689852f6ef`) **+** `FirstLaunchView - Found - Light` (`…e11089d35883`) | `macOS - First Launch – Dark` (`…dfaf22cdae38`) **+** `FirstLaunchView - Found - Dark` (`…e11136baeaed`) | Two scenarios (no-config / found) |
| `DashboardView.swift` | `DashboardView – Light` (`…f17c66dc2031`) | `DashboardView – Dark` (`…f17c6a9a075f`) | F1 (#127). 9-tile LazyVGrid (Pods, Deployments, Services, Namespaces, Secrets, ConfigMaps, Ingresses, Helm Releases, Cluster) inside full MainView chrome (titlebar+toolbar unified, sidebar split). Secrets shown in `lock.slash` no-access state. See coordinator decisions below.
| `CrossClusterDashboardView.swift` | `CrossClusterDashboardView – Light` (`…f1808f1bd0c3`) | `CrossClusterDashboardView – Dark` (`…f18094a306c8`) | F2 (#128). Full MainView chrome (titlebar+toolbar unified, sidebar split). Header (title + relative timestamp + refresh), 2×2 summary grid (Pods/Deployments/Services/Clusters), `CLUSTER DETAILS` section with 3 cluster-card rows (online / RBAC limited / offline), inline `EMPTY STATE` preview region. See coordinator decisions below.
| `NamespaceListView.swift` (legacy "Namespace View") | `macOS - Namespace View – Light` (`…de69288179bd`) | `macOS - Namespace View – Dark` (`…dfabc1bf1d7d`) | |
| `PodListView.swift` | `PodListView - Data - Light` (`…e1114316c0a9`) | `PodListView - Data - Dark` (`…e11146884398`) | Loading / empty / error states missing |
| `DeploymentListView.swift` | `DeploymentListView - Data - Light` (`…e1114a7964ea`) | `DeploymentListView - Data - Dark` (`…e1114caa7f96`) | Loading / empty / error states missing |
| `ServiceListView.swift` | ❌ not modelled | ❌ not modelled | Reuses 4-state list pattern |
| `ConfigMapListView.swift` | ❌ not modelled | ❌ not modelled | Reuses 4-state list pattern |
| `SecretListView.swift` | ❌ not modelled | ❌ not modelled | Reuses 4-state list pattern |
| `IngressListView.swift` | ❌ not modelled | ❌ not modelled | Reuses 4-state list pattern |
| `HelmReleaseListView.swift` | ❌ not modelled | ❌ not modelled | Reuses 4-state list pattern |
| `DeploymentDetailView.swift` | `macOS - Deployment Detail – Light` (`…de696c84b705`) **+** `DeploymentDetailView - Populated - Light` (`…e1114f56b05a`) | `macOS - Deployment Detail – Dark` (`…dfaeef6e573c`) **+** `DeploymentDetailView - Populated - Dark` (`…e11151698255`) | Two versions co-exist |
| `ResourceDetailView.swift` (Pod variant) | `ResourceDetailView - Pod Detail - Light` (`…e11153b98ed2`) | `ResourceDetailView - Pod Detail - Dark` (`…e111552cad20`) | Other resource kinds (Deployment / Service / ConfigMap / Secret / Ingress / HelmRelease) not modelled |
| `LogsView.swift` | `Logs & Errors Panel – Light` (`…deb5e43c7849`) **+** `LogsView - Populated - Light` (`…e1113796c50a`) | `Logs & Errors Panel – Dark` (`…dfaa6c87d885`) **+** `LogsView - Populated - Dark` (`…e1113a502e5b`) | Two versions co-exist; consolidate |
| `ErrorBannerView.swift` | `Error Banner Inline – Light` (`…deb5e55a154a`) | `Error Banner Inline – Dark` (`…dfaf4b7f9863`) | Should become `common/feedback/banner/error` |
| `PreferencesView.swift` (General) | `PreferencesView - General - Light` (`…e1113d504e3f`) **+** legacy `macOS - Preferences – Light` (`…de6995690e20`) | `PreferencesView - General - Dark` (`…e1113e2db66b`) **+** legacy `macOS - Preferences – Dark` (`…dfaaa38ea8de`) | Legacy + new variants — converge |
| `PreferencesView.swift` (Appearance) | `PreferencesView - Appearance - Light` (`…e1113f3057e3`) | `PreferencesView - Appearance - Dark` (`…e11140137aab`) | |
| `PreferencesView.swift` (Advanced) | `PreferencesView - Advanced - Light` (`…e11141154c39`) **+** legacy `Preferences – Advanced (TLS) – Light` (`…de8ff7e8677a`) | `PreferencesView - Advanced - Dark` (`…e111420591a3`) **+** legacy `Preferences – Advanced (TLS) – Dark` (`…dfaadd7bc3c2`) | Two co-existing variants |
| `MenuBarContextView.swift` | `MenuBarContextView - Light` (`…e11156d4f4b6`) | `MenuBarContextView - Dark` (`…e111578b8c17`) | |
| Resource Browser (composite, see `MainView`) | `Resource Browser – Light` (`…dfafa9087d50`) | `Resource Browser – Dark` (`…dfaff71ab655`) | Not bound to a single Swift file — represents the Sidebar + Detail composition |
| App icon | `CubeLite Icon — on Light` (`…df93cdce112b`) | `CubeLite Icon — on Dark` (`…df93cdd8e33f`) **+** `CubeLite Icon — Transparent` (`…df93cde1d0fd`) | Linked to the `cubelite-icon` library component |

### 2.1 Light/Dark coverage summary

- **Modelled screens with both modes**: 19 / 19 = **100%** of modelled screens
  (DashboardView added in F1 / #127, CrossClusterDashboardView added in F2 / #128).
- **Swift views without any Penpot board**: 5 — `ServiceListView`,
  `ConfigMapListView`, `SecretListView`, `IngressListView`,
  `HelmReleaseListView`.
- **List views with only the data state** (missing loading / empty / error
  variants): `PodListView`, `DeploymentListView`. The other five list views
  inherit the same 4-state pattern.

### 2.2 F1 (#127) DashboardView — coordinator decisions

Decisions applied when authoring `DashboardView – Light` and `DashboardView – Dark`:

1. **Tile count = 9** in exact Swift source order: Pods, Deployments, Services,
   Namespaces, Secrets, ConfigMaps, Ingresses, Helm Releases, Cluster. Swift
   source (`apps/macos/cubelite/cubelite/Views/DashboardView.swift`) is
   authoritative — no UI-only invented tiles.
2. **Layout = full window with standard MainView chrome**: unified titlebar +
   toolbar (`#E8E8E8` light / `#2C2C2E` dark), traffic lights, sidebar split
   matching other `MainView – *` boards. Cluster name surfaces in the toolbar
   ("minikube · default") and sidebar selected row — not as an in-content
   header. Dashboard content is the LazyVGrid of 9 tiles inside the ScrollView
   area only. Board height extended to `880pt` to fit all 9 tiles without
   relying on scroll-clipping in the static screenshot.
3. **No-access state copy mirrors Swift values** exactly: `lock.slash` SF Symbol
   + title `"No access"` + subtitle `"RBAC restricted"`. Demonstrated on the
   Secrets tile (RBAC commonly restricts secrets) in both light and dark
   boards.

### 2.3 F2 (#128) CrossClusterDashboardView — coordinator decisions

Decisions applied when authoring `CrossClusterDashboardView – Light` and
`CrossClusterDashboardView – Dark`:

1. **Swift source is authoritative** for layout, fields, and copy. The Swift
   view at `apps/macos/cubelite/cubelite/Views/CrossClusterDashboardView.swift`
   composes a header row + a 2×2 `LazyVGrid` of `DashboardCard`s
   (Pods / Deployments / Services / Clusters) + a vertical list of
   `ClusterSnapshotRow`s — **not** a uniform card grid as the F2 issue
   acceptance criteria text suggested. The boards mirror the Swift composition
   verbatim. Per-cluster fields are: `contextName`, status indicator color,
   subtitle (namespace count / RBAC summary / error message), Pods / Deploys /
   Svc metric badges. The AC's "namespace count" is part of the subtitle in
   the online state; "last-sync timestamp" is a single global string in the
   header ("Updated X ago"), **not** per cluster — Swift renders no per-row
   timestamp.
2. **Layout = full MainView chrome** (per F1 precedent): unified titlebar +
   toolbar (`#E8E8E8` light / `#2C2C2E` dark), traffic lights, sidebar split.
   Toolbar surfaces `All Clusters` with a teal `server.rack` icon stand-in
   instead of the per-cluster `minikube · default` shown on `DashboardView`.
   Sidebar shows `All Clusters` selected at the top, with the three sample
   clusters (`minikube`, `staging-eu`, `dev-local`) listed below as unselected
   contexts. Board height extended to `1100pt` to fit the inline empty-state
   preview region.
3. **Three sample cluster-card rows** demonstrate the canonical states from
   Swift: `default` (online, green dot, namespace count subtitle),
   `rbac` (orange dot, `Limited: no access to …` subtitle), `offline`
   (red dot, `Connection refused` subtitle, no metric badges). Card layout
   follows `common/data/cluster-card`.
4. **Empty state copy mirrors Swift values exactly** — Swift's
   `ContentUnavailableView` renders title `"No Data"` + subtitle
   `"Tap refresh to load cluster data."` with the `icloud.slash` SF Symbol.
   The F2 issue AC suggested `"No clusters configured"`; Swift wins. Empty
   state is shown inline in a labelled `EMPTY STATE` preview region at the
   bottom of the board (rather than a separate board variant) so the populated
   and empty UIs are visible in a single screenshot. The yet-to-be-built
   `common/feedback/empty-state` molecule (audit §3.4 gap) is intentionally
   **not** created here — out of F2 scope.
5. **Cluster-card molecule** (`common / data / cluster-card`,
   `…f17f4b20ea55`) was created on the **Common Elements** page with light +
   dark columns showing all three row states. The screen boards inline the
   same shape semantics (named under `screen / cross-cluster-dashboard /
   cards / <slug> / …`) — Penpot library-component instancing is deferred
   until the kit-* atoms are promoted in F7 (`#143`).

---

## 3. Common element inventory

The kit-* atoms on **States & Components** are the current de-facto common
library. They are catalogued on the new **Common Elements** page and grouped
by category below.

### 3.1 controls/

| Common id | Existing kit board(s) | HIG rating | Notes |
|---|---|---|---|
| `common/controls/button/primary` | `kit-button-light` / `kit-button-dark` (+ hover/pressed/disabled) | ✅ | Already has full state coverage |
| `common/controls/button/secondary` | _none_ | ❌ gap | Add neutral fill variant |
| `common/controls/button/destructive` | _none_ | ❌ gap | System red |
| `common/controls/button/icon` | _none_ | ❌ gap | 28×28pt SF Symbol-only |
| `common/controls/toggle` | `kit-toggle-on/off-light/dark` | ✅ | 4pt frame width drift between on/off (P3, see HIG report §1.4) |
| `common/controls/checkbox` | `kit-checkbox-checked/unchecked-light/dark` | ⚠️ **P1** | 18×18pt — under HIG 20pt minimum; dark unchecked missing border |
| `common/controls/text-field` | `kit-formfield-light/dark` (+ focused, disabled) | ✅ | |
| `common/controls/dropdown` | `kit-dropdown-light/dark` (+ hover, disabled) | ✅ | Chevron is a placeholder rectangle (verify SF Symbol in code) |
| `common/controls/segmented-control` | `kit-tabbar-light/dark` | ✅ | |

### 3.2 chrome/

| Common id | Existing kit board(s) | HIG rating | Notes |
|---|---|---|---|
| `common/chrome/titlebar` | `kit-titlebar-light/dark` | ✅ | |
| `common/chrome/sidebar` | implicit in MainView boards | ⚠️ | Extract to dedicated component |
| `common/chrome/sidebar/list-row` | implicit | ⚠️ | Extract — every screen redraws it |
| `common/chrome/sidebar/section-header` | implicit | ⚠️ | Extract |
| `common/chrome/toolbar` | _none_ | ❌ gap | Standard 38pt toolbar |
| `common/chrome/status-bar` | `kit-statusbar-light/dark` | ✅ | |
| `common/chrome/separator` | `kit-separator-light/dark` | ✅ | |

### 3.3 data/

| Common id | Existing kit board(s) | HIG rating | Notes |
|---|---|---|---|
| `common/data/table/header-row` | implicit in list view boards | ⚠️ | Extract |
| `common/data/table/data-row` | implicit | ⚠️ | Extract |
| `common/data/key-value-row` | implicit in detail boards | ⚠️ | Extract |
| `common/data/badge/status` | `kit-badge-error/warn/info-light/dark` | ✅ | |
| `common/data/badge/count` | _none_ | ❌ gap | Sidebar count chips |
| `common/data/cluster-card` | `common / data / cluster-card` (`…f17f4b20ea55`) | ✅ | Built for F2 (#128). Light + dark columns showing all three row states (online / RBAC limited / offline) following Swift's `ClusterSnapshotRow`. Used in `CrossClusterDashboardView – Light/Dark`. |
| `common/data/resource-count-tile` | `common / data / resource-count-tile` (`…f17bd3ff6c0e`) | ✅ | Built for F1 (#127). Documents both populated + `no-access` (RBAC restricted) variants in light + dark. Used in `DashboardView – Light/Dark`. |
| `common/data/log-row` | `kit-logrow-light/dark` | ✅ | |

### 3.4 feedback/

| Common id | Existing kit board(s) | HIG rating | Notes |
|---|---|---|---|
| `common/feedback/banner/error` | inline boards `Error Banner Inline – Light/Dark` | ⚠️ | Promote to component |
| `common/feedback/banner/warning` | _none_ | ❌ gap | |
| `common/feedback/banner/info` | _none_ | ❌ gap | |
| `common/feedback/empty-state` | _none_ | ❌ gap | Centralise the SF Symbol + title + body + CTA pattern |
| `common/feedback/loading` | _none_ | ❌ gap | `ProgressView()` + 13pt label |
| `common/feedback/no-access` | _none_ | ❌ gap | "No access / RBAC restricted" (used in `DashboardView`) |

### 3.5 identity/

| Common id | Existing kit board(s) | HIG rating | Notes |
|---|---|---|---|
| `common/identity/app-icon` | library component `cubelite-icon` | ✅ | |
| `common/identity/wordmark` | _none_ | ❌ gap | |
| `common/identity/lockup` | _none_ | ❌ gap | |

---

## 4. Gaps vs. current Swift code

Issues uncovered while mapping Swift to Penpot. Each item should become a
follow-up issue tracked under #73.

1. **5 missing screen sets** (light + dark each, so 10 boards total) for
   `ServiceListView`, `ConfigMapListView`, `SecretListView`, `IngressListView`,
   `HelmReleaseListView`. (`DashboardView` delivered in F1 / #127;
   `CrossClusterDashboardView` delivered in F2 / #128.)
2. **List 4-state coverage** — only the data state exists. Add loading,
   empty, error boards for every list view, sharing the
   `common/feedback/loading` / `empty-state` / `banner/error` components.
3. **Resource detail variants** — only the Pod detail is modelled; the same
   structure renders for Deployment, Service, ConfigMap, Secret, Ingress,
   HelmRelease.
4. **Duplicated boards** — `macOS - Preferences – *` co-exists with
   `PreferencesView - General - *`. Same for Advanced/TLS, Logs and
   Deployment Detail. Pick the newer set, archive the legacy with a
   `[LEGACY]` prefix on the name.
5. **No Penpot tokens configured** — `penpot.library.local.tokens.sets`
   is empty. Import `design/tokens.json` so colors/sizes can be bound.
6. **Component reuse missing** — every kit-* atom is a stand-alone board
   instead of a Penpot library component. Promote the kit-* boards to
   components so screens can instance them.
7. **Orphan shapes on the macOS Native page** (15 items): `test-rect-dims`,
   `child-rect`, `section-heading-icon`, `section-subheading-icon`,
   `pref-title`, `design-note-mono`, plus 9 unnamed `Text` shapes. Move
   them under a quarantine board or delete (follow-up cleanup PR).
8. **Identifier coverage** — top-level boards already carry meaningful
   names but their child shapes mostly do not follow the `screen/...`
   pattern. Apply the convention progressively (one screen per PR).
9. **Checkbox sub-spec** (P1) — `kit-checkbox-*` is 18pt; raise to 20pt
   (HIG absolute minimum). Verify Swift implementation does not also
   render at 18pt.
10. **Dropdown chevron** — visually a rectangle in `kit-dropdown-*`. Verify
    Swift uses the SF Symbol `chevron.down` and update the Penpot artwork
    to match.

---

## 5. Apple HIG notes

Repeating only the items that affect the audited screens; the full HIG
review lives in `docs/hig-review-report.md`.

- **Body text 13pt minimum**, never below 10pt — honoured in current boards.
- **Control hit target ≥ 20×20pt** — checkbox kit fails (see §4.9).
- **Use system semantic colors** — current kit uses literal hex values that
  match the macOS system palette; once Penpot tokens are imported, every
  fill must bind to a token, not a hex.
- **Sidebar icons follow user accent** — do not pin a hard color. Verify
  every sidebar row icon in `MainView – *` boards is annotated with
  "tint = accent" rather than a fixed fill.
- **Light + Dark are mandatory** — currently every modelled screen has
  both. Maintain parity for every new screen.
- **Don't rely on color alone** — `DashboardView` uses both an icon
  (`lock.fill`) and the text "RBAC restricted" for the no-access state. Keep
  this pattern across new screens.

---

## 6. What this PR ships

- **Conventions page** in Penpot with light + dark cards documenting the
  identifier patterns, modes, HIG ground truth and file organisation.
- **Common Elements page** with light + dark catalogue cards listing every
  reusable atom/molecule together with its current `kit-*` source.
- **This audit document** under `docs/penpot-macos-audit.md`.

This PR is **docs/config-only** and intentionally does not modify any
SwiftUI code or existing Penpot screen artwork.

---

## 7. Follow-up issues to file under #73

| # | Title | Owner |
|---|---|---|
| F1 | design(macos): create Penpot boards for `DashboardView` (light + dark) | design-agent |
| F2 | design(macos): create Penpot boards for `CrossClusterDashboardView` (light + dark) | design-agent |
| F3 | design(macos): list-view 4-state coverage (loading / empty / error / data) for all 7 list views | design-agent |
| F4 | design(macos): `ResourceDetailView` variants for Deployment, Service, ConfigMap, Secret, Ingress, HelmRelease | design-agent |
| F5 | design(macos): converge legacy + new Preferences / Logs / Deployment Detail board sets | design-agent |
| F6 | design(macos): import `design/tokens.json` into Penpot token sets and bind kit-* fills | design-agent |
| F7 | design(macos): promote kit-* atoms to Penpot library components | design-agent |
| F8 | design(macos): clean up orphan shapes on macOS Native page | design-agent |
| F9 | design(macos): apply `screen/*` identifier convention to existing screens (incrementally, one per PR) | design-agent |
| F10 | design(macos): raise checkbox to 20pt in kit-* and verify Swift parity | design-agent + macos-agent |
| F11 | design(macos): replace dropdown chevron placeholder with SF Symbol artwork in kit-* | design-agent |
