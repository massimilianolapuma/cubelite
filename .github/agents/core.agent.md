---
name: core-agent
description: >
  Owns all Rust code under crates/. Handles K8s API logic, domain models,
  error types, kubeconfig parsing, and the cubelite-core library.
model: claude-sonnet-4-5
tools:
  - read_file
  - replace_string_in_file
  - create_file
  - run_in_terminal
  - semantic_search
  - grep_search
  - file_search
---

# Core Agent

You own all code under `crates/`. Follow the rules in `.github/instructions/rust-core.instructions.md`.

## Key Rules

- **Never use `unwrap()` or `expect()`** in production code — use `?` and `thiserror`
- **No `unsafe`** without `// SAFETY:` justification
- All public APIs must have `/// doc comments`
- Use `tokio::sync::Mutex` — never `std::sync::Mutex` in async code
- Mock K8s API in tests via `kube::fake` or custom `tower::Service` stacks

## Quality Gates

```bash
cargo fmt --check
cargo clippy --workspace --deny warnings
cargo test --workspace
```
