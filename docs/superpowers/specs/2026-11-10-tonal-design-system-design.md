# Tonal design system: restyle of the desktop app — design

Status: for approval · 2026-11-10 · desktop (`apps/desktop`), tokens (`design/`) · epic #604
Design system (tokens, usage rules, base components): https://claude.ai/artifact/NhxxZZksmWfXA5FyA2vr3d
Direction mockups: https://claude.ai/artifact/WTEghwFNebpse3mEs7isKt — board **C · Expressive Tonal** is
the chosen direction (A Glass Deck and B Calm Graphite were declined).

## 1. Intent

The current look (zinc neutrals, Geist, 28 px controls, hairline tables) dates from the v1 unified
identity of early 2026. The user asked for a design system in line with 2026 UI practice and chose
direction C on visual impact, then asked that **every scenario** be covered before implementation.

Three ideas define C:

1. **The tint is the cluster.** Surfaces, selection and the primary action take their hue from the
   active cluster. On a tool used across many clusters, "which cluster am I on" stops being an
   8 px dot and becomes the colour of the window.
2. **Shape repeats state.** Healthy is a circle, attention a triangle, failure a square. Nothing is
   shown by colour alone (today 14 places are — §9.3).
3. **One thing leads.** One large title per view, one status hero per detail panel, one primary
   button per panel or dialog.

Primary user (unchanged): a DevOps / platform / SRE engineer with many clusters open all day.
Commitments kept: local-first, light and fast, multi-cluster at a glance, keyboard first,
accessible, destructive actions explicit and confirmed.

## 2. Goals, non-goals, anti-goals

Goals
- Every screen, overlay and state in §8–§9 restyled with the tokens in §4; no component left on the
  old look at release.
- Both themes are first-class: every text pair holds WCAG AA on all five cluster tints, enforced by
  tests (§4.6).
- No state shown by colour alone.
- At the default window (1360 × 860) the Pods list shows at least 13 rows in default density and 15
  in compact.
- The existing behaviour contracts hold: sidebar does not scroll at 1280 × 800 (profiles and
  custom-resources e2e), Esc closes the topmost overlay, resource names are never links.

Non-goals
- New features. The resource relationship diagram is #605 and gets its own design.
- List virtualisation, a tooltip component (native `title` stays), translations, text scaling.
- Fixing the hand-rolled log menus that do not close on outside click (restyled only; noted in §12).
- Changes to `crates/cubelite-core`.

Anti-goals
- A release where half the app is on the old look. The work ships as one release (§11).
- A tint that makes a failure harder to see. Identity hues stay out of the warm half of the wheel.
- Losing density silently: compact density must stay close to today's row count.

## 3. Behaviour changes (beyond styling)

These are visible changes in how the app works. Each is my call unless marked confirmed.

| # | Change | Why |
|---|---|---|
| 1 | The detail panel **opens on selection** and docks beside the list when the content area is at least 1000 px wide; below that it overlays the list as today. (confirmed in conversation) | C's layout; nothing is hidden behind the panel any more |
| 2 | With the panel docked, a list keeps at most five identifying columns; the others move into the panel (§8.3). With nothing selected the list shows every column. (confirmed) | The list is 628 px wide when docked |
| 3 | Preferences → **Accent** is removed. The accent is the active cluster's tint. | One source of colour |
| 4 | Cluster colours become **teal, blue, indigo, violet, magenta**. Saved `amber` becomes `indigo`, saved `pink` becomes `magenta`. | Amber and pink collide with warning and error once they tint the whole window |
| 5 | The **status bar is removed**. Kubernetes version moves into the cluster chip, the server address into its menu, the warnings count into a top-bar chip that opens Events; the refresh interval stays in Preferences. | C has no bottom strip; 27 px back to content |
| 6 | Sidebar **section dots are removed**, and Overview cards lose their per-resource tints. | Colour is reserved for tint and state |
| 7 | "Needs attention" (Pods) and "Warnings only" (Events) become **status chips** above the list: Failing, Pending, Running, Completed with counts; pressing one filters. "Needs attention" equals Failing + Pending. | C's header; the counts double as a summary |
| 8 | Default window 1200 × 800 → **1360 × 860**; minimum stays 800 × 600. | At 1200 the panel could never dock |
| 9 | Fonts: **Space Grotesk** (titles), **Inter** (interface), **JetBrains Mono** (data) replace Geist and Geist Mono. | Part of the chosen look |
| 10 | The "logs ↵" chip on the selected pod row is removed; Enter on a selected row still opens logs, and Logs is the panel's primary button. | The chip sat under the drawer |
| 11 | Deployment scale and restart controls stay in the row when the list is full width and move into the panel when it is docked. | Column budget |
| 12 | A switch that is on is `primary`, not green; INFO log lines are neutral. | Green and red mean health only |

