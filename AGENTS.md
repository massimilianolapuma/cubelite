# AGENTS.md — CubeLite Root

This file defines the agent routing protocol for the CubeLite monorepo.
Each specialized agent owns a subtree. When requests touch multiple subtrees,
use the inter-agent protocol described below.

---

## Agent Roster

| Agent | Scope | Model | Primary Tools |
|---|---|---|---|
| `coordinator` | Any / cross-cutting | Claude Opus 4.6 | Issue triage, milestone planning, inter-agent routing |
| `core-agent` | `crates/**` | Claude Sonnet 4.6 | `cargo test`, `cargo clippy --deny warnings`, `cargo build` |
| `desktop-agent` | `apps/desktop/**` | Claude Sonnet 4.6 | `pnpm --filter desktop test`, Vitest, Playwright |
| `macos-agent` | `apps/macos/**` | Claude Sonnet 4.6 | `xcodebuild build`, `xcodebuild test`, Xcode |
| `design-agent` | `apps/desktop/**` (UI only) | Claude Sonnet 4.6 | Figma MCP, shadcn-svelte, Tailwind tokens |
| `devops-agent` | `.github/**` | Claude Sonnet 4.6 | GitHub Actions, secret scanning, YAML lint |
| `qa-agent` | Any / quality | Claude Sonnet 4.6 | Test coverage, CI validation, security review |
| `docs-agent` | `docs/`, README, CHANGELOG | Claude Sonnet 4.6 | `cargo doc`, documentation generation, Mermaid diagrams |
| `pages-agent` | `site/`, GitHub Pages | Claude Sonnet 4.6 | Static site build, GitHub Pages deployment, Lighthouse |
| `security-agent` | Any / security | Claude Sonnet 4.6 | `cargo audit`, `pnpm audit`, secret scanning, OWASP review |
| `reviewer` | Any / PR review | Claude Opus 4.6 | GitHub MCP PR read/write, diff analysis, Copilot triage |

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
│   ├── agents/                → devops-agent
│   └── instructions/          → devops-agent
├── docs/                      → docs-agent
├── site/                      → pages-agent
├── Cargo.toml                 → core-agent (workspace manifest)
├── package.json               → desktop-agent (workspace scripts)
├── Makefile                   → devops-agent
├── README.md                  → docs-agent
├── CHANGELOG.md               → docs-agent
└── AGENTS.md                  → coordinator (this file)
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
2. Create branch `feat/<N>-<slug>` or `fix/<N>-<slug>` following the **Branching Base Rule** below
3. Implement → run local checks (lint, test, coverage)
4. Push branch → open PR with `Closes #N` in body
5. Add `status:review` label while PR is open
6. **ALL CI checks MUST pass** before merge (tests, lint, Sonar, build) — no exceptions
7. Squash-merge only → post closing comment → add `status:done` label → close issue

---

## Branching Base Rule

- **Default**: create feature branches from `main`
- **Exception**: if shared configuration changes (`.github/agents/`, `.github/copilot-instructions.md`,
  `AGENTS.md`, `.github/instructions/`) exist on an open PR branch **not yet merged to `main`**,
  new feature branches **MUST** branch from that PR branch to inherit the latest config
- Before creating a branch, **always check** for unmerged shared config:
  ```bash
  git log --oneline main..<config-pr-branch> -- .github/ AGENTS.md
  ```
- Once the config PR is merged to `main`, resume branching from `main`
- **Never overwrite** `.github/agents/*.agent.md` files — if your branch is missing
  them, rebase onto the config branch instead of recreating them

---

## Quality Gates (All Agents)

| Gate | Command |
|---|---|
| Rust lint | `cargo clippy --deny warnings` |
| Rust tests | `cargo test --workspace` |
| Rust format | `cargo fmt --check` |
| Desktop lint | `pnpm --filter desktop lint` |
| Desktop tests | `pnpm --filter desktop test` |
| macOS build | `xcodebuild build -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite` |
| macOS tests | `xcodebuild test -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite` |
| Secret scan | `gh secret-scanning run` |
| Rust docs | `cargo doc --workspace --no-deps` |
| Dependency audit (Rust) | `cargo audit` |
| Dependency audit (npm) | `pnpm audit` |
