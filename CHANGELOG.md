# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-10-02

### Added

- **macOS Overview parity** (#359): the native Overview counts through
  `OverviewSummary`, which mirrors the desktop `overview-summary.ts` and is
  tested against the same fixture. It now matches the desktop. Cards use
  design-token surfaces with sidebar-section tints, metric values are mono
  `data` and coloured only when non-zero, and denied kinds show a "forbidden"
  badge. The capacity and recent-warnings cards sit side by side, and the
  warnings card gains an "All events →" link to the Events view. The meters
  share the desktop thresholds (accent, warn from 60%, err from 75%). The
  extra "Cluster" card is gone, since the header shows connection state.

- **Desktop Overview parity** (#359, part 1): the Overview gains the resource
  grid of the macOS app. It has eight cards (Pods, Deployments, Services,
  Namespaces, Secrets, ConfigMaps, Ingresses, Helm Releases), and a card shows
  a "forbidden" badge when RBAC denies its kind. The stat row reads
  `running/total` pods and `healthy/total` deployments, with tinted icons, and
  the capacity meters add absolute `used / allocatable` sub-labels. Counts come
  from a pure `overview-summary.ts`, and the macOS app will mirror it. The
  Overview now loads its extra kinds in one batch, also on auto-refresh. Meter
  thresholds are unified at warn from 60% and err from 75%.

- **macOS Events view** (#358, part 1): a new Events item in the sidebar's
  Observe section lists every event (Normal and Warning), most recent first,
  in the desktop's grid: Type pill, Reason with `×count`, Object, Message and
  Age. Warning rows get a faint warn tint, and an RBAC denial reads as such
  instead of an empty list.
- **macOS header, status bar and commands** (#358): the header matches the
  desktop titlebar — identity dot, name, provider chip (AKS, EKS, GKE, K3S,
  KIND, LOCAL, K8S) and connection state, a "Search & switch…" button that
  opens the ⌘K palette, and a namespace dropdown with per-namespace pod counts.
  The status bar shows the API server, the Kubernetes version and the refresh
  interval, plus warning (opens Events) and error (opens Diagnostics) counts.
  Refresh moves to ⌘R in the View menu and the palette ("Refresh cluster
  data"); the "Logs & Errors" sheet is now "Diagnostics…" (⇧⌘D) in the
  Window menu.

- **Multiple kubeconfig files** (desktop, #392): the app follows `KUBECONFIG`
  like kubectl. It reads every listed file, first file wins on name clashes,
  and missing files are skipped. Before, contexts from extra files showed up
  in the rail, but connecting to them failed because commands only read
  `~/.kube/config`. The list is imported from the login shell when the app
  is launched from the Dock or Finder, and it is split with the platform
  separator (`;` on Windows). Preferences list each file with its context
  count and note merged or missing files. The rail tooltip names the file
  that defines a context.

- **Design lint** (#360): `scripts/design-lint.sh` runs in CI (job "Design
  Lint", with its own self-test). It blocks `text-[Npx]` classes and raw hex
  colours in desktop Svelte components (held at 0), and system fonts and colours
  in native views (capped per file by `scripts/design-lint-allow.txt`; the
  residue is tracked in #395). Audit report: `docs/design-audit-2026-09.md`.
- **Handoff v1.1 amendments** (#360): the handoff README and `tokens-v2.json`
  now record the contrast-fixed tokens (`text/tertiary` `#7d7d86`, `err/solid`
  `#d72929`), the v1.1 type scale and the parity decisions. The contrast audit
  confirms every v1.1 type size meets AA and non-text contrast reaches 3:1, and records a light-theme accent gap (#396).
- **All Clusters dashboard** (desktop, #362): stat cards now show clusters
  online, total pods, warnings and contexts watched aggregated across every
  context; each online cluster card shows its pods, warnings and CPU/MEM
  bars (or "metrics unavailable"). The background health probe now also
  returns pod, issue-pod and capacity totals per cluster.

### Changed

- **ESLint 10 + eslint-plugin-svelte 3** (#414): the desktop lint stack moves
  to ESLint 10, with `@eslint/js` as a direct dev dependency, and
  eslint-plugin-svelte 3. The config now uses the v3 `recommended` preset and
  parses `.svelte.ts`/`.svelte.js` runes modules with the TypeScript parser
  and the Svelte config. The stores satisfy the new
  `svelte/prefer-svelte-reactivity` rule: copy-on-write sets and maps are
  built without in-place mutation, the log-search match set is a `SvelteSet`,
  and the unused `podCountByNamespace` getter is removed. Dependabot no longer
  proposes TypeScript major updates until typescript-eslint supports
  TypeScript 7.

- **Vite 8** — the desktop builds with Vite 8 (Rolldown), the version
  vite-plugin-svelte 7 requires, which clears its unmet-peer warning.
  SvelteKit 2.70 and Vitest 5 already support it. Node.js 20.19+ or 22.12+
  is now required (root `engines` and README updated), and the Vitest config
  uses `import.meta.dirname` instead of `__dirname`.

- **Vitest config** — dropped the obsolete `hot` option of
  vite-plugin-svelte (an svelte-hmr option, gone since Svelte 5 builds HMR
  into the compiler), which made every test run print "invalid plugin option
  `hot`". Behaviour is unchanged.

- **macOS design tokens, batch 5** (#395): Overview and the cross-cluster
  dashboard use cluster-identity tints per resource (the same ones as the type
  tags) and status tokens for health metrics, with `stat`, `subtitle` and
  `dataSm` text. The design-lint allow-list is now empty, so the macOS app,
  like the desktop, is held at zero system fonts and raw colors.
- **macOS design tokens, batch 4** (#395): onboarding, Preferences, the error
  banner, the menu-bar extra, the toolbar, aggregated logs and exec drop their
  last system fonts and colors (`title`, `subtitle`, `body`, `caption`,
  `micro`, `dataSm`; `statusOk`/`statusWarn`/`statusErr`). Only Overview and
  the cross-cluster dashboard remain: 71 matches in 2 files, down from 104 in 11.
- **macOS design tokens, batch 3** (#395): the deployment and resource detail
  views, Logs and the sidebar use the drawer mapping from the desktop (`title`,
  `section`, `caption`, `dataSm`, mono `micro` for log timestamps) and status
  tokens for replica, reachability and severity colors. The `icon` tokens gain
  `lg`/`xl`/`2xl` (14/28/40px). The allow-list shrinks from 164 matches in 15
  files to 104 in 11.
- **macOS design tokens, batch 2** (#395): the 12 list views (`*ListView.swift`)
  use `Typography.data` for the Name column and `dataSm` for every other cell,
  as the desktop tables do, and status and type-tag colors come from the
  status and cluster-identity tokens. The design-lint allow-list shrinks from
  222 matches in 27 files to 164 in 15.
- **macOS design tokens, batch 1** (#395): the log panel (`LogPanel/*`) and
  shell (`Shell/*`) views drop their last 16 system fonts for
  `DesignTokens.Typography` (`log`, and `micro` in mono for timestamps, source
  and level chips, as on the desktop). A new `icon` token group (`2xs`/`xs`/
  `sm`/`md`: 7/8/10/11px) sizes SF Symbol glyphs and badge digits through
  `View.iconSize(_:)`, which also makes them follow Dynamic Type. The
  design-lint allow-list shrinks from 238 matches in 33 files to 222 in 27.
- **kube 4.2 / k8s-openapi 0.28** (#399): the workspace moves from kube 0.97 and
  k8s-openapi 0.23 to kube 4.2 and k8s-openapi 0.28, on Kubernetes API level
  `v1_32` (the oldest that 0.28 supports). k8s-openapi now uses `jiff` instead
  of `chrono`, so timestamps sent to the UI read `…Z` instead of `…+00:00`
  (same instant; the UI parses both). TLS verification now goes through
  `rustls-platform-verifier`, which uses the OS trust store. `client.rs` gains
  tests against a mock API server: list scoping, delete, scale and restart
  patches, version and node count, events, and error mapping.
- **Core dependencies** (#366): `cubelite-core` and the desktop app now take
  `kube`, `k8s-openapi` and `dirs` from `[workspace.dependencies]`. The whole
  workspace targets one Kubernetes API level (`k8s-openapi` `v1_31`, was
  `v1_30` in core), and `dirs` 5 is gone from the lockfile. `error.rs` and
  `resources.rs` gain unit tests. The kube 4.x upgrade is tracked in #399.

- **Desktop design parity, part 1** (#363):
  - pod and deployment drawers stay pinned to the right edge while the view
    scrolls;
  - the pod drawer shows label chips;
  - a pod row shows an inline spinner while the pod is being terminated;
  - Succeeded pods are green (ok);
  - compact controls (replica stepper, Restart, Reveal, Stop) are 28px and
    the "logs" chip has a 28×28 hit area;
  - the sidebar shows one count per item, red with a tooltip when pods or
    events need attention, including on-demand kinds once loaded;
  - the namespace menu shows per-namespace pod counts.
- **Desktop design parity, part 2** (#363):
  - the deployment replica stepper batches clicks for 800 ms before scaling
    and shows ready/target replica segments;
  - Preferences add row density (default/compact), accent color
    (blue/violet/teal) and a per-cluster identity color override.

- **Tauri 2.12** (desktop): `tauri` 2.12.0 with `@tauri-apps/api` and
  `@tauri-apps/plugin-updater` 2.12, kept in lockstep; plus the Rust
  minor/patch updates from Dependabot (tokio 1.53, serde, thiserror, …).
  Tauri packages are now excluded from Dependabot and updated manually.

- **Type scale v1.1** (both apps): body 13px, caption 11.5px, section 10px,
  column headers 11px, data 12.5px; new `stat` and `micro` styles. The scale is
  generated from `design/tokens.json` into Tailwind `type-*` utilities and
  `DesignTokens.Typography` for SwiftUI; no size falls below the 10pt HIG floor.
- **macOS**: Geist and Geist Mono (OFL 1.1) are bundled and used by every
  `scaledFont` call and the new `typeStyle` modifier — same families as the
  desktop app.

### Fixed

- **Desktop log pop-out follow-ups** (#351):
  - ⌘F / Ctrl+F focuses log search in a popped-out log window;
  - re-attaching or detaching an all-containers session resumes each
    container from its own last line, so a slower container no longer loses
    lines;
  - a re-attach that races a cluster switch is dropped with a toast instead of
    opening a tab against the new cluster.
- **Light-theme accent contrast** (#396): the violet and teal alternate accents
  in the light theme now pass WCAG AA as text and as primary-button fills
  (violet `#7c5ce8` → `#7756e7`, teal `#0f9e8e` → `#0c7e72`; only lightness
  changes). The contrast suite now audits every accent token.
- **Desktop cluster identity colors** (#391): the pink identity color (and
  any color not referenced literally) no longer renders transparent; dynamic
  colors now use the always-emitted `--cl-color-cluster-*` variables.
- **Desktop design cleanup** (#364): log toolbar popovers use the overlay
  elevation tokens instead of Tailwind `shadow-lg`; Unicode glyphs (✕ ⏎ ↺ ✓)
  replaced with Lucide icons; the Timestamps/Wrap toggles expose their state
  as `menuitemcheckbox`.

- **Desktop**: Esc closes the topmost overlay first — the Delete Pod and YAML
  dialogs now close before the drawer underneath them, and Esc cancels an
  in-flight cluster switch (#361). Table rows, log level chips and the Follow
  toggle show the accent focus ring.

### Security

- Bumped vulnerable transitive dependencies: js-yaml 4.3.2, nanoid 3.3.19,
  devalue 5.9.4, @humanfs/node, postcss-selector-parser 6.1.4, tsx 4.23 /
  esbuild 0.28 (npm); rustls 0.23.45 and plist 1.10 / quick-xml 0.42 (Rust).
  `pnpm audit` and `cargo audit` now run in CI (#365).

## [0.4.2] - 2026-08-19

### Added

- **Pop out log session to a separate OS window** (#298, both apps): the `⧉`
  button in the log panel toolbar detaches the active session into its own
  window with full toolbar parity (container picker, search, follow/pause,
  tail, previous, export); closing the window — or `⏷` — returns the tab to
  the panel with history and stream intact. One window per session, unlimited
  windows; on desktop the handoff is gapless (the stream resumes from the
  last transferred line)

## [0.4.1] - 2026-08-09

### Fixed

- Pod drawer "Logs" button now opens the pod log panel instead of the empty
  aggregated Logs view (#346)

## [0.4.0] - 2026-08-09

### Added

- **Pod log viewer** on both apps (#294 macOS, #295 desktop): persistent bottom
  panel with session tabs, live follow with reconnect/backoff, search with
  n/N navigation and filter mode, previous-instance logs, tail control,
  export to Downloads (visible or full buffer)
- **Merged "all containers" stream** (#297, both apps): one interleaved,
  identity-color-tagged stream of every container in the pod, per-container
  reconnect, `<pod>_all.log` export
- **Desktop auto-update** (#250): signed update channel (minisign), silent
  startup check, in-app update banner and Preferences section, `latest.json`
  manifest published with every release
- **Accessibility pass** (#120, macOS): WCAG AA contrast across both themes
  (permanent audit in CI), VoiceOver labels/traits/state on every interactive
  element, full keyboard operability, Dynamic Type up to AX5 for primary text
- Desktop pod port-forward with kube-rs relay and auto-assigned local ports
  (#318); aggregated log viewer with label filtering on macOS (#316);
  Overview parity — capacity metrics, warnings, All Clusters cards (#315)

### Fixed

- ATS exception for user-supplied cluster API hosts (macOS, #329)
- Client-identity signing verification and stale keychain pairing cleanup (#313)
- TLS-skip propagation from Preferences to the API service at init (#311)
- Cancellable, fail-fast cluster switch on desktop (#312); window drag
  fallback (#317); log flood freeze (#316)

## [0.3.0] - 2026-07-12

### Added

- macOS native app: `KubeconfigService`, `KubeAPIService`, `KeychainService` actors
  - `KubeconfigService`: resolves `KUBECONFIG` env paths, merges multiple configs, sandbox-safe home directory resolution via `getpwuid`
  - `KubeAPIService`: typed access to Kubernetes REST API via `URLSession` (namespaces, pods, deployments); bearer token and custom CA trust
  - `KeychainService`: generic password items tagged by service + account; store, retrieve, delete, and update via Security framework
- macOS GUI: `NavigationSplitView` Lens-like layout with sidebar context list and detail pane
  - Toolbar with reload action and error indicator
  - Graceful no-config state with user-facing guidance
- macOS menu bar: `MenuBarExtra` quick context-switch with active context header, context rows, and "Show Details…" shortcut
- macOS models: `ClusterState` (`@Observable`) with contexts, currentContext, pods, namespaces, deployments, isLoading, noConfig, errorMessage
- macOS tests: XCTest suite for `KubeconfigService` (merge, current-context priority, path resolution) and `KeychainService` (store/retrieve/delete round-trip)
- Rust core (`cubelite-core`): kubeconfig parsing, multi-path merge, `list_contexts`, `set_active_context` with disk persistence
- Rust core: `KubeClient` — async kube-rs wrapper; `list_pods`, `list_namespaces`, `list_deployments`
- Rust core: `PodInfo`, `NamespaceInfo`, `DeploymentInfo` resource models with serde
- Rust core: `ConfigError` enum via `thiserror` (FileNotFound, ParseError, ContextNotFound, MergeError, ClientError, Io)
- Desktop: Tauri v2 + Svelte 5 scaffold with shadcn-svelte and Tailwind CSS v4
- Desktop: Tauri command bridges — `list_pods`, `list_namespaces`, `list_deployments`
- Design system: `design/tokens.json` and `design/export-tokens.ts` CSS codegen pipeline
- CI: GitHub Actions workflows for Rust (lint + test), Desktop (lint + test), and macOS (build + test)
- Agent roster: coordinator, core, desktop, macos, design, devops, qa, docs, pages, security
- Repository governance: `CONTRIBUTING.md`, `CODEOWNERS`, branch protection rules, PR template
- GitHub Pages: CubeLite landing page (#32)
- macOS M2: namespace browser, pod/deployment list views, and resource detail panel (#33)
- Agent: PR reviewer agent definition added to `.github/agents/` (#45)
- Config: Penpot MCP server integrated, replacing Figma (#46)
- Rust core + Desktop: Kubernetes watch stream with Tauri event bridge for live resource updates (#50)
- Desktop M4: functional Svelte UI with context sidebar, resource tables, and watch integration (#57)
- macOS: Namespace View enhanced with CPU/Memory/IP columns and pod count badges (#68)
- macOS: Deployment Detail view with spec grid and conditions table (#69)
- macOS: First Launch onboarding flow with kubeconfig guidance (#71)
- macOS: auto-discovery of kubeconfig files across `~/.kube/` directory (#90)
- macOS: RBAC-resilient resource loading with per-resource 403 tolerance (#91)
- Tests: comprehensive e2e and integration test suites across all stacks (#84)
- Tests: TLS temporal validity fallback tests for macOS (#83)

### Changed

- macOS + core: M3 QA pass — fixed test race conditions and stabilised CI (#51)
- Docs: added Bug Discovery Workflow and Pre-Commit Rule to `AGENTS.md` (#95)

### Fixed

- macOS: addressed review findings from initial macOS PR (#44)
- Docs: corrected documentation issues from PR #32 review (#43)
- macOS: show 'Cluster not reachable' with grey dot for unreachable clusters (#59)
- macOS: apply dark mode toggle from Preferences to app chrome (#79)
- macOS: add toolbar with title and close button to LogsView sheet (#80)
- macOS: make 'All Namespaces' visually distinct in the sidebar (#81)
- macOS: handle `errSecCertificateValidityPeriodTooLong` in TLS trust evaluation (#82)
- macOS: persist Skip TLS verification setting and invalidate session on toggle (#94)
- macOS: handle `secureConnectionFailed` error and add task-level TLS delegate (#96)
- macOS: replace invalid `cloud.slash` SF Symbol and fix sidebar collapse layout constraints (#98)

### Security

- CI: upgrade CodeQL Action from v3 to v4 to resolve deprecation (#92)

[Unreleased]: https://github.com/massimilianolapuma/cubelite/compare/main...HEAD