## 4. Tokens

The design system artifact is the reference for values; `design/tokens.json` stays the source of
truth for the app and is regenerated into `app.css` by `pnpm design:tokens`.

### 4.1 Tint

- Every tinted token is `oklch(L C var(--cl-tint-h))`. Lightness and chroma are fixed per role and
  theme; only the hue varies.
- Identity hues: teal 190, blue 240 (default), indigo 275, violet 310, magenta 345.
- `--cl-tint-h` is set inline on `<html>` from the active cluster's identity (All Clusters
  dashboard and onboarding: 240). Changing cluster cross-fades colours over 240 ms.
- Token declarations apply to `:root, [data-tint]` (and their `.dark` forms), so a subtree can be
  re-tinted by setting `data-tint` and `--cl-tint-h` on it. Used by: rail avatars, dashboard cluster
  cards, palette cluster rows, onboarding cluster list, the log pop-out window root.

### 4.2 Colour roles (dark · light, as `L C H`; `T` = tint hue)

| Token | Dark | Light | Use |
|---|---|---|---|
| `surface-window` | .165 .030 T | .955 .020 T | Window ground |
| `surface-sunken` | .135 .022 T | .935 .022 T | Logs, YAML, terminal |
| `surface-container` | .215 .036 T | .990 .005 T | List and dashboard card |
| `surface-container-high` | .275 .045 T | .930 .030 T | Detail panel, chips, hover |
| `surface-container-top` | .330 .050 T | .975 .012 T | Tiles and controls on the panel |
| `surface-overlay` | .290 .045 T | .995 .003 T | Modals, palette, menus, toasts |
| `outline` | .400 .040 T | .840 .030 T | Decorative hairlines |
| `outline-strong` | .600 .045 T | .560 .045 T | Input and control borders (3:1) |
| `text` | .950 .012 T | .220 .030 T | Primary text |
| `text-muted` | .830 .025 T | .380 .030 T | Cells, inactive nav |
| `text-subtle` | .750 .030 T | .470 .030 T | Labels, counts (not on `surface-sunken`) |
| `primary` / `on-primary` | .840 .090 T / .250 .070 T | .450 .140 T / .990 .006 T | Main action, focus, meters |
| `primary-container` / `on-primary-container` | .400 .090 T / .940 .030 T | .870 .070 T / .280 .090 T | Selected row, active nav, tonal buttons |
| `success` | .820 .140 158 | .480 .120 158 | Circle glyph |
| `success-container` / `on-…` | .360 .070 158 / .930 .070 158 | .920 .060 158 / .340 .080 158 | Following chip, success toast |
| `warning` | .850 .140 88 | .480 .100 75 | Triangle, warning text |
| `warning-container` / `on-…` | .400 .080 85 / .940 .070 90 | .920 .090 92 / .360 .080 75 | Warning badge, paused chip |
| `error` | .780 .130 24 | .520 .190 27 | Square, failure text, destructive text button |
| `error-container` / `on-…` | .370 .110 25 / .930 .040 25 | .900 .050 25 / .380 .140 27 | Failure badge, status hero |
| `error-solid` / `on-error-solid` | .560 .200 27 / .985 .006 25 | .520 .200 27 / .985 .006 25 | Destructive confirm button only |
| `data-1` … `data-5` | hues 240, 190, 310, 275, 345 | same hues | Chart series, log sources, JSON values; never tinted |

Some high-chroma values fall slightly outside sRGB for some hues; browsers clip them, and the
contrast tests evaluate the clipped colour.

### 4.3 Type

