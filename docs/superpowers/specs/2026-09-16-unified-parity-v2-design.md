# Unified Parity v2 — desktop ↔ macOS native alignment

**Date**: 2026-09-16
**Status**: approved design, pending implementation plan
**Scope**: `apps/desktop`, `apps/macos`, `design/`, `docs/`
**Supersedes**: none. Extends the Design System v1 handoff
(`design/design_handoff_cubelite_ui/README.md`) with the deviations listed in §1.

## 0. Problem

Side-by-side run of both apps (2026-09-16, cluster `aks-test-01-emm`) showed
drift from the unified design and from each other:

| Area | Desktop | Native | Spec (handoff v1) |
|---|---|---|---|
| Overview | 4 stat cards + Capacity + Recent warnings | same + 8 per-resource summary cards | 4 stat + Capacity + warnings |
| Stat cards | plain value | icon + ratio (`107/119`, `28/28`) | plain value |
| Capacity | percent only, accent fill, warn > 60, err > 75 | absolute values (`0.7 / 23.2 cores`), ok/warn ≥ 70/err ≥ 90 | accent, warn > 60, err > 75 |
| Sidebar · Observe | Events, Logs | Logs only | Events, Logs |
| Titlebar | dot · name · provider chip · state · search ⌘K · namespace | dot · name · state · namespace (renders empty) · refresh · bell | dot · name · chip · state · search · namespace |
| Status bar | server · k8s version · refresh · warnings→Events | refresh · app errors | server · version · refresh · warnings |
| Typography | Geist, tokens (`type-*`), body 12.5px, 38 hard-coded `text-[Npx]` | SF via `scaledFont`, 161 `.font(.system…)`, 125 raw system colors in Views | Geist/Geist Mono everywhere, tokenised scale |

Neither app is the reference. The reference is the token set plus the handoff
README, amended as below.

## 1. Approved deviations from handoff v1

These become part of the spec; the handoff README gets a "v1.1 amendments"
section pointing here.

1. **Overview resource grid** (from native) is adopted on both apps.
2. **Stat cards** show an icon and a ratio where meaningful (`running/total`,
   `healthy/total`).
3. **Capacity** meters show absolute values under each bar.
4. **Type scale** moves up by 0.5–1 px (see §2). Section headers no longer
   fall below the Apple HIG 10 pt minimum.
5. **Manual refresh** is ⌘R / Ctrl+R plus a palette action on both apps. The
   header carries no refresh or bell buttons.
6. **Native-only extra**: the status bar keeps the app-error count on the
   right (opens the Diagnostics panel). Desktop has no diagnostics panel;
   tracked as a separate follow-up, not part of this work.

## 2. Typography

### 2.1 Token scale (`design/tokens.json` → `font.style`)

| Style | Before | After | Use |
|---|---|---|---|
| display | 600 28px sans | 600 28px sans | onboarding hero |
| title | 600 16px sans | 600 16px sans | view titles |
| subtitle | 600 13px sans | 600 13.5px sans | modal titles, titlebar cluster name, card titles |
| body | 500 12.5px sans | 500 13px sans | nav, buttons, rows |
| caption | 400 11px sans | 400 11.5px sans | descriptions, meta |
| section | 600 9.5px sans · uppercase · ls .07em | 600 10px sans · uppercase · ls .07em | sidebar/palette section headers |
| colhead | 600 10.5px sans · uppercase | 600 11px sans · uppercase | column headers, card labels |
| data | 500 12px mono | 500 12.5px mono | resource names |
| data-sm | 400 11.5px mono | 400 12px mono | cells, metrics |
| log | 400 11px mono | 400 11.5px mono | log lines |
| stat | (new) | 600 22px mono | stat card values |

Line heights unchanged. `kbd` chips and status pills stay at 10.5px via a new
`micro` style (`500 10.5px sans`) so nothing is hard-coded.

### 2.2 Generator (`design/export-tokens.ts`)

- CSS: unchanged mechanism; the `@utility type-*` blocks in `app.css` move
  inside the generated region and are emitted from tokens (they are hand-written
  today). Adds `type-stat` and `type-micro`.
- Swift: emit a new `DesignTokens.Type` namespace:

```swift
public enum Type {
    public struct Style: Sendable {
        public let size: CGFloat
        public let weight: Font.Weight
        public let mono: Bool
        public let uppercase: Bool
        public let tracking: CGFloat  // em
    }
    public static let body = Style(size: 13, weight: .medium, mono: false, uppercase: false, tracking: 0)
    // …one per token
}
```

### 2.3 Native font bundling

- Vendor `Geist-Variable.otf` and `GeistMono-Variable.otf` (OFL) under
  `apps/macos/cubelite/cubelite/Resources/Fonts/`, add to the app target,
  set `ATSApplicationFontsPath = Fonts` in `Info.plist`.
- New helper `Helpers/TypeStyle.swift`:

