# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