| Style | Spec | Replaces |
|---|---|---|
| `display` | Space Grotesk 600 34/1, −0.02em | `title` (view titles), `display` |
| `stat` | Space Grotesk 600 32/1 | `stat` |
| `headline` | Space Grotesk 600 22/1.15, −0.01em | new: status hero, dialog titles, empty states |
| `title` | Inter 600 15/1.35 | `subtitle` |
| `body` | Inter 500 14/1.4 | `body` |
| `body-sm` | Inter 400 13/1.4 | `caption` (descriptions) |
| `label` | Inter 600 12/1.3, sentence case | `colhead`, `section`, `caption` (labels) |
| `micro` | Inter 500 11/1.2 | `micro` |
| `data` | JetBrains Mono 500 13/1.4 | `data` |
| `data-sm` | JetBrains Mono 500 12/1.35 | `data-sm` |
| `log` | JetBrains Mono 400 12/1.5 | `log` |

`type-caption` has 184 uses and splits two ways (`body-sm` or `label`); each use is decided when
its component is restyled. Uppercase labels disappear.

### 4.4 Shape, space, density

- Radius: `xs` 6 (key hints), `sm` 10 (failure badge), `md` 16 (rows, menu items, active avatar),
  `lg` 20 (tiles, inner cards, menus), `xl` 28 (cards, panel, dialogs, palette), `full` (buttons,
  chips, nav rows, fields, meters). `2xl` is retired.
