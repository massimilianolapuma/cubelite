# AGENTS.md — CubeLite Root

This file defines the agent routing protocol for the CubeLite monorepo.
Each specialized agent owns a subtree. When requests touch multiple subtrees,
use the inter-agent protocol described below.

---

## Agent Roster

| Agent | Scope | Model | Primary Tools |
|---|---|---|---|
| `coordinator` | Any / cross-cutting | Claude Opus 4.7 | Issue triage, milestone planning, inter-agent routing |
| `core-agent` | `crates/**` | Claude Sonnet 4.6 | `cargo test`, `cargo clippy --deny warnings`, `cargo build` |
| `desktop-agent` | `apps/desktop/**` | Claude Sonnet 4.6 | `pnpm --filter desktop test`, Vitest, Playwright |
| `macos-agent` | `apps/macos/**` | Claude Sonnet 4.6 | `xcodebuild build`, `xcodebuild test`, Xcode |
| `design-agent` | `apps/desktop/**` (UI only) | Claude Sonnet 4.6 | Penpot MCP, shadcn-svelte, Tailwind tokens |
| `devops-agent` | `.github/**` | Claude Sonnet 4.6 | GitHub Actions, secret scanning, YAML lint |
| `qa-agent` | Any / quality | Claude Sonnet 4.6 | Test coverage, CI validation, security review |
| `docs-agent` | `docs/`, README, CHANGELOG | Claude Sonnet 4.6 | `cargo doc`, documentation generation, Mermaid diagrams |
| `pages-agent` | `site/`, GitHub Pages | Claude Sonnet 4.6 | Static site build, GitHub Pages deployment, Lighthouse |
| `security-agent` | Any / security | Claude Sonnet 4.6 | `cargo audit`, `pnpm audit`, secret scanning, OWASP review |
| `reviewer` | Any / PR review | Claude Opus 4.7 | GitHub MCP PR read/write, diff analysis, Copilot triage |

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

## Mandatory Pre-Work Checklist (All Agents)

Before starting ANY task, every agent **MUST**:

1. **Read its own path-scoped instructions** from `.github/instructions/` (e.g., `swift-macos.instructions.md` for macos-agent)
2. **Read `.github/copilot-instructions.md`** for project-wide conventions
3. **Read the relevant `AGENTS.md`** (root or subtree) for ownership and protocol rules

Skipping this step is a violation — instructions contain critical conventions that
change over time and must be respected on every task.

---

## Design-First Workflow (New UI Sections)

When a task involves **creating a new UI section, view, or panel** (not a minor tweak to an existing view):

1. **Design first** — delegate to `design-agent` to create the Penpot board(s) with layout, colors, typography, and component specs
2. **Review** — the coordinator presents the design to the user for approval
3. **Implement only after approval** — the implementing agent (macos-agent, desktop-agent) receives the approved design as reference

This applies to both `apps/desktop/` and `apps/macos/` UI work. Bug fixes, refactors,
and modifications to existing views that don't introduce new sections are exempt.

**Rationale**: code-first UI leads to rework; Penpot designs are cheap to iterate on.

---

## Prohibited Actions (All Agents)

- Do NOT commit directly to `main`
- Do NOT push `--force` to any protected branch
- Do NOT hardcode secrets, tokens, or API keys in any file
- Do NOT call `unwrap()` or `expect()` in production Rust code (outside `tests/`)
- Do NOT install telemetry or tracking without explicit user opt-in
- Do NOT modify another agent's owned files without coordination
- Do NOT implement new UI sections without an approved Penpot design (see Design-First Workflow)

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

## Bug Discovery Workflow (All Agents)

When an agent **discovers a bug or problem during work** (not a pre-existing issue), it
**MUST NOT** fix it on the current branch. Instead, follow this mandatory workflow:

1. **Stop** — do not apply the fix on the current feature/fix branch
2. **Create a GitHub issue** — use `gh issue create` with:
   - Clear title: `fix(<scope>): <description>`
   - Body with: Bug description, Root cause (if known), Acceptance criteria, Affected files
   - Appropriate labels (e.g., `bug`, `macos`, `desktop`, `core`)
3. **Create a dedicated branch** from `main` (or config branch per Branching Base Rule):
   ```bash
   git checkout -b fix/<N>-<slug> origin/main
   ```
4. **Delegate to the correct agent** based on the ownership map:
   - `crates/**` → `core-agent`
   - `apps/desktop/**` → `desktop-agent`
   - `apps/macos/**` → `macos-agent`
   - `.github/**` → `devops-agent`
5. **Implement the fix** — the owning agent:
   - Reads its path-scoped instructions (mandatory pre-work)
   - Implements the fix with tests
   - Runs local quality checks (lint, test, build)
6. **Commit + Push + PR**:
   - Commit with Conventional Commits: `fix(<scope>): <description>`
   - Push the branch: `git push -u origin fix/<N>-<slug>`
   - Open PR with `Closes #<N>` in body
7. **Return** to the original branch and resume previous work

**Rationale**: fixing bugs on unrelated branches creates tangled PRs, harder reviews,
and risk of regressions. Each fix gets its own issue, branch, and PR for clean tracking.

**Exception**: if the bug is a direct consequence of changes on the current branch
(e.g., a test you just wrote is failing), fix it in-place on the current branch.

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

## Pre-Commit Rule (All Agents)

Every agent **MUST** build and run tests locally **before every commit**. No exceptions.

1. **Build** the affected stack to verify compilation
2. **Run tests** for the affected stack to verify no regressions
3. **Only commit** after both build and tests succeed

Do NOT commit code that has not been built and tested. Pushing untested code
wastes CI cycles and blocks other agents. Use the Quality Gates table below
for the correct commands per stack.

---

## Quality Gates (All Agents)

| Gate | Command |
|---|---|
| Rust lint | `cargo clippy --deny warnings` |
| Rust tests | `cargo test --workspace` |
| Rust format | `cargo fmt --check` |
| Desktop lint | `pnpm --filter desktop lint` |
| Desktop tests | `pnpm --filter desktop test` |
| macOS build | `xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build` |
| macOS tests | `xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -skip-testing cubeliteUITests` |
| Secret scan | `gh secret-scanning run` |
| Rust docs | `cargo doc --workspace --no-deps` |
| Dependency audit (Rust) | `cargo audit` |
| Dependency audit (npm) | `pnpm audit` |