```swift
extension View {
    /// Applies a Design System type style: Geist / Geist Mono via Font.custom,
    /// scaled with @ScaledMetric like scaledFont, falling back to the system
    /// family if the bundled font fails to load.
    func typeStyle(_ style: DesignTokens.Type.Style, color: Color? = nil) -> some View
}
```

  Internals reuse `ScaledFontModifier`'s anchor mapping. `uppercase` applies
  `.textCase(.uppercase)`; `tracking` applies `.tracking(size * tracking)`.
- `scaledFont(size:…)` stays for the migration period; new and touched code
  uses `typeStyle`. `LogBodyView` keeps its own mono path (performance) but
  reads size/weight from `DesignTokens.Type.log`.

### 2.4 Desktop

- Replace the 38 `text-[Npx]` occurrences with `type-*` utilities
  (`text-[22px]` → `type-stat`, `text-[10.5px]`/`text-[10px]` → `type-micro`,
  `text-[13.5px]` palette input → `type-subtitle` at regular weight). Rule:
  after PR 1 the desktop lint in §5 reports zero `text-[` occurrences.
- `Kbd`, `StatusPill`, `StatCard`, palette rows and drawer meta grids are the
  main consumers.

## 3. Native shell parity

### 3.1 `UnifiedHeaderView`

Left to right: identity dot · context name (`subtitle`) · provider chip
(mono `micro`, identity colour on identity-12% background, radius 4; provider
detection ported from desktop `provider.ts` into `Shell/IdentityHelpers.swift`)
· connection badge · spacer · **search button** (240pt, `surfaceWindow`,
border, radius 6, magnifier, placeholder "Search & switch…", `⌘K` kbd; opens
the command palette) · **namespace dropdown**.

Namespace dropdown is rebuilt as a plain `Button` with a `.popover`
(`surfaceOverlay`, `borderStrong`, per-namespace pod counts, active row
accent-14%) instead of `Menu(.borderlessButton)`, which renders its own
indicator and drops the label in the current build (the empty "namespace:"
seen in the screenshot). The label reads `namespace: <mono value>` + chevron.

Refresh and bell buttons are removed. `MainView` binds ⌘R to `refreshAll()`
through a `.commands` `CommandGroup` ("Refresh", ⌘R) and adds the palette
action "Refresh cluster data". The Diagnostics panel is reachable from the
Window menu ("Diagnostics", ⇧⌘D; ⌘D is already taken) and from the status-bar
error count. ⌘R is currently unused in both apps.

### 3.2 `StatusBarView`

`server · k8s <version> · refresh <interval>` on the left (mono `micro`,
`textTertiary`, server truncated middle); right: `N warnings` in `statusWarn`
(→ Events view) then `N errors` (→ Diagnostics). `clusterVersion` and the
server URL already exist on `ClusterState` / kubeconfig context.

### 3.3 Events view

- `ResourceType.events = "Events"`, `systemImage: "exclamationmark.bubble"`,
  placed in the Observe section before Logs. `MainViewStateTests` count goes
  14 → 15.
- `KubeAPIService.listEvents(namespace:inContext:)` returns all event types
  (the existing `listWarningEvents` stays for the overview and status bar).
  `ClusterState.events: [EventInfo]`; `EventInfo` gains `type: String?`
  ("Normal"/"Warning"), mapped from the already-decoded API `type` field.
  `lastTimestamp` stays a `String?` (ISO 8601) and is parsed by the age
  formatter, as the overview already does.
- `Views/EventListView.swift`: table `TYPE / REASON / OBJECT / MESSAGE / AGE`
  with grid `0.7 / 1 / 1.4 / 2.6 / 0.5 fr`; Type pill (Warning = warn-10%
  background, Normal = `surfaceRaised`), warning rows warn-4% background,
  reason mono, empty state centred `caption` `textDisabled`. Loaded through
  `MainView+ResourceLoader` like other kinds; forbidden → existing forbidden
  badge pattern.

## 4. Overview parity

Both apps render the same structure top-to-bottom:

1. **Stat row** (4 cards): Nodes · Pods running `running/total` · Deploys
   healthy `healthy/total` · Warnings. Card: icon (Lucide on desktop, SF Symbol
   on native, 12pt semibold, tinted) + label `colhead` + value `type-stat`.
   Icon tints: nodes `accent-alt-teal`, pods `cluster-blue`, deployments
   `cluster-violet`, warnings `statusWarn` when > 0 else `textTertiary`.
2. **Capacity card**: `MeterBar` CPU / MEM; sub-label `data-sm` `textTertiary`
   `<used> / <allocatable> <unit>` (cores with one decimal, GiB with one
   decimal). Thresholds unified: fill `accent` < 60%, `statusWarn` ≥ 60%,
   `statusErr` ≥ 75%. Native `MeterBarView` changes from ok/70/90.
   "metrics unavailable" caption when metrics-server is absent (both).