- Spacing scale unchanged (4 · 8 · 12 · 16 · 20 · 24 · 32). Window gutter and gap between cards: 12.
- Density variables on `<html>`, swapped by `data-density="compact"` (extends today's mechanism):

| Variable | Default | Compact |
|---|---|---|
| `--row-h` (list rows; a fixed height replaces padding-based rows) | 46 | 38 |
| `--nav-h` (sidebar rows) | 38 | 32 |
| `--control-h` (buttons, fields, avatars) | 44 | 36 |
| `--control-inline-h` (controls inside a row) | 32 | 28 |
| `--chip-h` | 40 | 36 |
| `--control-primary-h` | 48 | 48 |

- Elevation: only `shadow-overlay`, only under `surface-overlay`. Cards have no shadow and no border.
- Motion: 160 ms colour, 240 ms panel and tint, 200 ms avatar shape; `cubic-bezier(0.2, 0, 0, 1)`;
  all instant under reduced motion.

### 4.5 Migration of names

Phase 1 points the old names at the new roles so the whole app recolours at once; later phases move
components to the new names; phase 9 deletes the aliases and makes the lint reject them.

| Old | New |
|---|---|
| `surface-window` · `sunken` · `panel` · `surface` · `raised` · `overlay` · `row-hover` | `surface-window` · `surface-sunken` · `surface-container` · `surface-container` · `surface-container-high` · `surface-overlay` · `surface-container-high` |
| `border-default` · `strong` · `faint` | `outline` · `outline-strong` · `outline` |
| `text-primary` · `secondary` · `tertiary` · `disabled` · `data-bright` · `log` | `text` · `text-muted` · `text-subtle` · `text-subtle` · `text` · `text-muted` |
| `accent` (and `alt-violet`, `alt-teal`) | `primary` |
| `status-ok` · `warn` · `err` · `err-solid` · `info` | `success` · `warning` · `error` · `error-solid` · `text-muted` |
| `cluster-*` used as identity | per-element tint (§4.1) |
| `cluster-*` used for charts, log sources, JSON values | `data-1` … `data-5` |
| `--alpha-selection-bg`, `--alpha-active-nav-bg` | `primary-container` |
| `--alpha-pill-*`, `--alpha-log-*-row` | the state's container token |
| radius `sm` `md` `lg` `xl` `2xl` (4 6 8 10 12) | redefined in place to 10 16 20 28 28; each use is corrected with its component |

`text-disabled` has no direct successor: a disabled control is `text-subtle` at reduced opacity and
carries no contrast requirement.

### 4.6 Pipeline

- `design/tokens.json`: colour tokens carry `[L, C, H]` per theme with `H` a number or `"tint"`.
- `design/export-tokens.ts`: emits `oklch()` values, the `:root, [data-tint]` selectors, the density
  variables and the new `type-*` utilities; drops the shadcn HSL bridge if nothing reads it, else
  derives it from the tint-240 colours.
- `apps/desktop/src/design/wcag.ts`: gains OKLCH → sRGB (clipped) so contrast is computed from the
  tokens. `tokens-contrast.test.ts` runs the pairing matrix for **both themes × five tints**:
  `text` and `text-muted` on every surface; `text-subtle` on every surface except sunken; each
  `on-*` on its fill; `primary`, `success`, `warning`, `error` as text on every surface; `data-*` on
  sunken, container, container-high and container-top (4.5:1); `outline-strong` on every surface and
  `success` on `primary-container` (3:1). All of these pass with the values above (checked while
  writing this spec; lowest text pair 4.72:1, lowest 3:1 pair 3.56:1).
- `scripts/design-lint.sh`: phase 9 adds the retired names (`type-caption`, `type-colhead`,
  `type-section`, `type-subtitle`, old colour names, `rounded-2xl`) to the rejected patterns.
- Fonts via `@fontsource` packages (bundled, offline); Geist packages removed in phase 9.

## 5. Layout

```
┌ macOS only: 36 px drag strip over rail + sidebar (window controls) ┐
│ rail 68 │ sidebar 232 │ top bar 44 (drag region)                   │
│         │             │ ┌ list card ───────────┐ ┌ detail panel ─┐ │
│         │             │ │ title · chips · rows │ │ 360, on select │ │
│         │             │ └──────────────────────┘ └────────────────┘ │
│         │             │ ┌ log panel (when open, spans both) ───────┐│
└─────────┴─────────────┴──────────────────────────────────────────────┘
```

- 12 px gutter around the content column and between cards. Rail and sidebar sit on
  `surface-window` with no card.
- **Top bar**: cluster chip (identity square, name, Kubernetes version; menu with server address,
  copy, reconnect), namespace chip, spacer, warnings chip (hidden at zero). It is the window drag
  region; chips are not.
- **Rail**: All Clusters, one 44 px disc per context with a health glyph, Preferences at the bottom.
  The active cluster becomes a `radius-md` square in `primary`. More contexts than fit: the avatar
  list scrolls, All Clusters and Preferences stay pinned.
- **Sidebar**: profile pill and Go-to button (⌘K), Pinned, All resources. Same structure and rules
  as the sidebar spec of 2026-11-07 (one section open at a time, only the open section's list
  scrolls). Hidden on the All Clusters dashboard, as today.
- **Detail panel**: docked or overlay is decided by a container query on the content column
  (≥ 1000 px docked), not by the window width, so it follows sidebar and rail changes.
- **Log panel**: a `surface-sunken` card under the list and the detail panel, resizable 160–560 as
  today. The `z-[35]` rule that lifts it above the drawer is kept only for overlay mode.
- Banners (update available, integrations) become one pill-shaped row above the cards, on
  `surface-container-high`, with their action as a text button.

## 6. Status vocabulary

| State | Glyph | List | Detail panel | Count badge |
|---|---|---|---|---|
| Healthy (Running, Available, Bound, deployed, Ready) | circle, `success` | glyph + word in `text` | plain line | plain number |
| Attention (Pending, Progressing, degraded, pending-upgrade) | triangle | `warning-container` pill | `warning-container` hero | pill with triangle |
| Failure (CrashLoopBackOff, Failed, Error, unreachable, NotReady) | square | `error-container` badge, `radius-sm` | `error-container` hero, `headline` | badge with square |
| Finished (Completed, Succeeded) | ring | glyph + word in `text-subtle` | plain line | plain number |
| Unknown (no data, forbidden, not served) | dashed ring | word in `text-subtle`, value en dash | says why | en dash |

Glyphs are 9 px inline SVG filled with `currentColor`, so they survive Windows forced-colours mode
(CSS backgrounds do not). One `StatusBadge` component replaces `StatusPill` and every bare dot.

## 7. Components

| Component | Rule |
|---|---|
| Button | Pill. Primary (`primary`, 48 px, one per panel or dialog), tonal (`primary-container`), text, destructive text (`error`), destructive solid (`error-solid`, confirm dialogs only). Pending keeps width and swaps the icon for a spinner. Icon-only buttons are discs with an accessible name. |
| Chip | Pill on `surface-container-high`. Status filter chips take their state's container when pressed; scope chips (cluster, namespace) open a menu. Zero-count status chips are hidden. |
| StatusBadge | §6. |
| NavRow | Pill, `--nav-h`. Current: `primary-container`. Sections in `text` with a chevron; types indent 40 px. Unavailable types stay in place in `text-subtle` with an en dash. |
| List row | `--row-h`, `radius-md`, 2 px apart, no separators. Hover `surface-container-high`; selected `primary-container`. Name in `data`, numbers right-aligned. A number needing attention is bold, not coloured. |
| Field (input, search, native select trigger) | `--control-h`, `radius-full` for search and selects, `radius-md` inside forms; `outline-strong` border in forms, filled `surface-container-high` in toolbars. Native select popups stay native. |
| Switch | 44 × 26 pill; on = `primary`. |
| SegmentedControl | One pill group; selected segment `primary-container`; disabled segment `text-subtle`. |
| Meter | 8 px pill track on the next surface up, fill `primary`. From 60 % a triangle and from 75 % a square precede the percentage, which turns bold; the fill takes `warning` / `error`. Null shows an empty track and an en dash. |
| Tile (StatCard) | `radius-lg` on `surface-container-top` (panel) or `surface-container-high` (dashboard); label in `label`, value in `stat`. A warnings tile above zero takes `warning-container`. |
| Menu (dropdown, context) | `surface-overlay`, `radius-lg`, `shadow-overlay`; items `radius-md`, 36 px; highlighted `surface-container-high`, checked item shows a check icon. |
| Modal | `surface-overlay`, `radius-xl`, title in `headline`, primary action bottom right; backdrop black 50 %. Widths as today (420, 480, 520, 720). |
| Toast | `surface-overlay` pill with the state's glyph and word; bottom right. |
| Kbd | `radius-xs`, `micro`, on the next surface up. |
| Focus | Solid 2 px `primary` ring, 2 px offset, on every interactive element. |

## 8. Screens

### 8.1 Lists (13 fixed kinds, generic kinds, custom resources)

One shared list card replaces the per-view table markup:

- Header: title in `display` with its count; pin and group toggles as icon discs; filter field.
  Lists with a status column (Pods, Deployments, StatefulSets, PVCs, Helm, Nodes, Events) get status
  chips, worst first.
- Column header in `label`, sticky inside the card's scroller (it is not sticky today). Sort arrows
  as today.
- Rows per §7. Grouping by namespace keeps today's logic; the group header is a `label` row of
  compact height with its count and a worst-state glyph.
- Too many columns for the width: the card scrolls horizontally; the name column stays visible.
- Secrets: the revealed key/value block is a `surface-sunken`, `radius-md` block under its row; the
  "decoded locally" note is a `warning-container` pill in the header.
- Events: the Warning type is a `warning-container` pill; the row itself is not tinted.

### 8.2 List states

| State | Shown as |
|---|---|
| Loading | Six placeholder rows in `surface-container-high` (pulse; static under reduced motion). Never the empty message. |
| Empty | `headline` "No pods in payments" + one `body-sm` line; no illustration. |
| Filtered to nothing | "No pods match "abc"" + Clear filter (text button). |
| Error | `error-container` block: what failed, the server's message in `data`, Retry. |
| Forbidden (RBAC) | "You are not allowed to list pods in payments." with the dashed ring. |
| Not available on this cluster | Existing copy, dashed ring. |
| Partial data (no metrics) | En dash in the cell; one `body-sm` line under the header says metrics are unavailable. |

The missing loading and error handling on fixed lists is bug #606; the shared list card is where it
is fixed.

### 8.3 Detail panel (Pod, Deployment, Node, generic object)

- Header: kind in `label`, name in `data` (wraps), close disc.
- Status: a hero in the state's container with the state in `headline` and the reason in `body-sm`
  for attention and failure; a plain status line for healthy and finished.
- Two tiles with the numbers that explain the state (Pod: restarts, memory; Deployment: ready,
  updated; Node: pods, CPU).
- Facts as label / value rows; then the kind's sections (containers, label chips, conditions, child
  pods, metrics charts, YAML).
