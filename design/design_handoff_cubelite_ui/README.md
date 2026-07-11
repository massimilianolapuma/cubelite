# Handoff: CubeLite Unified UI (Design System v1 + Main App)

## Overview
Redesign of the CubeLite desktop app around a **single unified visual identity for macOS / Windows / Linux** (Linear/Lens-style, not platform-native). Core concepts:

1. **Cluster Rail** — persistent vertical rail of cluster avatars (1-click switch, health badge, stable per-cluster identity color).
2. **Command Palette (⌘K / Ctrl+K)** — keyboard-first switch/search/actions.
3. **Cluster identity color** — every kubeconfig context gets a stable color used everywhere that cluster appears (rail, titlebar, palette, dashboard), so the user always knows which cluster they are acting on before destructive operations.

This replaces the previous direction of following Apple HIG on macOS: the app chrome is now identical on all platforms (only native window controls differ). `docs/cubelite-macos-design-instructions.md` remains valid for accessibility/contrast rules but no longer drives the visual style.

## About the Design Files
The files in this bundle are **design references created in HTML** — interactive prototypes showing intended look and behavior, **not production code**. The task is to recreate these designs in the existing CubeLite environments:

- `apps/desktop` — Tauri v2 + Svelte 5 + Tailwind v4 + shadcn-svelte (primary target; the design maps 1:1 onto semantic tokens in `design/tokens.json`)
- `apps/macos` — Swift 6 + SwiftUI (same layout and colors; use custom-styled SwiftUI views, not system list/sidebar styles)

A proposed replacement for `design/tokens.json` is included as **`tokens-v2.json`** (dark theme complete; light theme TODO).

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii and interaction states are final. Recreate pixel-perfectly with existing project patterns. All px values assume 1x scale.

## Design Tokens (dark)

### Surfaces
| Token | Hex | Use |
|---|---|---|
| bg/window | `#0b0b0d` | window background |
| bg/sunken | `#0d0d10` | log viewer, code |
| bg/panel | `#101013` | sidebar, table bodies |
| bg/surface | `#131316` | cards, table header, titlebar |
| bg/raised | `#1a1a1f` | controls, hover fills |
| bg/overlay | `#161619` | modals, palette, toasts |
| border | `#26262b` | default border/dividers |
| border/strong | `#34343b` | overlay borders |
| border/faint | `#1e1e23` | row separators, inner panel borders |
| row hover | `#16161a` | table row hover |

### Text
| Token | Hex | Use |
|---|---|---|
| text/primary | `#f4f4f5` | titles, resource names |
| text/secondary | `#9c9ca6` | body, cells |
| text/tertiary | `#71717a` | column headers, meta |
| text/disabled | `#5c5c66` | placeholders, kbd |
| text/data-bright | `#e4e4e7` | mono names in tables |
| text/log | `#c8c8d0` | log message text |

### Accent + status
| Token | Hex | Use |
|---|---|---|
| accent | `#6e9bf5` | selection, focus, primary buttons (user-tweakable; alternates `#a78bfa`, `#2dd4bf`) |
| ok | `#34d399` | Running / Available / Succeeded / deployed / healthy |
| warn | `#fbbf24` | Pending / Progressing / pending-upgrade / degraded |
| err | `#f87171` | CrashLoop / failed / unreachable / destructive text |
| err/solid | `#dc4646` | destructive confirm button fill |
| info (logs) | `#7dd3fc` | INFO log level |

Alpha tints (hex + alpha): selection bg = accent 10%; active nav/rail bg = accent 14–20%; status pill bg = status 10%; log error row = err 7%; log warn row = warn 4.5%; focus ring = accent 15% (3px).

### Cluster identity palette (assigned at discovery, user-overridable)
`#60a5fa` (blue), `#f59e0b` (amber), `#f472b6` (pink), `#a78bfa` (violet), `#2dd4bf` (teal). Identity ≠ health: health is always a separate dot/badge.

### Typography
Families: **Geist** (UI) + **Geist Mono** (all data: resource names, metrics, IPs, logs, namespaces). Fallbacks: system-ui / ui-monospace.

| Style | Spec | Use |
|---|---|---|
| display/28 | Geist 600 28px | onboarding hero only |
| title/16 | Geist 600 16px | view titles |
| title/13 | Geist 600 12.5–13px | modal titles, cluster name in titlebar |
| body/12.5 | Geist 500 12.5px | nav items, buttons, palette rows |
| caption/11 | Geist 400 11–11.5px | descriptions, meta |
| section/9.5 | Geist 600 9.5px, uppercase, letter-spacing .07em | sidebar/palette section headers |
| colhead/10.5 | Geist 600 10.5px, uppercase, color text/tertiary | table column headers |
| data/12 | Geist Mono 500 12px | resource names in tables |
| data/11 | Geist Mono 400 11–11.5px | cells, metrics |
| log/11 | Geist Mono 400 11px | log messages (10.5px time/pod, 10px level) |

