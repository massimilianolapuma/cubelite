# CubeLite

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/massimilianolapuma/cubelite?label=release)](https://github.com/massimilianolapuma/cubelite/releases/latest)

**[Website](https://massimilianolapuma.github.io/cubelite/) · [Download](https://massimilianolapuma.github.io/cubelite/#download) · [User Guide](docs/guide/README.md)**

> Discover, switch, and manage Kubernetes contexts from a unified interface — fast, local-first, and privacy-respecting.

<!-- screenshot coming soon -->

## What is CubeLite?

CubeLite is a Kubernetes context aggregator for developers and platform engineers. It gives you a native-quality view of your clusters without sending data to any external service.

Unlike Lens (Electron-based, cloud account required) or k9s (terminal-only), CubeLite is:

- **Cross-platform** — a lightweight desktop app (Tauri) for macOS, Windows, and Linux
- **Local-first** — reads your existing `~/.kube/config`; no setup, no cloud account
- **Privacy-respecting** — no telemetry, no analytics, no call-home

## Features

- **Kubeconfig merge** — resolves `KUBECONFIG` env paths, merges multiple files, first file's `current-context` wins
- **Kubeconfig auto-discovery** — scans `~/.kube/` directory for config files automatically
- **Context switch** — switch active context and persist the change to disk
- **Lens-like GUI** — sidebar listing all contexts, detail pane for cluster resources
- **All Clusters dashboard** — cross-cluster health aggregation showing online/offline/RBAC-limited status per cluster
- **Kubernetes resources** — Pods, Namespaces, Deployments, Services, Secrets, ConfigMaps, Ingresses, Helm Releases
- **Deployment detail** — spec grid with replica counts, rollout strategy, and conditions timeline
- **Namespace browser** — CPU/Memory/IP columns with pod count badges per namespace
- **Secure credential storage** — OS keychain integration for bearer tokens and client certificate auth
- **TLS flexibility** — skip certificate verification for self-signed clusters (minikube, dev environments)
- **RBAC resilience** — graceful 403 Forbidden handling with per-resource tolerance; partial data shown where permitted
- **First launch onboarding** — guided setup shown when no kubeconfig is found
- **Preferences panel** — auto-refresh interval, dark/light/system theme, TLS skip verification, custom kubeconfig paths
- **Application logs** — in-app log viewer with severity filtering

## Architecture

CubeLite is a monorepo with two layers:

```
cubelite/
├── crates/
│   └── cubelite-core/      ← Rust library: kubeconfig parsing, kube-rs client, resource types
├── apps/
│   └── desktop/            ← Cross-platform: Tauri v2 + Svelte 5 + TypeScript
├── design/                 ← Design tokens (JSON → Tailwind CSS v4)
└── docs/                   ← Architecture docs
```

| Layer | Language | Key Libraries |
|---|---|---|
| `crates/cubelite-core` | Rust 1.82+ | kube-rs 0.97, tokio, thiserror, anyhow |
| `apps/desktop` | TypeScript + Svelte 5 | Tauri v2, bits-ui, Tailwind v4, Vitest |

The Rust core is used by the Tauri desktop backend via Cargo dependency.

See [docs/architecture.md](docs/architecture.md) for a full diagram.

## Getting Started

### Prerequisites

| Tool | Version |
|---|---|
| Rust | 1.82+ |
| Node.js | 22.17+ |
| pnpm | 9+ |

### Build the Rust core

```sh
cargo build --workspace
cargo test --workspace
```

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
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming conventions, commit format, and code standards. All changes go through a feature branch → PR → squash-merge flow; no direct commits to `main`.

## License

Apache 2.0 — see [LICENSE](LICENSE).