- Footer pinned to the bottom: one primary (Pod: Open logs), tonal actions, destructive as text.
- Generic objects: a Summary block lists every column the server returned, above the YAML, so
  nothing is lost when the list is narrowed.
- Columns kept when docked: name, status, up to three more; namespace is one of them when listing
  all namespaces ungrouped. The exact set per list is decided in the phase plan.
- Focus: opening moves focus to the panel heading; Esc or the close button returns it to the row.
  The panel is non-modal in both modes (the list stays operable) and keeps `role="dialog"` with its
  name, so the existing e2e locators hold.
- Overlay mode (content < 1000 px): the same panel on `surface-overlay` with `shadow-overlay`,
  pinned to the right of the content column.
- Kinds without a panel today (StatefulSets, Jobs, CronJobs, Services, Ingresses, ConfigMaps,
  Secrets, PVCs, Helm, Events) stay without one.

### 8.4 Dashboards

- **All Clusters**: tiles (clusters online, pods, warnings, watched); a grid of cluster cards, each
  **tinted with its own hue** (§4.1), with avatar, server, health badge, facts and meters. An
  unreachable cluster's card shows the failure badge and "Last seen …". Zero contexts (no state
  today): `headline` "No clusters yet", how kubeconfig files are found, a button to Preferences.
