# Contributing to CubeLite

Thank you for your interest in contributing to CubeLite!

## Getting Started

1. Fork and clone the repo
2. Install prerequisites:
   - **Rust** 1.82+ via [rustup](https://rustup.rs/)
   - **Node.js** 22+ and **pnpm** 10+ (for `apps/desktop/`)
   - **Xcode** 16+ (for `apps/macos/`)
3. Run initial checks:
   ```bash
   cargo test --workspace
   cargo clippy --deny warnings
   ```

## Branch Naming

All branches must follow this pattern:

| Prefix | Use |
|---|---|
| `feat/<N>-<slug>` | New feature (N = issue number) |
| `fix/<N>-<slug>` | Bug fix |
| `chore/<N>-<slug>` | Maintenance / tooling |
| `hotfix/<N>-<slug>` | Urgent production fix |

Examples: `feat/42-context-switcher`, `fix/57-crash-on-empty-kubeconfig`

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

[optional body]

[optional footer(s)]
```

**Types:** `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `ci`, `style`

**Scopes:** `core`, `desktop`, `macos`, `ci`, `repo`

Examples:
- `feat(core): add namespace filtering to context list`
- `fix(macos): resolve menu bar icon rendering on Retina`
- `chore(ci): pin actions/checkout to SHA`

## Pull Requests

1. **Never commit directly to `main`** — all changes via PR
2. Open a PR with `Closes #N` in the body
3. Fill in the PR template checklist
4. Wait for CI checks to pass and at least one approval
5. **Squash merge only** — no merge commits, no rebase-merge

## Code Standards

### Rust (`crates/`)
- No `unwrap()` or `expect()` in production code — use `?` and `thiserror`
- No `unsafe` without a `// SAFETY:` justification
- All public APIs require `/// doc comments`
- Run `cargo clippy --deny warnings` and `cargo fmt --check`

### TypeScript / Svelte (`apps/desktop/`)
- Svelte 5 runes (`$state`, `$derived`, `$effect`) — no legacy stores
- Components in `PascalCase.svelte`
- Run `pnpm --filter desktop test`

### Swift (`apps/macos/`)
- Swift 6 strict concurrency (`@Sendable`, `actor`, `@MainActor`)
- `@Observable` — not `ObservableObject`
- No `try!` or force-unwrap (`!`) in production code
- Run tests via Xcode or `xcodebuild test`

## Security

- **No plaintext secrets** anywhere in code or config
- Credentials must use the OS keychain
- Report vulnerabilities via GitHub Security Advisories (do not open a public issue)