3. **Recent warnings card**: up to 5 rows, "All events →" link to Events on
   both (native adds the link).
4. **Resource grid** (2 columns, `xl:` on desktop; single column below):

| Card | Metrics | Tones |
|---|---|---|
| Pods | Total · Running · Pending · Failed | ok · warn · err |
| Deployments | Total · Healthy · Degraded | ok · warn |
| Services | Total · ClusterIP · NodePort · LoadBalancer | — · warn · accent |
| Namespaces | Total · Active | ok |
| Secrets | Total · Opaque · TLS · Docker | — · accent · warn |
| ConfigMaps | Total | — |
| Ingresses | Total · with TLS | — · accent |
| Helm Releases | Total · deployed · failed | ok · err |

Card: title `subtitle` + tinted icon, divider, metric rows
(`body` label `textSecondary`, value `data` right-aligned in tone colour).
Card tints use the same palette as the sidebar section dots (workloads
`cluster-blue`, network `cluster-violet`, config `statusWarn`, namespaces
`accent-alt-teal`). RBAC-forbidden kinds show the "forbidden" badge in place of
the metric list. Numbers come from a pure summary model so both apps count
identically:

- Desktop: `apps/desktop/src/lib/overview-summary.ts` (`summarize(resources)`),
  unit-tested.
- Native: `Models/OverviewSummary.swift` (`OverviewSummary(state:)`),
  unit-tested. Existing inline `filter{}.count` chains in `OverviewView.swift`
  move there.

Desktop data loading: `OverviewView` calls `resources.loadKind` for
`services`, `ingresses`, `configmaps`, `secrets`, `helm` on mount through a
new `resources.loadOverviewExtras()` (single `Promise.allSettled`, sequence
guarded like `loadKind`, forbidden recorded per kind in a new
`resources.forbiddenKinds: Set<ExtraKind>`). Auto-refresh re-runs it only
while the overview is the active view.

Native re-skin: `DashboardCard` / `DashboardMetric` / `statCard` switch from
system colours (`.blue`, `.green`, `.secondary`) to `DesignTokens` and from
`.font(.system…)` to `typeStyle`.

## 5. Design audit

Script `scripts/design-lint.sh` (run in CI for both stacks, non-blocking
warning first, blocking once the counts below reach zero):

- desktop: `text-[` px classes and raw `#hex` in `src/**/*.svelte` outside
  `app.css` → 0 allowed.
- native: `.font(.system` / `.font(.title…)` and raw system colours
  (`\.(blue|green|orange|red|purple|indigo|teal|yellow)\b`) under `Views/`
  → allow-list file `scripts/design-lint-allow.txt` for the residue.

This work fixes: `Views/Shell/*`, `OverviewView`, `MainView+Sidebar`,
`StatusBarView`, `UnifiedHeaderView`, `PodListView`, `DeploymentListView`,
`EventListView` (new), and all desktop `text-[Npx]`. Everything else goes into
`docs/design-audit-2026-09.md` with counts per file and a tracking issue.

The a11y contrast table (`docs/a11y/contrast-audit.md`) gets a row per new
size confirming AA is still met (colours unchanged, so only the ≥ 10 pt rule
and the 3:1 non-text rule are re-checked).

## 6. Testing

Desktop (vitest, jsdom):
- `overview-summary.test.ts` — counts per card, forbidden propagation.
- `OverviewView` render test — stat ratios, absolute capacity labels,
  forbidden badge, "All events" navigation.
- `StatusBar` and `CommandPalette` tests — Refresh action, ⌘R handler.
- Existing `shell.test.ts` updated for the type utilities.

Native (XCTest):
- `OverviewSummaryTests`, `EventListViewModelTests` (decode + age),
  `StatusBarViewTests` (labels), `TypeStyleTests` (token → Font mapping,
  fallback when custom font missing), `MainViewStateTests` (15 cases).
- UI tests keep passing with the `-skip-testing cubeliteUITests` CI setup.

Manual gate before each PR merge: both apps launched against the same
cluster, screenshots attached to the PR (dark, default text size).

## 7. Delivery

Branch `design/unified-parity-v2` off `main`; four stacked PRs, each green on
CI on its own:

1. `design(tokens): type scale v1.1 + Swift Type tokens + Geist bundle`
   (§2; desktop px migration; native `typeStyle` helper; no layout changes).
2. `feat(macos): unified header/status/⌘R + Events view` (§3).
3. `feat(overview): shared summary model + resource grid on both apps` (§4).
4. `chore(design): lint script, audit report, handoff v1.1 amendments` (§5).

Issues: one per PR, labelled `area:desktop`/`area:macos` + `type:feat` or
`type:chore`, all linked to a tracking issue "Unified parity v2".

## 8. Out of scope

Light theme, desktop diagnostics panel, Penpot board updates, Windows/Linux
font rendering tuning, the 161/125 residue outside the files listed in §5.
