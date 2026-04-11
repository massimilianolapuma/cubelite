# GitHub Copilot Instructions — CubeLite

This file provides project-wide context and conventions for GitHub Copilot across
all stacks in the CubeLite monorepo.

---

## Project Overview

**CubeLite** is a Kubernetes context aggregator — a developer tool that lets you
discover, switch, and manage Kubernetes contexts across clusters from a unified
interface. It consists of a Rust core library, a cross-platform desktop app
(Tauri + Svelte), and a native macOS menu-bar app (Swift + SwiftUI).

---

## Monorepo Layout

```
cubelite/
├── crates/
│   └── cubelite-core/       ← Rust library: k8s context management
├── apps/
│   ├── desktop/             ← Tauri v2 + Svelte 5 + TypeScript desktop app
│   └── macos/               ← Swift 6 + SwiftUI native macOS app
├── .github/
│   ├── copilot-instructions.md
│   ├── instructions/        ← Path-scoped Copilot instructions
│   └── workflows/           ← GitHub Actions CI/CD
├── AGENTS.md                ← Root agent routing table
└── Makefile                 ← Dev task shortcuts
```

---

## Language & Framework Matrix

| Area | Language | Key Libraries |
|---|---|---|
| `crates/` | Rust 1.82+ | kube-rs 0.97, tokio, thiserror 2, anyhow 1 |
| `apps/desktop/` | TypeScript + Svelte 5 | Tauri v2, shadcn-svelte, Tailwind v4, Vitest, Playwright |
| `apps/macos/` | Swift 6 | SwiftUI, macOS 14+, Observation framework |
| `.github/` | YAML | GitHub Actions |

---

## Naming Conventions

### Rust
- Types and traits: `PascalCase`
- Functions and variables: `snake_case`
- Constants: `SCREAMING_SNAKE_CASE`
- Modules: `snake_case`
- Error types: suffix with `Error` (e.g., `ContextError`)

### TypeScript / Svelte
- Components: `PascalCase.svelte`
- Stores and composables: `camelCase`
- Types and interfaces: `PascalCase`
- Constants: `SCREAMING_SNAKE_CASE`

### Swift
- Types and protocols: `PascalCase`
- Properties and methods: `camelCase`
- Constants: `camelCase` (Swift convention)

---

## Test Patterns

### Rust (`crates/`)
- Unit tests in `#[cfg(test)]` modules within source files
- Integration tests in `crates/<name>/tests/`
- Mock Kubernetes API via `kube::fake` or custom `tower` stacks
- Run: `cargo test --workspace`

### Desktop (`apps/desktop/`)
- Unit/component tests: Vitest
- End-to-end: Playwright
- Run: `pnpm --filter desktop test`

### macOS (`apps/macos/`)
- XCTest for unit tests; SwiftUI previews for UI tests
- Run: `swift test` or Xcode scheme `CubeLiteTests`

---

## Absolute Rules

### Rust
- **Never use `unwrap()` or `expect()` in production code** (`crates/` top-level, not in `tests/`)
  - Use `?` operator, `thiserror`, or `anyhow::Context` instead
- **No `unsafe` blocks** without explicit justification comment and review
- All public APIs must have `/// doc comments`
- Run `cargo clippy --deny warnings` before every commit

### Security
- **No plaintext secrets** anywhere in code or config files
- Credentials must use the OS keychain (Keychain on macOS, SecretService on Linux)
- No telemetry collection without explicit user opt-in
- CI secrets via GitHub Actions `${{ secrets.* }}` only

### General
- No direct commits to `main` — all changes via feature branch → PR → squash-merge
- Commit messages follow Conventional Commits: `type(scope): description`

---

## Agent Routing Table

| Agent | Scope | Activate When |
|---|---|---|
| `core-agent` | `crates/**` | Rust logic, k8s API, domain models, error types |
| `desktop-agent` | `apps/desktop/**` | Svelte components, Tauri commands, frontend tests |
| `macos-agent` | `apps/macos/**` | Swift/SwiftUI, menu-bar, macOS APIs |
| `design-agent` | `apps/desktop/**` UI only | Design tokens, shadcn-svelte, Tailwind, accessibility |
| `devops-agent` | `.github/**` | GitHub Actions, CI/CD workflows, secret handling |
| `ai-agent` | Any | Cross-cutting AI assistance, architecture decisions |

See path-specific instructions in `.github/instructions/` for per-stack conventions.
