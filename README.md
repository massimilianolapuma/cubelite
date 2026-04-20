# CubeLite

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

> Discover, switch, and manage Kubernetes contexts from a unified interface — fast, local-first, and privacy-respecting.

<!-- screenshot coming soon -->

## What is CubeLite?

CubeLite is a Kubernetes context aggregator for developers and platform engineers. It gives you a native-quality view of your clusters without sending data to any external service.

Unlike Lens (Electron-based, cloud account required) or k9s (terminal-only), CubeLite is:

- **Native** — a real macOS app built with SwiftUI, plus a cross-platform desktop app via Tauri
- **Local-first** — reads your existing `~/.kube/config`; no setup, no cloud account
- **Privacy-respecting** — no telemetry, no analytics, no call-home

## Features

- **Kubeconfig merge** — resolves `KUBECONFIG` env paths, merges multiple files, first file's `current-context` wins
- **Kubeconfig auto-discovery** — scans `~/.kube/` directory for config files automatically
- **Context switch** — switch active context and persist the change to disk
- **Menu bar quick-switch** — click the status-bar icon to switch context without opening the main window
- **Lens-like GUI** — `NavigationSplitView` sidebar listing all contexts, detail pane for cluster resources
- **All Clusters dashboard** — cross-cluster health aggregation showing online/offline/RBAC-limited status per cluster
- **Kubernetes resources** — Pods, Namespaces, Deployments, Services, Secrets, ConfigMaps, Ingresses, Helm Releases
- **Deployment detail** — spec grid with replica counts, rollout strategy, and conditions timeline
- **Namespace browser** — CPU/Memory/IP columns with pod count badges per namespace
- **Secure credential storage** — Security.framework keychain integration for bearer tokens and client certificate auth
- **TLS flexibility** — skip certificate verification for self-signed clusters (minikube, dev environments)
- **RBAC resilience** — graceful 403 Forbidden handling with per-resource tolerance; partial data shown where permitted
- **First launch onboarding** — guided setup shown when no kubeconfig is found
- **Preferences panel** — auto-refresh interval, dark/light/system theme, TLS skip verification, custom kubeconfig paths
- **Application logs** — in-app log viewer with severity filtering

## Architecture

CubeLite is a monorepo with three independent layers that share no runtime dependency on each other:

```
cubelite/
├── crates/
│   └── cubelite-core/      ← Rust library: kubeconfig parsing, kube-rs client, resource types
├── apps/
│   ├── desktop/            ← Cross-platform: Tauri v2 + Svelte 5 + TypeScript
│   └── macos/              ← Native macOS: Swift 6 + SwiftUI (menu-bar + main window)
├── design/                 ← Design tokens (JSON → Tailwind CSS v4)
└── docs/                   ← Architecture docs
```

| Layer | Language | Key Libraries |
|---|---|---|
| `crates/cubelite-core` | Rust 1.82+ | kube-rs 0.97, tokio, thiserror, anyhow |
| `apps/desktop` | TypeScript + Svelte 5 | Tauri v2, shadcn-svelte, Tailwind v4, Vitest |
| `apps/macos` | Swift 6 | SwiftUI, macOS 14+, Observation framework, Yams |

The macOS app communicates with the Kubernetes API server directly via `URLSession` — no FFI bridge to the Rust core. The Rust core is used by the Tauri desktop backend via Cargo dependency.

See [docs/architecture.md](docs/architecture.md) for a full diagram.

## Getting Started

### Prerequisites

| Tool | Version |
|---|---|
| Rust | 1.82+ |
| Xcode | 16+ (macOS app) |
| Node.js | 20+ |
| pnpm | 9+ |

### Build the Rust core

```sh
cargo build --workspace
cargo test --workspace
```

### Build the macOS app

```sh
xcodebuild build \
  -project apps/macos/cubelite/cubelite.xcodeproj \
  -scheme cubelite \
  -destination 'platform=macOS'
```

Or open `apps/macos/cubelite/cubelite.xcodeproj` in Xcode and press ⌘R.

### Build the desktop app

```sh
pnpm install
pnpm --filter desktop dev
```

## Development

Common commands are available via `make`. Run `make help` to list all targets.

```sh
# Lint and test everything
cargo clippy --deny warnings
cargo test --workspace
pnpm --filter desktop test

# Format Rust code
cargo fmt

# Check macOS build
xcodebuild build -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming conventions, commit format, and code standards. All changes go through a feature branch → PR → squash-merge flow; no direct commits to `main`.

## License

Apache 2.0 — see [LICENSE](LICENSE).
