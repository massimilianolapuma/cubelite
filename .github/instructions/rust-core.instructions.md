---
applyTo: "crates/**"
---

# Rust Core Instructions

Guidelines for all code under `crates/`.

## Style

- Follow Rust API Guidelines (https://rust-lang.github.io/api-guidelines/)
- `rustfmt` formatting — no manual formatting overrides
- `snake_case` for functions/variables, `PascalCase` for types, `SCREAMING_SNAKE_CASE` for constants
- Prefer `impl Trait` return types where object safety is not needed
- Keep `pub` surface minimal; use `pub(crate)` freely

## Error Handling

- Use `thiserror` for library error types; `anyhow` for application/binary error propagation
- Define errors via `#[derive(thiserror::Error)]` on explicit enums — one variant per distinct failure mode
- **Never `unwrap()` or `expect()` in production code** paths (`src/`, NOT `tests/`)
- Propagate errors with `?`; annotate context with `.context("...")` (anyhow) or `map_err`

## Async

- Runtime: `tokio` (multi-thread scheduler unless constrained)
- Annotate async entry points with `#[tokio::main]` or `#[tokio::test]`
- Prefer `tokio::spawn` for detached tasks; use structured concurrency where feasible
- Use `tokio::sync::{Mutex, RwLock}` — not `std::sync` in async contexts

## Kubernetes

- Client: `kube-rs` 0.97 with `kube::Client`, `kube::Api`
- Represent cluster context as a value type (not string); enforce type safety at boundaries
- Mock k8s API in tests: use `kube::fake::ObjectList` / custom `tower::Service` stacks
- Never hardcode cluster addresses or credentials

## Tests

- Unit tests live in `#[cfg(test)] mod tests { … }` at the bottom of the source file
- Integration tests in `crates/<crate>/tests/`
- Run: `cargo test --workspace`
- Lint: `cargo clippy --deny warnings`
- Format check: `cargo fmt --check`

## What to Avoid

- No `unsafe` without a `// SAFETY:` comment explaining why it is valid
- No `std::sync::Mutex` in async code — use `tokio::sync::Mutex`
- No `unwrap()` / `expect()` outside test modules
- No `println!` in library code — use `tracing` for diagnostics
