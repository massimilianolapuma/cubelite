# AGENTS.md — CubeLite Root

This file defines the agent routing protocol for the CubeLite monorepo.
Each specialized agent owns a subtree. When requests touch multiple subtrees,
use the inter-agent protocol described below.

---

## Agent Roster

| Agent | Scope | Primary Tools |
|---|---|---|
| `core-agent` | `crates/**` | `cargo test`, `cargo clippy --deny warnings`, `cargo build` |
| `desktop-agent` | `apps/desktop/**` | `pnpm --filter desktop test`, Vitest, Playwright |
| `macos-agent` | `apps/macos/**` | `swift build`, `swift test`, Xcode |
| `design-agent` | `apps/desktop/**` (UI only) | Figma MCP, shadcn-svelte, Tailwind tokens |
| `devops-agent` | `.github/**` | GitHub Actions, secret scanning, YAML lint |
| `ai-agent` | Any | Architecture, cross-cutting concerns, ADRs |

---

## Ownership Map

```
cubelite/
├── crates/                    → core-agent
│   └── cubelite-core/         → core-agent  (see crates/cubelite-core/AGENTS.md)
├── apps/
│   ├── desktop/               → desktop-agent, design-agent
│   │   └── AGENTS.md          → (see apps/desktop/AGENTS.md)
│   └── macos/                 → macos-agent
│       └── AGENTS.md          → (see apps/macos/AGENTS.md)
├── .github/
│   ├── workflows/             → devops-agent
│   └── instructions/          → devops-agent
├── Cargo.toml                 → core-agent (workspace manifest)
├── package.json               → desktop-agent (workspace scripts)
├── Makefile                   → devops-agent
└── AGENTS.md                  → ai-agent (this file)
```

---

## Inter-Agent Protocol

When a task spans multiple subtrees:

1. **Identify the primary subtree** (where most code changes land)
2. **Activate the primary agent** for that subtree
3. **Notify secondary agents** by posting a comment on the issue
4. **Never have two agents edit the same file simultaneously**
5. Cross-cutting changes (e.g., a Rust type + its TypeScript binding) should be
   batched in a single branch with coordinated commits

---

## Prohibited Actions (All Agents)

- Do NOT commit directly to `main`
- Do NOT push `--force` to any protected branch
- Do NOT hardcode secrets, tokens, or API keys in any file
- Do NOT call `unwrap()` or `expect()` in production Rust code (outside `tests/`)
- Do NOT install telemetry or tracking without explicit user opt-in
- Do NOT modify another agent's owned files without coordination

---

## Global Workflow

1. Pick up issue → add `status:in-progress` label + tracking comment
2. Create branch `feat/<N>-<slug>` or `fix/<N>-<slug>` from `main`
3. Implement → run local checks (lint, test, coverage)
4. Push branch → open PR with `Closes #N` in body
5. Add `status:review` label while PR is open
6. Squash-merge only → post closing comment → add `status:done` label → close issue

---

## Quality Gates (All Agents)

| Gate | Command |
|---|---|
| Rust lint | `cargo clippy --deny warnings` |
| Rust tests | `cargo test --workspace` |
| Rust format | `cargo fmt --check` |
| Desktop tests | `pnpm --filter desktop test` |
| macOS tests | `swift test` |
| Secret scan | `gh secret-scanning run` |