### Spacing / radius / elevation
- Spacing: 4px base scale (4/8/12/16/20/24/32).
- Radius: 4 (chips, kbd) · 6 (controls, buttons, inputs) · 8 (tables, log panel) · 10 (cards, rail avatars, panels) · 12 (modals, palette) · 999 (pills).
- Elevation: overlays only — bg `#161619`, border `#34343b`, shadow `0 24px 80px rgba(0,0,0,.7)`. Drawers: `-16px 0 40px rgba(0,0,0,.45)`. Toasts: `0 10px 34px rgba(0,0,0,.5)`.
- Row density: 9px vertical padding default, 5px "compact" preference. Controls height 28px, min hit target 28×28.

## Screens / Views

### App shell
- **Titlebar (42px, bg/surface, bottom border)**: window controls · active-cluster identity dot (8px) + name (title/13) + provider chip (Mono 500 10px, identity color on identity-12% bg, radius 4) + connection state (dot + "Connected"/"Unreachable") · spacer · search button (240px, bg/window, border, radius 6, placeholder "Search & switch…", kbd chip `⌘K`) · namespace dropdown (raised bg, label `namespace: <mono>` + ▾; menu = overlay panel with per-ns pod counts, active row accent-14%).
- **Cluster Rail (58px, bg/window, right border `#1e1e23`)**: top "⌂ All Clusters" button (38×38, radius 10) · divider · one 38×38 avatar per context (initials Geist 600 12px). Active: bg identity-20%, ring `0 0 0 2px identity`, white text. Inactive: bg/raised, text/secondary. Health badge: 10px dot bottom-right, 2px window-colored border. Bottom: ⚙ Preferences.
- **Sidebar (198px, bg/panel)**: sections Cluster (Overview) / Workloads (Pods, Deployments, Helm Releases) / Network (Services, Ingresses) / Config (ConfigMaps, Secrets) / Observe (Events, Logs). Item: 6px dot (group color: workloads `#60a5fa`, network `#a78bfa`, config `#fbbf24`, observe `#2dd4bf`), label body/12.5, right-aligned mono count. Active: accent-14% bg + text/primary. Warning counts in err color.
- **Status bar (27px)**: mono 10.5px — server + k8s version, refresh interval; right: warnings count (warn color, clickable → Events).

### All Clusters dashboard (rail ⌂)
Sidebar hidden. Title + "N contexts · N pods". 4 stat cards (label uppercase 10.5 + value Mono 600 22px): clusters online, total pods, warnings, contexts watched. Grid `repeat(auto-fill, minmax(330px, 1fr))` of cluster cards: avatar 30px + name + server (mono 10.5) + health pill; NODES/PODS/VERSION/WARNINGS mini-stats; CPU+MEM bars (5px, track `#1e1e23`, fill accent, warn >60%, err >75%). Offline card: "Last seen … connection timed out." Card click → switch to that cluster.

### Cluster views
- **Overview**: 4 stat cards (nodes, pods running, deployments, warnings) + Capacity card (CPU/MEM bars) + Recent warnings list (link "All events →").
- **Pods**: table NAME / STATUS / READY / AGE / CPU / MEMORY / RESTARTS (grid 2.4/.9/.7/.55/.6/.7/.5 fr). Names Mono 500 12px `#e4e4e7` — **never blue links** (row is the target). Status = dot + text in status color. Restarts > 3 in err. Row click → Pod detail drawer. Filter input top-right. Selected row bg accent-10%.
- **Deployments**: NAME / READY / STATUS / AGE / REPLICAS·ACTIONS. Replica stepper (− count + segments, value in warn while apply pending ~800ms) and Restart button per row (stopPropagation). Row click → Deployment drawer.
- **Services / Ingresses / ConfigMaps**: plain tables per kubectl column conventions; empty state = centered 12px text/disabled message.
- **Secrets**: NAME / TYPE / DATA / AGE / Reveal. Value masked as `••••` (text/disabled), Reveal/Hide button per row; header pill (warn tint): "values decoded locally — never leave this machine".
- **Helm Releases**: NAME / NAMESPACE / REV / STATUS / CHART / UPDATED, status pill (deployed→ok, pending-upgrade→warn, failed→err).
- **Events**: TYPE (pill: Warning = warn 10% bg; Normal = raised bg) / REASON (mono) / OBJECT / MESSAGE / AGE. Warning rows bg warn-4%.
- **Logs**: aggregated multi-pod stream. Header: severity chips ALL/INFO/WARN/ERROR (active = filled with level color, dark text), text filter, Follow toggle (following = ok fill "● Following"; paused = warn tint "⏸ Paused" + centered pulsing "paused — new lines buffered" pill), Clear. Rows in bg/sunken panel: time (mono 10.5 disabled) · LEVEL (mono 600 10px, 38px column, level color) · pod (mono 10.5 secondary) · message. Error rows: 2px err left edge + err-7% bg; warn rows: warn edge 50% + warn-4.5% bg. Auto-scroll to bottom while following. Buffer cap ~180 lines.
- **Cluster unreachable** (full-content state): ⚠ icon tile (err tint), "Cluster unreachable", server + reason, buttons Retry (primary) / All Clusters (secondary).

