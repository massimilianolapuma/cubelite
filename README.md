# CubeLite

> Lightweight Kubernetes dashboard — local-first, privacy-respecting, cross-platform.

## Overview

CubeLite gives developers and platform engineers a fast, native-quality view of their Kubernetes clusters without sending data to any cloud service.

| Layer | Technology |
|---|---|
| Rust core | `cubelite-core` — kubeconfig parsing, kube-rs client, resource models, watch streams |
| Desktop | Tauri v2 + Svelte 5 + shadcn-svelte + Tailwind CSS v4 |
| macOS native | Swift 6, SwiftUI, macOS 14+, local HTTP/IPC bridge to Rust core |
| AI layer | Ollama (local) + cloud via Vercel AI SDK — post-MVP, feature-flagged |
| Design | Figma → design tokens → Tailwind v4 config |
| Build | Cargo workspace (`resolver = "2"`) + pnpm workspaces |
| CI | GitHub Actions — Vitest, Playwright, Swift Testing, kind/k3d |

## Monorepo Layout

```
cubelite/
├── Cargo.toml          # Cargo workspace root (crates added in subsequent PRs)
├── package.json        # pnpm workspace root
├── pnpm-workspace.yaml
├── crates/             # Rust crates (scaffolded in subsequent PRs)
├── apps/               # Desktop + macOS apps (scaffolded in subsequent PRs)
├── packages/           # Shared JS/TS packages
├── design/             # Design tokens + Figma exports
└── docs/               # Documentation
```

## Privacy & Security

- No telemetry, no analytics, no call-home
- No user accounts required
- Kubernetes secrets masked in the UI by default
- OS keychain used for credential storage
- Content Security Policy enforced in all web views

## Development

**Prerequisites:** Rust 1.82+, Node.js ≥ 22, pnpm ≥ 9, Xcode 16+ (macOS app), Docker (integration tests)

```sh
# Rust core (available once crates/cubelite-core is scaffolded)
cargo build
cargo test

# Desktop app (available once apps/desktop is scaffolded)
pnpm install
pnpm dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (coming soon). All PRs must pass CI and include tests.

## License

Apache 2.0 — see [LICENSE](LICENSE).
