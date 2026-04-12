## Description

<!-- What does this PR do? Link the relevant issue. -->

Closes #

## Changes

- 

## Checklist

### General
- [ ] Branch follows naming convention: `feat/<N>-<slug>`, `fix/<N>-<slug>`, or `chore/<N>-<slug>`
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] No secrets, tokens, or credentials in code or config
- [ ] PR targets `main` and is set to **squash merge**

### Rust (`crates/`)
- [ ] `cargo fmt --check` passes
- [ ] `cargo clippy --deny warnings` passes
- [ ] `cargo test --workspace` passes
- [ ] No `unwrap()` / `expect()` in production code
- [ ] Public APIs have `/// doc comments`

### Desktop (`apps/desktop/`)
- [ ] `pnpm --filter desktop test` passes
- [ ] No TypeScript `any` types without justification
- [ ] Svelte components use runes (`$state`, `$derived`, `$effect`)

### macOS (`apps/macos/`)
- [ ] `xcodebuild test` passes
- [ ] No force-unwrap (`!`) or `try!` in production code
- [ ] Strict concurrency checking enabled
- [ ] `@Observable` used (not `ObservableObject`)

<!-- Delete sections that don't apply to your changes. -->