### Drawers (Pod / Deployment detail)
360–380px, overlay right (absolute, **do not squeeze content**), bg/panel, left border, shadow, slide-in 160ms. Pod: name (mono, word-break), status, 2-col meta grid (NAMESPACE/NODE/AGE/RESTARTS/POD IP/QOS), CPU/MEM bars, containers list, label chips; footer actions **Logs** (primary) / **Restart** (secondary, inline spinner in the row while running) / **Delete** (destructive outline). Deployment: replicas/age/image/selector grid, strategy, conditions cards (type + True/False in condition color + reason), child pods (click → pod detail), footer Logs / Rollout Restart.

### Command Palette (⌘K)
Fixed overlay: black 45% backdrop; panel 580px, radius 12, overlay elevation, top ~110px. Input row (13.5px, esc chip) · sections "Switch cluster" (identity dot, name, provider chip, health, `⌘1–5` kbd) and "Actions" (icon + label: dashboard, go-to views, tail logs, preferences). Selected row accent-14%; ↑↓ navigate, ↵ select, esc close. `⌘1–5`/`Ctrl+1–5` switch clusters globally.

### Onboarding (first launch, 3 steps, skippable)
Dimmed backdrop (88%), 480px card: (1) Welcome + detected `~/.kube/config` row with "5 contexts found" in ok; (2) cluster list with identity avatars + shortcuts; (3) keyboard cheatsheet (⌘K, ⌘1–5, esc). Step dots (accent = current), Skip / Continue / "Start using CubeLite". Re-triggerable from Preferences.

### Preferences (modal, 520px)
Appearance segmented Light/Dark/System · Auto-refresh segmented 10s/30s/1m/off · Skip TLS toggle (38×22, ok fill when on) · Kubeconfig paths list (mono rows with context count/merged note) · "Show first-launch onboarding again" link. Opened from rail ⚙; per HIG also bind Cmd-, on macOS.

## Interactions & Behavior
- **Cluster switch** (rail click / palette / ⌘1–5): show "Connecting to <name>…" overlay (spinner, ~650ms in prototype; real: until API responds), reset namespace to all, clear selections. Switching to an unreachable cluster shows the offline state.
- **Feedback, three levels**: inline spinner on the affected element (restart, scale) → toast bottom-right (3.2s, dot colored by outcome: ok/err/warn) for non-blocking results → modal dialog only for destructive confirms. Delete Pod dialog: repeats pod name + namespace in mono; Cancel (secondary) / Delete Pod (err/solid fill).
- **Hover**: rows `#16161a`; buttons brightness/border shifts; rail brightness 1.25. **Focus**: accent border + 3px accent-15% ring.
- **Esc** closes topmost overlay (palette, drawers, modals, dropdown).
- Animations: fadein 100ms, popin 140ms (translateY 6px + scale .98), drawer slide-in 160ms, toast 180ms. Keep ≤200ms, ease.

## State Management (per prototype logic)
- Global: activeClusterId, view, namespace filter, connecting flag.
- Per-view: pod filter text, selected pod/deployment, log follow/level/text filters + line buffer, revealed secrets set, pending scale/restart operations, toast queue.
- Settings: theme, refresh interval, TLS skip, kubeconfig paths, onboarding-seen.

## Assets
No image assets. Fonts: Geist + Geist Mono (Google Fonts / vendored; both open licensed — vendor them for offline-first). Icons in the prototype are unicode placeholders (⌂ ⚙ ⌕ ✕ ▾) — **replace with a real icon set** in implementation (Lucide is already the shadcn-svelte default and fits; on SwiftUI use SF Symbols with matching weight).

## Files in this bundle
- `CubeLite Prototype.dc.html` — interactive prototype, the primary reference (open in a browser; requires network for fonts/runtime).
- `Design System.dc.html` — token + component reference sheet.
- `Explorations.dc.html` — earlier explored directions (1a/1b/1c, 2a chosen) — historical context only.
- `tokens-v2.json` — proposed replacement for `design/tokens.json` (dark complete; light TODO; keep the repo's generator workflow `pnpm design:tokens`).

## Notes for the implementer
- The unified identity supersedes "monospace-first for everything" from the old tokens: **sans for UI, mono strictly for data**.
- Keep the repo rule from HIG doc §4.8.1: resource names are never styled as links; the row is the interactive target.
- Shortcuts: ⌘ on macOS ↔ Ctrl on Windows/Linux, same map.
- Light theme is intentionally out of scope for v1 (Preferences shows the segmented control; only Dark is final).
