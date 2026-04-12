# Contributing to CubeLite

Thank you for contributing! Please follow these guidelines to keep the project consistent and maintainable.

---

## Getting started

1. Fork the repository and clone your fork.
2. Install prerequisites:
   - [Rust 1.82+](https://rustup.rs/)
   - [Node.js 20+](https://nodejs.org/) & [pnpm 9.15+](https://pnpm.io/)
   - [Xcode 15+](https://developer.apple.com/xcode/) (macOS app only)
   - [Tauri prerequisites](https://tauri.app/start/prerequisites/)

---

## Branch naming

All work must be done on a feature branch — **never commit directly to `main`**.

| Type | Pattern | Example |
|---|---|---|
| Feature | `feat/<issue>-<slug>` | `feat/5-tauri-scaffold` |
| Bug fix | `fix/<issue>-<slug>` | `fix/42-kubeconfig-parse` |
| Hotfix | `hotfix/<issue>-<slug>` | `hotfix/99-crash-on-launch` |
| Chore | `chore/<issue>-<slug>` | `chore/8-branch-protection` |
| CI/DevOps | `ci/<issue>-<slug>` | `ci/8-add-codeowners` |

---

## Workflow

1. Pick up (or create) a GitHub Issue.
2. Create a branch from `main`.
3. Implement your changes.
4. Run local quality gates:
   ```sh
   cargo clippy --deny warnings
   cargo test --workspace
   pnpm --filter desktop lint
   pnpm --filter desktop test
   ```
5. Push the branch and open a Pull Request.
6. Fill in the PR template — link the issue with `Closes #<number>`.
7. Wait for CI to pass and at least one approving review.
8. A maintainer will squash-merge the PR.

---

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>
```

Examples: `feat(core): add kubeconfig parser`, `fix(desktop): handle empty context list`

Allowed types: `feat`, `fix`, `chore`, `ci`, `docs`, `test`, `refactor`, `style`, `perf`.

---

## Code standards

### Rust (`crates/`)
- No `unwrap()` or `expect()` in production code — use `?`, `thiserror`, or `anyhow::Context`.
- No `unsafe` blocks without an explicit justification comment.
- All public APIs must have `/// doc comments`.
- Run `cargo fmt` before pushing.

### TypeScript / Svelte (`apps/desktop/`)
- Components: `PascalCase.svelte`; stores/composables: `camelCase`.
- No `any` type without a comment explaining why.
- Tailwind v4 CSS-only — no `tailwind.config.ts`.

### Swift (`apps/macos/`)
- Types/protocols: `PascalCase`; properties/methods: `camelCase`.
- Use Swift 6 concurrency (`async/await`, `@MainActor`).

---

## Security

- **No plaintext secrets** in code or config.
- Credentials via OS keychain only (Keychain on macOS, SecretService on Linux).
- No telemetry without explicit user opt-in.
- CI secrets via `${{ secrets.* }}` only.

---

## Questions?

Open a [Discussion](https://github.com/massimilianolapuma/cubelite/discussions) or ping on the issue.