- **Overview**: four tiles, capacity card with meters and history chart, recent warnings, alerts
  card, resource summary cards (neutral, no per-resource tint; "forbidden" uses the dashed ring).
- **Charts**: series in `data-1` … `data-5`; past five, series repeat dashed. Request and limit
  lines dashed in `text-subtle`; axes in `outline`. Hand-rolled SVG stays.
- **Unreachable**: failure hero with server and reason, Retry (primary), All Clusters (text).
- **Connecting**: `surface-overlay` card with spinner, cluster name and Cancel; the tint switches to
  the target cluster as soon as connecting starts.

### 8.5 Logs

- Logs view, docked log panel and pop-out window share one look: toolbar of chips and pill fields on
  the card, lines in `log` on `surface-sunken`.
- Level is a word in its own column (INFO `text-muted`, WARN `warning`, ERROR `error`); WARN and
  ERROR rows get a faint wash of their container token. The 2 px coloured left edge is removed.
- Following: `success-container` chip with the circle. Paused: `warning-container` chip with a pause
  icon, plus the existing "new lines buffered" pill.
- Sources (containers in a merged stream) use `data-1` … `data-5`; search matches are marked with
  `warning-container`.
- JSON and ECS views: keys `text-muted`, strings `text`, numbers `data-2`, booleans and null
  `data-3`.
- Pop-out window: its root carries the tint of the cluster the pod belongs to.
- Pod shell and YAML modals: `radius-xl` modal with a `surface-sunken`, `radius-md` code area.

### 8.6 Overlays and settings

- Command palette: 580 px, `radius-xl`, 48 px input, rows `radius-md`; cluster rows carry their own
  tint and health glyph.
- Preferences: Appearance is Theme, Density, Cluster colours (five swatches per context). Forms use
  the Field rules; integration forms keep their structure.
- Onboarding: three steps as today; progress is "Step 2 of 3" plus dots.
- Delete confirmation: names the pod, namespace and cluster; confirm is `error-solid`.

## 9. Scenario matrix

### 9.1 Environment

| Scenario | Rule |
|---|---|
| Dark / light | Both designed; tokens in §4.2; tests in §4.6 |
| Five tints | Same lightness and chroma, different hue; tests cover all five |
| Default / compact density | §4.4 variables; every component reads them |
| Window 800 × 600 (minimum) | Panel overlays; list scrolls horizontally in its card; sidebar rules unchanged |
| Window 1280 × 800 (e2e) | Panel overlays (content 964 px); sidebar must not scroll |
| Window ≥ 1316 wide | Panel docks |
| macOS | 36 px drag strip for the window controls; rail and sidebar start below it |
| Windows / Linux | Native title bar; no strip |
| Reduced motion | No transitions, no pulse |
| More contrast (`prefers-contrast: more`) | Cards gain an `outline-strong` border; `text-subtle` becomes `text-muted` |
| Forced colours (Windows) | SVG glyphs and system colours; no information lives in a background |

### 9.2 Data and connection

| Scenario | Rule |
|---|---|
| No contexts | Dashboard empty state (§8.4) |
| Many contexts | Rail scrolls its avatars |
| Connecting / unreachable / cancelled | §8.4; tint follows the target |
| Cluster switch | Selection and panel close (as today); tint cross-fades |
| Loading, empty, filtered-empty, error, forbidden, not served, no metrics | §8.2 |
| Long names | Truncate with ellipsis and `title`; wrap in the panel |
| Many columns (generic kinds) | Horizontal scroll in the card; Summary block in the panel |
| Grouped by namespace, sorted, filtered | Unchanged logic, restyled |
| Integrations absent | Hints restyled as tiles with a dashed `outline-strong` border |

