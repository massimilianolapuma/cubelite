# Agent-Governed Development Playbook

> A comprehensive guide for bootstrapping agent-driven software projects.
> Distilled from the CubeLite monorepo — a Kubernetes context aggregator
> built entirely with a coordinated team of AI coding agents.

---

## Table of Contents

1. [Philosophy](#philosophy)
2. [Agent Team Architecture](#agent-team-architecture)
3. [Repository Bootstrap Checklist](#repository-bootstrap-checklist)
4. [Instruction Hierarchy](#instruction-hierarchy)
5. [Workflow Rules](#workflow-rules)
6. [Design-First Protocol](#design-first-protocol)
7. [Bug Discovery Workflow](#bug-discovery-workflow)
8. [Quality Gates](#quality-gates)
9. [Common Pitfalls and Lessons Learned](#common-pitfalls-and-lessons-learned)
10. [Template Files](#template-files)

---

## Philosophy

### Agents are team members, not tools

Treat each agent as a specialized developer with a defined scope, clear instructions,
and accountability. Agents must read their instructions before every task, follow
branching conventions, and never take shortcuts — even when the fix seems trivial.

### Instructions are the single source of truth

Agents have no persistent memory across sessions. Every convention, pattern, and
constraint must be written in instruction files that the agent reads at task start.
If a rule isn't written down, it doesn't exist for the agent.

### Small, scoped ownership prevents conflicts

Each agent owns a subtree of the codebase. Two agents never edit the same file.
Cross-cutting changes are coordinated through the coordinator agent, batched in
a single branch with ordered commits.

### Process over speed

Skipping the Bug Discovery Workflow to "save time" creates tangled PRs, harder
reviews, and regression risk. Every bug gets its own issue, branch, and PR — even
one-line fixes. The overhead is minutes; the clarity is permanent.

---

## Agent Team Architecture

### Core Roles

| Role | Scope | When to Activate |
|---|---|---|
| **Coordinator** | Cross-cutting, routing, planning | Always — entry point for all tasks |
| **Core Agent** | Backend/library code | Domain logic, data models, API clients |
| **Frontend Agent** | UI framework code | Components, views, state management |
| **Platform Agent(s)** | Platform-specific code | Native APIs, platform conventions |
| **Design Agent** | UI design only | New views/sections (before code) |
| **DevOps Agent** | CI/CD, workflows | GitHub Actions, deployment, secrets |
| **QA Agent** | Tests, quality | Coverage, security review, CI validation |
| **Docs Agent** | Documentation | README, CHANGELOG, architecture docs |
| **Security Agent** | Security review | Audits, dependency scanning, OWASP |
| **Reviewer Agent** | PR review | Diff analysis, convention enforcement |

### Scaling the Team

- **Small project (1 stack)**: Coordinator + 1 Implementation Agent + DevOps
- **Medium project (2 stacks)**: Add platform-specific agents + Design
- **Large monorepo (3+ stacks)**: Full roster with QA, Security, Docs, Reviewer

### Coordinator Responsibilities

1. **Route tasks** to the correct agent based on file ownership
2. **Enforce workflows** — never let an agent skip Bug Discovery or Design-First
3. **Plan milestones** and break them into scoped issues
4. **Resolve conflicts** when changes span multiple subtrees
5. **Never edit files directly** in an agent's owned subtree

---

## Repository Bootstrap Checklist

When starting a new project with agent governance, create these files **before
writing any application code**:

### Day 0 Files

```
project/
├── AGENTS.md                          ← Agent roster + ownership map + workflows
├── .github/
│   ├── copilot-instructions.md        ← Project-wide conventions
│   └── instructions/
│       ├── <stack-1>.instructions.md   ← Per-stack conventions
│       ├── <stack-2>.instructions.md
│       └── ci-devops.instructions.md
├── CONTRIBUTING.md                     ← Branch naming, commit format, PR process
├── CODEOWNERS                          ← Maps paths to agent labels
├── README.md                           ← Project overview
├── CHANGELOG.md                        ← Keep a Changelog format
└── docs/
    └── architecture.md                 ← Component diagram + tech stack
```

### What goes where

| File | Content | Read By |
|---|---|---|
| `AGENTS.md` | Agent roster, ownership map, inter-agent protocol, quality gates, prohibited actions | All agents, every task |
| `copilot-instructions.md` | Language matrix, naming conventions, absolute rules (no unwrap, no secrets), security policy | All agents, every task |
| `<stack>.instructions.md` | Stack-specific patterns, DI conventions, test patterns, "what to avoid" | Owning agent only |
| `CONTRIBUTING.md` | Human-readable guide: branch naming, commit format, PR checklist | Humans + agents |

---

## Instruction Hierarchy

Instructions are read in this order, with later files overriding earlier ones
for conflicts:

```
1. copilot-instructions.md    ← Global rules (security, naming, absolute rules)
2. AGENTS.md                  ← Workflow rules (branching, bug discovery, quality gates)
3. <stack>.instructions.md    ← Stack conventions (language patterns, DI, delegates)
```

### Writing Effective Instructions

**Do:**
- State rules as absolutes: "MUST use", "NEVER use", "Always"
- Include the _why_ — agents follow rules better when they understand the rationale
- Give concrete examples of correct and incorrect patterns
- Update instructions immediately when a new convention is established

**Don't:**
- Use vague language: "prefer", "consider", "might want to"
- Leave conventions implicit — if you had to debug it once, write it down
- Assume the agent remembers previous sessions — it doesn't

### Example: A Good Instruction

```markdown
## URLSession Delegates

- **MUST use completion-handler variants** for URLSessionDelegate methods — NOT async
- Async delegate methods are not reliably invoked by macOS URLSession
- This was the root cause of TLS failures in PR #96 — the delegate was never called

Bad:  func urlSession(_:didReceive:) async -> (URLSession.AuthChallengeDisposition, URLCredential?)
Good: func urlSession(_:didReceive:completionHandler:)
```

### Example: A Bad Instruction

```markdown
## Networking
- Consider using URLSession for API calls
- Try to handle errors appropriately
```

---

## Workflow Rules

### Branching

```
main
 ├── feat/<issue>-<slug>     ← New features
 ├── fix/<issue>-<slug>      ← Bug fixes
 ├── docs/<issue>-<slug>     ← Documentation
 ├── chore/<issue>-<slug>    ← Maintenance
 └── test/<issue>-<slug>     ← Test additions
```

- **Always branch from `main`** (exception: config PRs not yet merged)
- **Always reference an issue number** in the branch name
- **Squash-merge only** — keeps main history clean
- **Delete branch after merge**

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

type:  feat | fix | docs | test | chore | ci | refactor
scope: the affected area (macos, desktop, core, ci)
```

### PR Lifecycle

```
1. Create issue → assigned to agent
2. Create branch → implement → local build + test
3. Push → open PR with "Closes #N"
4. CI must pass (ALL checks — no exceptions)
5. Review → squash-merge → close issue
```

### The Pre-Commit Rule

Every agent MUST build and run tests **before every commit**. No exceptions.
Pushing untested code wastes CI cycles and blocks other agents.

```
Before committing, run:
1. Build the affected stack
2. Run tests for the affected stack
3. Only commit after both succeed
```

---

## Design-First Protocol

When a task introduces a **new UI section or view** (not a tweak to existing):

```
1. Coordinator receives task
2. Coordinator delegates to Design Agent → creates mockup/board
3. Coordinator presents design to user for review
4. User approves (or requests changes → back to step 2)
5. Only after approval → Coordinator delegates to Implementation Agent
```

**Why**: Code-first UI leads to rework. Designs are cheap to iterate on;
code changes are expensive. A 10-minute design review saves hours of refactoring.

**Exempt**: Bug fixes, refactors, modifications to existing views that don't
introduce new sections.

---

## Bug Discovery Workflow

When an agent discovers a bug **during work on another task**:

```
1. STOP — do NOT fix it on the current branch
2. Create a GitHub issue (gh issue create)
   - Title: fix(<scope>): <description>
   - Body: bug description, root cause, acceptance criteria, affected files
3. Create dedicated branch: fix/<N>-<slug> from main
4. Delegate to the owning agent (based on file ownership map)
5. Fix → build → test → commit → push → open PR with "Closes #N"
6. Return to original branch and resume previous work
```

**Exception**: Bugs directly caused by changes on the current branch may be
fixed in-place.

**Why this matters**: Fixing unrelated bugs on feature branches creates:
- Tangled PRs that are hard to review
- Risk of reverting the bug fix when the feature branch is reverted
- Unclear git history — which commit fixed which bug?
- Regression risk when cherry-picking

### Real Example (CubeLite)

During TLS fix work (PR #96), we discovered two pre-existing bugs:
1. Invalid SF Symbol `cloud.slash` (doesn't exist)
2. Sidebar constraint conflict on collapse

**Wrong approach** (what happened first):
- Fixed both on the TLS branch → committed → pushed
- User caught the violation → had to revert

**Correct approach** (what we did after):
- Reverted the commit from TLS branch
- Created issue #97
- Created branch `fix/97-sf-symbol-sidebar-constraints` from `main`
- Applied fix → tested → PR #98 → merged separately

---

## Quality Gates

Define quality gates per stack in `AGENTS.md`. Every agent must know
the exact commands to run before committing.

### Template Quality Gates Table

| Gate | Command | When |
|---|---|---|
| Lint | `<linter> --strict` | Before every commit |
| Unit tests | `<test-runner>` | Before every commit |
| Build | `<build-command>` | Before every commit |
| Format check | `<formatter> --check` | Before every commit |
| Security audit | `<audit-tool>` | Weekly or on dependency changes |
| Documentation | `<doc-tool>` | On public API changes |

### Example (CubeLite)

| Gate | Command |
|---|---|
| Rust lint | `cargo clippy --deny warnings` |
| Rust tests | `cargo test --workspace` |
| macOS build | `xcodebuild build-for-testing -project ... -scheme ... -destination 'platform=macOS'` |
| macOS tests | `xcodebuild test-without-building -project ... -scheme ...` |
| Desktop lint | `pnpm --filter desktop lint` |
| Desktop tests | `pnpm --filter desktop test` |

---

## Common Pitfalls and Lessons Learned

### 1. "It's just a quick fix" — No, follow the workflow

The most common violation is fixing pre-existing bugs on the wrong branch.
It feels faster but creates review complexity and tangled git history.
The Bug Discovery Workflow adds ~5 minutes of overhead but saves hours of
untangling.

### 2. Instructions must be explicit, not implicit

If you discover a macOS-specific behavior (e.g., "async URLSession delegates
don't work"), write it in the instructions immediately. The next agent session
won't remember the debugging session — only what's written in the instructions.

### 3. Session caching and parallel access

When building services that cache connections (HTTP sessions, database pools),
always design for parallel access from day one. A single cached entry works
for sequential access but breaks catastrophically with `TaskGroup` parallelism.

### 4. Keep documentation updated continuously

Documentation drifts fast with agent-driven development because features ship
quickly. Schedule periodic docs audits (every 10-15 PRs) or require docs
updates as part of the PR checklist.

### 5. Auth context matters

When using CLI tools (gh, git), verify which account/token is active.
Enterprise managed users vs personal accounts can cause silent failures.
Add `gh auth status` as a debug step in issue creation workflows.

### 6. Test before commit, always

Agents sometimes skip the build step when "only documentation changed."
This is wrong — formatting issues, broken links, and YAML syntax errors
are real build failures. Run the relevant quality gate for every commit.

### 7. Coordinator must enforce, not just route

The coordinator's job isn't just to forward tasks. It must:
- Check that the agent followed instructions
- Verify the workflow was respected (right branch, right base, right commit format)
- Catch violations before they reach the PR

---

## Template Files

### AGENTS.md Template

```markdown
# AGENTS.md — <Project Name>

## Agent Roster
| Agent | Scope | Primary Tools |
|---|---|---|
| coordinator | Cross-cutting | Issue triage, routing |
| <stack>-agent | <path>/** | <build>, <test>, <lint> |

## Ownership Map
<path>/ → <agent>

## Inter-Agent Protocol
1. Identify primary subtree
2. Activate primary agent
3. Never have two agents edit the same file

## Quality Gates
| Gate | Command |
|---|---|

## Bug Discovery Workflow
(Copy from this playbook)

## Branching Base Rule
- Default: branch from main
- Exception: unmerged config PRs

## Pre-Commit Rule
Build + test before every commit. No exceptions.
```

### copilot-instructions.md Template

```markdown
# GitHub Copilot Instructions — <Project Name>

## Project Overview
<1-2 sentences>

## Monorepo Layout
<tree structure>

## Language & Framework Matrix
| Area | Language | Key Libraries |
|---|---|---|

## Naming Conventions
### <Language 1>
### <Language 2>

## Test Patterns
### <Stack 1>
### <Stack 2>

## Absolute Rules
- Never <dangerous-pattern> in production code
- No plaintext secrets
- No direct commits to main
- Conventional Commits format
- Build and test before every commit

## Agent Routing Table
| Agent | Scope | Activate When |
|---|---|---|
```

### Per-Stack Instructions Template

```markdown
---
applyTo: "<path>/**"
---

# <Stack> Instructions

## Language Version
## Framework Conventions
## Dependency Injection Pattern
## Test Patterns
## What to Avoid
## <Stack-Specific Patterns>
(Add sections as conventions are discovered during development)
```

---

## Getting Started with a New Project

1. **Create the repo** with the Day 0 files from the bootstrap checklist
2. **Define your agent roster** based on the stacks you'll use
3. **Write initial instructions** — even minimal ones are better than none
4. **Start with a small feature** to validate the workflow
5. **Update instructions after every debugging session** — if you learned something, write it down
6. **Schedule docs audits** every 10-15 merged PRs
7. **Trust the process** — the overhead of proper workflow pays off at scale

---

*This playbook is a living document. Update it as new patterns emerge.*