### 9.3 State and interaction

| Scenario | Rule |
|---|---|
| Row selected, panel docked or overlaid | §8.3 |
| Panel open + log panel open + modal on top | Esc order unchanged: palette, modal, preferences, onboarding, panel |
| Pending scale, restart, delete (Terminating), port-forward, apply | Spinner in place of the icon, same width; a pending scale value is bold with a triangle |
| Disabled | `text-subtle`, 45 % opacity, no pointer |
| Logs following, paused, buffered, reconnecting, history, wrap, timestamps | §8.5 |
| Keyboard | Focus ring everywhere; panel focus rules in §8.3 |
| Colour as the only signal today | Rail health dot, palette cluster dot, log tab and pop-out stream dots, container ready dots, section alert dot, restarts and failed-jobs numbers, pending scale, meter thresholds, tile values, namespace group dot, filter counts, onboarding dots: each gains a glyph, a word or a weight per §6–§7 |

## 10. Tests

- New: contrast over themes × tints (§4.6); identity colour migration; tint applied on cluster
  switch and on scoped subtrees; panel docked vs overlay by content width; list states; status badge
  shapes per state.
- To update (they pin classes, inline styles or pixels): `PodTable.test.ts`, `meter-bar.test.ts`,
  `shell.test.ts`, `custom-resources.test.ts` (exact class string), `logs-view.test.ts`,
  `views.test.ts` (drawer host, warning row), `log-body.test.ts`, `json-tree.test.ts`,
  `log-tabstrip.test.ts`, `shell-modal.test.ts`, `namespace-grouping.test.ts`,
  `appearance.test.ts`, `overlays.test.ts` (accent), `cluster-identity.test.ts`,
  `identityColor.test.ts`, `host-metrics.test.ts`. Where a test asserts a class name, it moves to a
  role, a `data-*` attribute or an accessible name.
- e2e: no screenshot tests exist and none are added. `profiles.spec.ts` and
  `custom-resources.spec.ts` (sidebar does not scroll at 1280 × 800) are the contract for the new
  nav row height; one new spec checks the docked panel at 1440 × 900.

## 11. Delivery

One release, nine phases, each with its own issue and PR:

1. **Foundations** — token schema and generator, contrast tests, fonts, tint from the active
   cluster, identity migration, Accent removed, old names aliased (§4.5).
2. **Shell** — layout, top bar, rail, sidebar, status bar removed, banners, drag regions, window size.
3. **Primitives** — the components of §7.
4. **Lists** — shared list card, states (closes #606), all list views.
5. **Detail panel** — docked / overlay, focus, the four panels, column sets.
6. **Dashboards** — All Clusters, Overview, charts and meters, unreachable, connecting.
7. **Logs** — Logs view, log panel, pop-out, shell and YAML modals.
8. **Overlays and settings** — palette, Preferences, onboarding, dialogs.
9. **Clean-up and release** — aliases and Geist removed, lint rules, `design/README.md`, the
   handoff folder marked historical, accessibility pass.

Branching (my call): phases merge into an integration branch `feat/604-tonal`, and one final PR
brings it to `main` as the release. `main` stays releasable for fixes meanwhile and is merged into
the integration branch at the start of each phase. CI runs on every push to `feat/**`, so each phase
branch is checked even though its PR does not target `main`. The alternative, merging each phase
straight to `main`, would put a half-restyled app in any release cut before phase 9.

## 12. Calls made in this spec, for review

1. Identity palette restricted to cool hues, with amber → indigo and pink → magenta (§3 #4).
2. Status bar removed (§3 #5).
3. Default window 1360 × 860 (§3 #8).
4. Status chips replace the two filter toggles (§3 #7).
5. Integration branch and a single release (§11).
6. The docked panel keeps `role="dialog"` although it is not modal (§8.3).
7. Section dots and per-resource tints removed (§3 #6).
8. Noticed and left alone: the log toolbar's container and overflow menus do not close on outside
   click; `PodTable.svelte` has a stale column comment. Neither is touched here.

## 13. Left to the phase plans

- The exact columns each list keeps when the panel is docked.
- Which `type-caption` uses become `body-sm` and which `label`.
- Whether the shadcn HSL bridge is still read by anything.
- How Tailwind exposes the density variables as height utilities.
